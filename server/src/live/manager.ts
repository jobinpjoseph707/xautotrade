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
import { logs, settings, strategies } from '../store.js';
import { BotRunner, type BotSnapshot } from './runner.js';

function buildBroker(): Broker {
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

export class BotManager extends EventEmitter {
  readonly broker: Broker;
  private runners = new Map<string, BotRunner>();
  private floatingTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.broker = buildBroker();
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
      r = new BotRunner(strategy, this.broker, config.allowLiveTrading);
      r.on('status', (snap: BotSnapshot) => this.emit('status', snap));
      r.on('log', (entry) => this.emit('log', entry));
      this.runners.set(strategy.id, r);
    }
    return r;
  }

  async start(strategyId: string): Promise<BotSnapshot> {
    const s = strategies.get(strategyId);
    if (!s) throw new Error(`Strategy ${strategyId} not found`);
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

  /** Resume bots that were running before the last restart. */
  async restoreAutostart(): Promise<void> {
    for (const s of strategies.list()) {
      if (settings.get(`bot:${s.id}:autostart`, false)) {
        try {
          await this.start(s.id);
        } catch (err) {
          this.emit('log', logs.add({
            ts: Date.now(),
            strategyId: s.id,
            level: 'error',
            event: 'autostart_failed',
            message: `Could not resume "${s.name}": ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      }
    }
  }
}

export const manager = new BotManager();
