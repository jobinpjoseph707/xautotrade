import type { LogEntry } from '../store.js';
import type { DemoEvidence } from './types.js';

const CLOSE_EVENTS = new Set(['position_closed', 'exit', 'panic_close']);
const DAY = 86_400_000;

/** Profit of every closed trade in the log, oldest first. */
export function closedProfits(entries: LogEntry[]): { ts: number; profit: number }[] {
  return entries
    .filter((e) => e.level === 'trade' && CLOSE_EVENTS.has(e.event))
    .map((e) => ({ ts: e.ts, profit: (e.data as { profit?: unknown } | undefined)?.profit }))
    .filter((e): e is { ts: number; profit: number } => typeof e.profit === 'number' && Number.isFinite(e.profit));
}

/**
 * What the demo gate needs, from the bot's own closed trades since it entered the demo stage.
 * `startBalance` is the account balance when it started, so drawdown is a share of real money.
 */
export function demoEvidence(entries: LogEntry[], since: number, now: number, startBalance: number): DemoEvidence {
  const closes = closedProfits(entries).filter((c) => c.ts >= since);
  let win = 0;
  let loss = 0;
  let wins = 0;
  let losses = 0;
  let equity = startBalance;
  let peak = startBalance;
  let maxDd = 0;
  for (const c of closes) {
    if (c.profit > 0) { win += c.profit; wins++; } else if (c.profit < 0) { loss -= c.profit; losses++; }
    equity += c.profit;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }
  return {
    days: Math.max(0, (now - since) / DAY),
    trades: closes.length,
    profitFactor: loss > 0 ? Math.round((win / loss) * 100) / 100 : win > 0 ? 999 : 0,
    avgWin: wins ? win / wins : 0,
    avgLoss: losses ? loss / losses : 0,
    maxDrawdownPct: Math.round(maxDd * 100) / 100,
  };
}
