/**
 * Agent notebooks: only PROVEN lessons, distilled from scored outcomes.
 * A lesson needs at least MIN_DECISIVE helped/hurt results for the same kind
 * of change, with one direction winning at least DOMINANCE of the time. Raw
 * history never goes into the prompt, only these lines.
 */
import { describeSignature } from './signature.js';
import type { ChangeRecord } from './types.js';

export const MIN_DECISIVE = 3;
export const DOMINANCE = 0.75;

export interface Lesson {
  key: string;
  agent: string | null;
  signature: string;
  market: string | null;
  helped: number;
  hurt: number;
  inconclusive: number;
  direction: 'helped' | 'hurt';
  text: string;
  lastAt: number;
}

interface Tally {
  helped: number;
  hurt: number;
  inconclusive: number;
  lastAt: number;
}

function tally(records: ChangeRecord[], keyOf: (r: ChangeRecord, sig: string) => string | null): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const r of records) {
    if (r.status !== 'approved' || !['helped', 'hurt', 'inconclusive'].includes(r.score)) continue;
    for (const sig of r.signatures) {
      const key = keyOf(r, sig);
      if (!key) continue;
      const t = out.get(key) ?? { helped: 0, hurt: 0, inconclusive: 0, lastAt: 0 };
      t[r.score as 'helped' | 'hurt' | 'inconclusive']++;
      t.lastAt = Math.max(t.lastAt, r.scoredAt ?? r.createdAt);
      out.set(key, t);
    }
  }
  return out;
}

function toLesson(key: string, t: Tally, agent: string | null, signature: string, market: string | null): Lesson | null {
  const decisive = t.helped + t.hurt;
  if (decisive < MIN_DECISIVE) return null;
  const direction = t.hurt >= t.helped ? 'hurt' : 'helped';
  const count = direction === 'hurt' ? t.hurt : t.helped;
  if (count / decisive < DOMINANCE) return null;
  const total = decisive + t.inconclusive;
  const what = describeSignature(signature);
  const where = market ? ` on ${market}` : '';
  const text = `${what[0].toUpperCase()}${what.slice(1)}${where} ${direction} ${count} of ${total} times${t.inconclusive ? ` (${t.inconclusive} unclear)` : ''}.`;
  return { key, agent, signature, market, helped: t.helped, hurt: t.hurt, inconclusive: t.inconclusive, direction, text, lastAt: t.lastAt };
}

/**
 * All proven lessons. Market-specific lessons (symbol + timeframe) and general
 * ones are both derived; a general lesson is dropped when a market-specific
 * one for the same agent+signature already says the same thing.
 */
export function deriveLessons(records: ChangeRecord[], agent?: string): Lesson[] {
  const scoped = agent ? records.filter((r) => r.agent === agent) : records;
  const lessons: Lesson[] = [];
  const specific = tally(scoped, (r, sig) => (r.symbol && r.timeframe ? `${r.agent}|${sig}|${r.symbol} ${r.timeframe}` : null));
  for (const [key, t] of specific) {
    const [ag, sig, market] = key.split('|');
    const l = toLesson(key, t, ag, sig, market);
    if (l) lessons.push(l);
  }
  const general = tally(scoped, (r, sig) => `${r.agent}|${sig}`);
  for (const [key, t] of general) {
    const [ag, sig] = key.split('|');
    const l = toLesson(key, t, ag, sig, null);
    if (!l) continue;
    const dup = lessons.some((x) => x.agent === ag && x.signature === sig && x.direction === l.direction && x.helped + x.hurt === l.helped + l.hurt);
    if (!dup) lessons.push(l);
  }
  return lessons.sort((a, b) => b.helped + b.hurt - (a.helped + a.hurt) || b.lastAt - a.lastAt);
}

export interface Notebook {
  agent: string;
  lessons: Lesson[];
  /** Lessons learned by other agents that apply to everyone (hurt-lessons only). */
  shared: Lesson[];
  notes: string[];
}

export function buildNotebook(agent: string, records: ChangeRecord[], notes: string[] = []): Notebook {
  const all = deriveLessons(records);
  return {
    agent,
    lessons: all.filter((l) => l.agent === agent).slice(0, 12),
    shared: all.filter((l) => l.agent !== agent && l.direction === 'hurt').slice(0, 5),
    notes: notes.slice(0, 10),
  };
}

/** Lines for the prompt. Empty when the agent has nothing proven yet. */
export function notebookLines(nb: Notebook): string[] {
  return [
    ...nb.notes.map((n) => `(user note) ${n}`),
    ...nb.lessons.map((l) => l.text),
    ...nb.shared.map((l) => `(learned by ${l.agent}) ${l.text}`),
  ];
}

export function notebookMarkdown(nb: Notebook, title: string): string {
  const out = [`# ${title} — notebook`, '', `_Regenerated from scored outcomes. Only lessons seen at least ${MIN_DECISIVE} times with a ${Math.round(DOMINANCE * 100)}%+ consistent result appear here._`, ''];
  out.push('## Proven lessons', '', ...(nb.lessons.length ? nb.lessons.map((l) => `- ${l.text}`) : ['- None yet.']), '');
  if (nb.shared.length) out.push('## From other agents', '', ...nb.shared.map((l) => `- (${l.agent}) ${l.text}`), '');
  if (nb.notes.length) out.push('## Your notes', '', ...nb.notes.map((n) => `- ${n}`), '');
  return out.join('\n');
}
