/**
 * What an agent is allowed to see of the ledger: only trusted lessons that match THIS strategy's
 * market exactly (symbol, timeframe and market state) and belong to THIS agent. At most 10, as data
 * rows in a fixed order, under a fixed size. Where two trusted lessons disagree on a setting the row
 * says HOLD, and no proposal may touch that setting.
 */
import type { Timeframe } from '../engine/types.js';
import { buildLedger, holdsFrom, keyString, marketKey, type Hold, type LedgerLesson } from './ledger.js';
import type { ChangeRecord, MarketSnapshot } from './types.js';

export const MAX_ROWS = 10;
export const MAX_CHARS = 1500;

export interface Scope {
  agent: string;
  symbol: string;
  timeframe: Timeframe;
  /** The strategy's market right now. Without it nothing can be matched, so nothing is shown. */
  market: MarketSnapshot | null | undefined;
}

export interface Retrieved {
  rows: string[];
  holds: Hold[];
  /** Trusted lessons that matched, before the row limit. */
  matched: number;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function lessonRow(l: LedgerLesson): string {
  return `setting=${l.setting} | change=${l.change} | effect=${l.verdict} | agree=${l.agree} | against=${l.against} | trust=${l.share.toFixed(2)} | last=${day(l.lastAt)}`;
}

export const holdRow = (h: Hold): string => `setting=${h.setting} | HOLD | trusted lessons disagree; make no change to this setting`;

export function retrieveFrom(lessons: LedgerLesson[], scope: Scope): Retrieved {
  const key = marketKey(scope.symbol, scope.timeframe, scope.market);
  if (!key) return { rows: [], holds: [], matched: 0 };
  const ks = keyString(key);
  const mine = lessons.filter((l) => l.trusted && l.agent === scope.agent && l.key === ks);
  const holds = holdsFrom(mine);
  const held = new Set(holds.map((h) => h.setting));
  const ordered = [...mine.filter((l) => !held.has(l.setting))].sort(
    (a, b) => b.share - a.share || b.agree - a.agree || a.setting.localeCompare(b.setting) || a.change.localeCompare(b.change),
  );
  const rows: string[] = [];
  let chars = 0;
  for (const row of [...holds.map(holdRow), ...ordered.map(lessonRow)]) {
    if (rows.length >= MAX_ROWS || chars + row.length + 1 > MAX_CHARS) break;
    rows.push(row);
    chars += row.length + 1;
  }
  return { rows, holds, matched: mine.length };
}

export function retrieve(records: ChangeRecord[], scope: Scope, now = Date.now()): Retrieved {
  return retrieveFrom(buildLedger(records, now).lessons, scope);
}

/** The settings an agent must leave alone for this strategy right now. */
export const heldSettings = (r: Retrieved): Set<string> => new Set(r.holds.map((h) => h.setting));
