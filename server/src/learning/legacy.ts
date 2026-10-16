/**
 * Lessons written by the old weekly rotation (data/lessons.json) are carried into the database once.
 *
 * Every old lesson is kept: count in = count out. A lesson whose strategy has no readable symbol and
 * timeframe has no market, so it can never be matched to a strategy; it is stored as display-only.
 * Even the ones with a market are history to read, not evidence: they were never scored on trades made
 * after a change, so the ledger (task 3.2) does not count them toward trust.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';

import type { Keyed, RecordStore } from './records.js';

export interface LegacyLesson extends Keyed {
  /** Where the old lesson began (ISO date) and what it was called. */
  weekStart: string | null;
  strategyName: string | null;
  /** The market it was learned in; null when the old record did not say. */
  market: { symbol: string; timeframe: string } | null;
  verdict: string | null;
  returnPct: number | null;
  /** The cause the old rules named, or null. */
  rootCause: string | null;
  /** One line from the old findings. */
  summary: string;
  /** The one change the old rules proposed, in words; null when none. */
  change: string | null;
  /** True when it has no market: shown in the Learning panel, never used. */
  displayOnly: boolean;
}

export interface MigrationResult {
  /** Entries in the file. */
  found: number;
  /** Rows written now (the rest were already there). */
  written: number;
  displayOnly: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One old entry -> one row. Never throws and never drops: a broken entry becomes a display-only row. */
export function legacyLessonFrom(entry: unknown, index: number): LegacyLesson {
  const e = obj(entry);
  const lesson = obj(e.lesson);
  const strategy = obj(lesson.strategy);
  const symbol = str(strategy.symbol);
  const timeframe = str(strategy.timeframe);
  const findings = Array.isArray(lesson.findings) ? lesson.findings.map(obj) : [];
  const root = str(lesson.rootCause);
  const key = findings.find((f) => f.code === root) ?? findings[0];
  const proposal = obj(e.proposal);
  const change = obj(proposal.change);
  const createdIso = str(e.createdAt) ?? str(lesson.weekStart);
  const createdAt = createdIso && Number.isFinite(Date.parse(createdIso)) ? Date.parse(createdIso) : 0;
  const market = symbol && timeframe ? { symbol, timeframe } : null;
  return {
    // Deterministic, so running the migration twice writes nothing the second time.
    id: `legacy:${str(lesson.lessonId) ?? `entry-${index}`}`,
    createdAt,
    weekStart: str(lesson.weekStart),
    strategyName: str(strategy.name),
    market,
    verdict: str(lesson.verdict),
    returnPct: num(lesson.returnPct),
    rootCause: root,
    summary: str(key?.message) ?? 'No clear cause was found.',
    change: str(proposal.reasoning) ?? (str(change.parameter) ? `Changed ${String(change.parameter)}.` : null),
    displayOnly: market === null,
  };
}

export function migrateLegacyLessons(entries: unknown[], store: RecordStore<LegacyLesson>): MigrationResult {
  let written = 0;
  let displayOnly = 0;
  entries.forEach((entry, i) => {
    const row = legacyLessonFrom(entry, i);
    if (row.displayOnly) displayOnly++;
    if (!store.get(row.id)) {
      store.put(row);
      written++;
    }
  });
  return { found: entries.length, written, displayOnly };
}

/**
 * Migrate the old file if it is there, then rename it to `<name>.migrated` so it is not read again
 * (and not deleted: it stays on disk as the original). Returns null when there is no file.
 * If the file cannot be parsed nothing is moved and the error is thrown, so no lesson is lost.
 */
export function migrateLegacyLessonFile(path: string, store: RecordStore<LegacyLesson>): MigrationResult | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a list of lessons; left as it is.`);
  const result = migrateLegacyLessons(parsed, store);
  renameSync(path, `${path}.migrated`);
  return result;
}
