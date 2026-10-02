/**
 * Small pure helpers the live runner uses so the dashboard matches the broker:
 *  - broker server-time offset (MT5 stamps bars and ticks in the broker's own
 *    time zone but labels it UTC; this broker runs UTC+3)
 *  - today's trade count / realised P&L rebuilt from the trade log, so a
 *    server restart does not reset them to zero while positions are open.
 */

import { ownCloses } from './reconcile.js';

const HALF_HOUR = 30 * 60_000;
const MAX_OFFSET = 14 * 3_600_000;
/** A tick this far from a half-hour-aligned offset is stale (e.g. market closed). */
const TOLERANCE = 3 * 60_000;

/**
 * Estimate the broker's server-time offset from a quote timestamp. Broker
 * time zones are whole or half hours, so round to 30 minutes, and only trust
 * a quote that is fresh (lands within a few minutes of such an offset).
 * Otherwise keep the previous estimate.
 */
export function estimateServerOffset(quoteTimeMs: number, nowMs: number, previous: number): number {
  if (!Number.isFinite(quoteTimeMs) || quoteTimeMs <= 0) return previous;
  const diff = quoteTimeMs - nowMs;
  const rounded = Math.round(diff / HALF_HOUR) * HALF_HOUR;
  if (Math.abs(rounded) > MAX_OFFSET) return previous;
  if (Math.abs(diff - rounded) > TOLERANCE) return previous;
  return rounded + 0; // normalise -0
}

export function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function utcDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

const CLOSE_EVENTS = new Set(['position_closed', 'exit', 'panic_close']);

/**
 * Rebuild today's counters from this strategy's trade log entries (today only).
 * Pass the strategy's position tag so closes of other bots' positions that old
 * versions mis-logged under this strategy are not counted (see ownCloses).
 */
export function dailyStatsFromLogs(entries: { event: string; data?: unknown }[], tag?: string): { tradesToday: number; realisedToday: number } {
  let tradesToday = 0;
  let realised = 0;
  const closes = new Set(ownCloses(entries, tag));
  for (const e of entries) {
    if (e.event === 'entry') tradesToday++;
    else if (CLOSE_EVENTS.has(e.event) && closes.has(e)) {
      const p = (e.data as { profit?: unknown } | undefined)?.profit;
      if (typeof p === 'number' && Number.isFinite(p)) realised += p;
    }
  }
  return { tradesToday, realisedToday: realised };
}
