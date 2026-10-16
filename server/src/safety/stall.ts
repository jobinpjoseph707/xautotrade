/**
 * Stall watch: a running bot that has seen no new bar for three times its timeframe, while its market
 * is open, is stuck (feed frozen, bridge hung). That is raised in the Inbox once, and closed when
 * bars flow again. A quiet weekend, the daily flat window and a closed market raise nothing.
 */
import type { Inbox } from '../inbox/inbox.js';
import { isFlatTime } from '../engine/risk.js';
import { TIMEFRAME_MS, type Strategy } from '../engine/types.js';
import type { BotSnapshot } from '../live/runner.js';

export const STALL_FACTOR = 3;

/** Forex and gold are closed from Friday 22:00 UTC until Sunday 22:00 UTC. Used only when the broker cannot say. */
export function weekendClosed(utcMs: number): boolean {
  const d = new Date(utcMs);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  return day === 6 || (day === 5 && hour >= 22) || (day === 0 && hour < 22);
}

export interface StallDeps {
  snapshots(): Pick<BotSnapshot, 'strategyId' | 'strategyName' | 'symbol' | 'timeframe' | 'status' | 'startedAt' | 'lastBarTime'>[];
  strategy(id: string): Strategy | null;
  /** true/false when the broker knows; null when it cannot say. */
  marketOpen(symbol: string): Promise<boolean | null>;
  inbox: Inbox;
  clock?: () => number;
}

export class StallWatch {
  private readonly clock: () => number;

  constructor(private readonly deps: StallDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  /** Returns the ids of strategies found stalled in this pass. */
  async check(): Promise<string[]> {
    const now = this.clock();
    const stalled: string[] = [];
    for (const b of this.deps.snapshots()) {
      const key = `stall:${b.strategyId}`;
      if (b.status !== 'running') {
        this.deps.inbox.resolveKey(key, 'The bot is not running any more.');
        continue;
      }
      const tf = TIMEFRAME_MS[b.timeframe as keyof typeof TIMEFRAME_MS];
      if (!tf) continue;
      const last = b.lastBarTime ?? b.startedAt;
      if (last == null) continue;
      if (now - last <= STALL_FACTOR * tf) {
        this.deps.inbox.resolveKey(key, 'Bars are arriving again.');
        continue;
      }
      const s = this.deps.strategy(b.strategyId);
      // Not a stall: the flat window (or one bar after it ends), or a closed market.
      if (s && (isFlatTime(s.risk, now) || isFlatTime(s.risk, now - tf))) continue;
      let open = await this.deps.marketOpen(b.symbol).catch(() => null);
      if (open === null) open = !weekendClosed(now);
      if (!open) continue;
      stalled.push(b.strategyId);
      const mins = Math.round((now - last) / 60_000);
      this.deps.inbox.raise({
        kind: 'stall',
        severity: 'warn',
        strategyId: b.strategyId,
        dedupeKey: key,
        title: `"${b.strategyName}" has seen no new bar for ${mins} minutes`,
        body: `The market is open but no ${b.timeframe} bar has arrived for more than ${STALL_FACTOR} bars. Check that MetaTrader 5 is open and logged in, then press Restart bot.`,
      });
    }
    return stalled;
  }

  start(intervalMs = 60_000): NodeJS.Timeout {
    const t = setInterval(() => void this.check().catch(() => undefined), intervalMs);
    t.unref?.();
    return t;
  }
}
