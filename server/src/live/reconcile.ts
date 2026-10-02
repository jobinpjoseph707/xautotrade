/**
 * Fills gaps in the trade log from the broker's own deal history.
 *
 * A position can close while nobody is watching it: its bot was stopped, the
 * server was restarting, or (before this fix) the 4-second floating refresh
 * swallowed the change before the bar-close tick could see it. The entry is
 * logged but the close never is, so "trades", "realised" and the history list
 * disagree with MT5. For every logged entry with no logged close that is no
 * longer open, ask the broker what happened and log the close with the real
 * profit and time.
 */
import type { Broker } from '../broker/types.js';
import type { LogEntry } from '../store.js';

const CLOSE_EVENTS = new Set(['position_closed', 'exit', 'panic_close']);
const HALF_HOUR = 30 * 60_000;
const MAX_LOOKUPS = 30;

export interface ReconcileStore {
  tradesBetween(strategyId: string, from: number, to: number): LogEntry[];
  add(entry: Omit<LogEntry, 'id'>): LogEntry;
}

/** positionId of a trade log entry, whichever shape it was written in. */
export function positionIdOf(e: { data?: unknown }): string | null {
  const d = e.data as { positionId?: unknown; id?: unknown } | undefined;
  const v = d?.positionId ?? d?.id;
  return v == null ? null : String(v);
}

/**
 * The close events that really belong to this strategy, one per position.
 *
 * Before the 2026-09-23 fix, a bot's position list briefly held EVERY open
 * position after it placed an order, so other bots' (and manual) positions
 * were later logged as closed by this bot — sometimes twice. Those rows carry
 * the other position's comment tag, so they can be recognised and skipped.
 * Duplicates of one position keep the broker-history row if there is one.
 */
export function ownCloses<T extends { event: string; data?: unknown }>(entries: T[], tag?: string): T[] {
  const byId = new Map<string, T>();
  const noId: T[] = [];
  for (const e of entries) {
    if (!CLOSE_EVENTS.has(e.event)) continue;
    const comment = (e.data as { comment?: unknown } | undefined)?.comment;
    if (tag && typeof comment === 'string' && comment && !comment.startsWith(tag)) continue;
    const id = positionIdOf(e);
    if (!id) {
      noId.push(e);
      continue;
    }
    const prev = byId.get(id);
    const isBroker = (x: T) => (x.data as { source?: unknown } | undefined)?.source === 'broker_history';
    if (!prev || (isBroker(e) && !isBroker(prev))) byId.set(id, e);
  }
  const keep = new Set<T>([...byId.values(), ...noId]);
  return entries.filter((e) => keep.has(e));
}

export function unmatchedEntries(entries: LogEntry[], openIds: Set<string>): LogEntry[] {
  const closed = new Set(entries.filter((e) => CLOSE_EVENTS.has(e.event)).map(positionIdOf).filter(Boolean) as string[]);
  return entries.filter((e) => {
    if (e.event !== 'entry') return false;
    const id = positionIdOf(e);
    return !!id && !closed.has(id) && !openIds.has(id);
  });
}

const REASON_TEXT: Record<string, string> = { tp: 'take-profit', sl: 'stop-loss', stop_out: 'stop-out', bot: 'by the bot', manual: 'manually', other: 'closed' };

export async function reconcileClosures(
  strategyId: string,
  broker: Broker,
  store: ReconcileStore,
  opts: { since: number; openIds: Set<string>; now?: number },
): Promise<LogEntry[]> {
  if (!broker.getPositionHistory) return [];
  const now = opts.now ?? Date.now();
  const entries = store.tradesBetween(strategyId, opts.since, now + 1);
  const added: LogEntry[] = [];
  for (const e of unmatchedEntries(entries, opts.openIds).slice(0, MAX_LOOKUPS)) {
    const id = positionIdOf(e)!;
    let h;
    try {
      h = await broker.getPositionHistory(id);
    } catch {
      continue; // bridge hiccup: try again next time
    }
    if (!h || !h.closed) continue;
    // Deal times are broker server time. The entry deal happened when we logged
    // the entry, so that pair gives the offset (rounded to the broker's zone).
    const offset = Math.round((h.entryTime - e.ts) / HALF_HOUR) * HALF_HOUR;
    const closeTs = Math.min(Math.max((h.closeTime ?? now) - offset, e.ts + 1), now);
    const why = h.reason ? REASON_TEXT[h.reason] ?? h.reason : 'closed';
    added.push(
      store.add({
        ts: closeTs,
        strategyId,
        level: 'trade',
        event: 'position_closed',
        message: `${h.side.toUpperCase()} ${h.volume} ${h.symbol} closed at ${h.closePrice ?? '?'} (${why}) for ${h.profit.toFixed(2)}`,
        data: { positionId: id, profit: h.profit, closePrice: h.closePrice, reason: h.reason, source: 'broker_history' },
      }),
    );
  }
  return added;
}
