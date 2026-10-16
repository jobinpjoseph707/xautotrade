/**
 * Owns the single broker connection and the set of running bots.
 * Everything the HTTP layer needs to know about live trading goes through here.
 */

import { EventEmitter } from 'node:events';

import { MetaApiBroker } from '../broker/metaapi.js';
import { Mt5McpBroker } from '../broker/mt5mcp.js';
import { PaperBroker } from '../broker/paper.js';
import type { Broker } from '../broker/types.js';
import { config, selectedBroker } from '../config.js';
import type { Strategy } from '../engine/types.js';
import { inbox as sharedInbox } from '../inbox/instance.js';
import type { Inbox } from '../inbox/inbox.js';
import { logs, settings, strategies } from '../store.js';
import { BotRunner, type BotSnapshot } from './runner.js';

export function buildBroker(): Broker {
  const kind = selectedBroker();
  if (kind === 'metaapi') {
    return new MetaApiBroker(config.metaApiToken, config.metaApiAccountId, config.metaApiRegion);
  }
  if (kind === 'mt5mcp') {
    return new Mt5McpBroker({
      transport: config.mt5McpTransport,
      command: config.mt5McpCommand,
      args: config.mt5McpArgs,
      url: config.mt5McpUrl,
      terminalPath: config.mt5McpTerminalPath || undefined,
      login: config.mt5McpLogin || undefined,
      password: config.mt5McpPassword || undefined,
      server: config.mt5McpServer || undefined,
      fillMode: config.mt5McpFillMode,
      deviationPoints: config.mt5McpDeviationPoints,
    });
  }
  return new PaperBroker(settings.get('paperBalance', 10_000));
}

/** If the server was down longer than this, bots are NOT resumed on their own. */
export const MAX_RESUME_GAP_MS = 30 * 60_000;

export interface ManagerOptions {
  broker?: Broker;
  clock?: () => number;
  inbox?: Inbox;
}

export class BotManager extends EventEmitter {
  readonly broker: Broker;
  private runners = new Map<string, BotRunner>();
  private floatingTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startGuard: (() => string | null) | null = null;
  private readonly clock: () => number;
  private readonly inbox: Inbox;

  constructor(opts: ManagerOptions = {}) {
    super();
    this.broker = opts.broker ?? buildBroker();
    this.clock = opts.clock ?? Date.now;
    this.inbox = opts.inbox ?? sharedInbox;
  }

  /** A check that can refuse a start (the daily-loss kill switch uses this). Returns the reason, or null to allow. */
  setStartGuard(fn: (() => string | null) | null): void {
    this.startGuard = fn;
  }

  // --- Heartbeat: lets a restart tell a blip from a long outage ---------------------------------

  heartbeat(): void {
    settings.set('heartbeat', this.clock());
  }

  startHeartbeat(intervalMs = 60_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * Keeps every running bot's displayed floating P&L and position prices
   * current between bar closes. Ticks (and therefore snapshot pushes) only
   * happen once per bar by design -- signals must never act on a forming bar
   * -- but that left the dashboard showing a frozen number for however long
   * the strategy's timeframe is. This is purely a display refresh: one
   * broker.getPositions() call shared across every running bot, applied
   * without touching signals, indicators or realised P&L accounting.
   */
  startFloatingRefresh(intervalMs = 4000): void {
    if (this.floatingTimer) return;
    this.floatingTimer = setInterval(() => void this.refreshFloating(), intervalMs);
  }

  stopFloatingRefresh(): void {
    if (this.floatingTimer) clearInterval(this.floatingTimer);
    this.floatingTimer = null;
  }

  private async refreshFloating(): Promise<void> {
    const running = [...this.runners.values()].filter((r) => r.getStatus() === 'running');
    if (running.length === 0) return;
    try {
      const fetchedAt = Date.now();
      const all = await this.broker.getPositions();
      for (const r of running) {
        r.applyPositions(all, fetchedAt);
        void r.enforceFlat(all); // go flat on time even between bar closes
      }
    } catch {
      // Transient broker hiccup -- the next scheduled tick's own
      // getPositions() call will recover it, so this loop just skips a beat.
    }
  }

  get mode(): 'paper' | 'metaapi' | 'mt5mcp' {
    return this.broker.kind;
  }

  private runnerFor(strategy: Strategy): BotRunner {
    let r = this.runners.get(strategy.id);
    if (!r) {
      r = new BotRunner(strategy, this.broker, config.allowLiveTrading, this.clock);
      r.on('status', (snap: BotSnapshot) => this.emit('status', snap));
      r.on('log', (entry) => this.emit('log', entry));
      this.runners.set(strategy.id, r);
    }
    return r;
  }

  async start(strategyId: string): Promise<BotSnapshot> {
    let s = strategies.get(strategyId);
    if (!s) throw new Error(`Strategy ${strategyId} not found`);
    const blocked = this.startGuard?.();
    if (blocked) throw new Error(blocked);
    if (s.pausedBy) {
      // Starting it by hand is the owner's decision; the safety pause is over.
      const { pausedBy: _gone, ...rest } = s;
      s = strategies.save(rest);
    }
    const r = this.runnerFor(s);
    r.updateStrategy(s);
    await r.start();
    settings.set(`bot:${strategyId}:autostart`, true);
    return r.snapshot();
  }

  stop(strategyId: string): BotSnapshot | null {
    const r = this.runners.get(strategyId);
    settings.set(`bot:${strategyId}:autostart`, false);
    if (!r) return null;
    r.stop();
    return r.snapshot();
  }

  async stopAll(): Promise<void> {
    for (const r of this.runners.values()) r.stop();
  }

  async closeAll(strategyId: string): Promise<number> {
    const r = this.runners.get(strategyId);
    if (!r) return 0;
    return r.closeAll();
  }

  /** Push an edited strategy into a running bot without restarting it. */
  reload(strategy: Strategy): void {
    const r = this.runners.get(strategy.id);
    if (r) r.updateStrategy(strategy);
  }

  remove(strategyId: string): void {
    const r = this.runners.get(strategyId);
    if (r) r.stop();
    this.runners.delete(strategyId);
  }

  snapshots(): BotSnapshot[] {
    return [...this.runners.values()].map((r) => r.snapshot());
  }

  snapshot(strategyId: string): BotSnapshot | null {
    return this.runners.get(strategyId)?.snapshot() ?? null;
  }

  /**
   * Stop every bot and mark it "paused by safety" so nothing resumes it by itself.
   * Returns the strategies that were running or set to autostart.
   */
  pauseAllBySafety(): Strategy[] {
    const paused: Strategy[] = [];
    for (const s of strategies.list()) {
      const r = this.runners.get(s.id);
      const wanted = settings.get(`bot:${s.id}:autostart`, false) || r?.getStatus() === 'running';
      if (!wanted) continue;
      r?.stop();
      settings.set(`bot:${s.id}:autostart`, false);
      strategies.save({ ...s, pausedBy: 'safety' });
      paused.push(s);
    }
    return paused;
  }

  /**
   * Resume bots that were running before the last restart, but only if the server was away
   * less than 30 minutes. After a longer outage the market moved without us: bots stay
   * paused and the Inbox asks. A bot paused by safety is never resumed here.
   */
  async restoreAutostart(): Promise<void> {
    const beat = settings.get<number | null>('heartbeat', null);
    const gap = beat == null ? 0 : this.clock() - beat;
    const long = gap > MAX_RESUME_GAP_MS;
    for (const s of strategies.list()) {
      if (!settings.get(`bot:${s.id}:autostart`, false)) continue;
      if (s.pausedBy === 'safety') continue;
      if (long) {
        strategies.save({ ...s, pausedBy: 'safety' });
        settings.set(`bot:${s.id}:autostart`, false);
        this.inbox.raise({
          kind: 'safety_action',
          severity: 'warn',
          strategyId: s.id,
          dedupeKey: `outage:${s.id}`,
          title: `"${s.name}" was left paused after a ${Math.round(gap / 60_000)}-minute outage`,
          body: 'The server was off for a while, so the bot did not restart on its own. Check the account and open positions in MT5, then press Restart bot if you want it running again.',
        });
        continue;
      }
      try {
        await this.start(s.id);
      } catch (err) {
        this.emit('log', logs.add({
          ts: this.clock(),
          strategyId: s.id,
          level: 'error',
          event: 'autostart_failed',
          message: `Could not resume "${s.name}": ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
    }
  }
}

export const manager = new BotManager();
