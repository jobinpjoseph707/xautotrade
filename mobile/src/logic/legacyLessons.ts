/** Pure presentation rules for lessons carried over from the old weekly rotation (no React Native imports). */
import type { LegacyLesson } from '../types';

export const LEGACY_TITLE = 'Older lessons (read only)';
export const LEGACY_NOTE =
  'Kept from the old weekly test. They are history to read. The agents do not use them, because none was checked against trades made after the change.';
export const LEGACY_EMPTY = 'No older lessons.';

/** "XAUUSD 5m", or "No market recorded" for a lesson that cannot be matched to any strategy. */
export const marketLabel = (l: Pick<LegacyLesson, 'market'>): string => (l.market ? `${l.market.symbol} ${l.market.timeframe}` : 'No market recorded');

export function legacyLine(l: LegacyLesson): string {
  const when = l.weekStart ? l.weekStart.slice(0, 10) : 'date unknown';
  const ret = l.returnPct == null ? '' : ` · return ${l.returnPct > 0 ? '+' : ''}${l.returnPct}%`;
  return `${when} · ${marketLabel(l)}${ret}`;
}

/** Newest first; the ones with no market go last. */
export const sortLegacy = (ls: LegacyLesson[]): LegacyLesson[] =>
  [...ls].sort((a, b) => Number(a.displayOnly) - Number(b.displayOnly) || b.createdAt - a.createdAt);
