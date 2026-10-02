import { ownCloses } from '../live/reconcile.js';
import type { DemoStats } from './types.js';

/** Closing events written by the live runner; each carries the position's profit. */
const CLOSE_EVENTS = new Set(['position_closed', 'exit', 'panic_close']);

export function demoStatsFromLogs(entries: { event: string; data?: unknown }[], from: number, to: number, tag?: string): DemoStats {
  let trades = 0;
  let net = 0;
  const own = new Set(ownCloses(entries, tag));
  for (const e of entries) {
    if (!CLOSE_EVENTS.has(e.event) || !own.has(e)) continue;
    const p = (e.data as { profit?: unknown } | undefined)?.profit;
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    trades++;
    net += p;
  }
  return { from, to, trades, netProfit: Math.round(net * 100) / 100 };
}
