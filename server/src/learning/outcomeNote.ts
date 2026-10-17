/**
 * The one sentence on how a change turned out. It is written from the scored numbers, after scoring:
 * writing it before would let the story come first and the evidence second.
 */
import type { ChangeRecord } from './types.js';

const money = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

export function writeOutcomeNote(rec: ChangeRecord): string {
  if (rec.status !== 'approved' || (rec.score !== 'helped' && rec.score !== 'hurt' && rec.score !== 'inconclusive')) {
    throw new Error('A change is explained only after it has been scored.');
  }
  const ev = rec.followUp?.trades;
  const what = rec.rationale?.claim ?? rec.summary;
  const verdict = rec.score === 'helped' ? 'Helped' : rec.score === 'hurt' ? 'Hurt' : 'No clear effect';
  if (!ev) return `${verdict}: ${what}`;
  const before = ev.before ? ` against ${money(ev.before.mean)} in the 30 days before` : '';
  return `${verdict}: ${what} After ${ev.after.n} demo trades the average was ${money(ev.after.mean)}${before} (90% range ${money(ev.interval.lo)} to ${money(ev.interval.hi)}).`;
}
