/**
 * The critic: a fifth agent whose only job is to argue against a proposal.
 * Deterministic rule checks always run; an optional LLM pass adds judgement.
 * Its verdict rides along on the proposal card. It never blocks on its own.
 */
import type { ChatBackend } from '../chat/backend.js';
import { deriveLessons } from './notebook.js';
import { describeSignature } from './signature.js';
import type { ChangeRecord, CriticLevel, CriticVerdict, Validation } from './types.js';

export interface CriticInput {
  actionType: string;
  strategyId: string | null;
  summary: string;
  reason?: string;
  signatures: string[];
  /** Number of human-readable changed fields (updates only). */
  changedFields: number;
  warnings: string[];
  validation?: Validation;
}

const RANK: Record<CriticLevel, number> = { support: 0, caution: 1, oppose: 2 };
const worst = (a: CriticLevel, b: CriticLevel): CriticLevel => (RANK[a] >= RANK[b] ? a : b);
const RECENT_MS = 7 * 86_400_000;

export function ruleCritic(p: CriticInput, history: ChangeRecord[], minTrades = 30, now = Date.now()): CriticVerdict {
  let level: CriticLevel = 'support';
  const points: string[] = [];
  const add = (l: CriticLevel, text: string) => {
    level = worst(level, l);
    points.push(text);
  };

  const v = p.validation;
  if (v?.verdict === 'fail') add('oppose', 'Failed on data the agent never saw.');
  if (v?.reasons.some((r) => r.includes('overfitting'))) add('oppose', 'Looks like it was fitted to recent noise.');
  if (v?.verdict === 'insufficient') add('caution', 'Not enough history or trades to test it on unseen data.');
  const oosTrades = v?.outOfSample?.after?.trades;
  if (typeof oosTrades === 'number' && oosTrades < minTrades && v?.verdict !== 'insufficient') {
    add('caution', `Only ${oosTrades} trades on unseen data — weak evidence.`);
  }
  if (p.actionType === 'update_strategy' && p.changedFields > 2) {
    add('caution', `Changes ${p.changedFields} things at once; if it works you won't know which part helped.`);
  }
  if (p.warnings.some((w) => /loosens a risk limit/i.test(w))) add('caution', 'Loosens a risk limit.');

  const lessons = deriveLessons(history).filter((l) => l.direction === 'hurt' && p.signatures.includes(l.signature));
  for (const l of lessons.slice(0, 2)) add('oppose', `Repeats a documented failure: ${l.text}`);

  if (p.strategyId) {
    const recent = history.filter(
      (r) =>
        r.strategyId === p.strategyId &&
        r.status === 'approved' &&
        now - (r.decidedAt ?? r.createdAt) < RECENT_MS &&
        r.signatures.some((s) => p.signatures.includes(s)),
    );
    const unscored = recent.find((r) => r.score === 'pending');
    const hurt = recent.find((r) => r.score === 'hurt');
    if (hurt) add('oppose', `The same kind of change (${describeSignature(hurt.signatures[0])}) was made to this strategy this week and hurt.`);
    else if (unscored) add('caution', `A similar change to this strategy was approved ${Math.round((now - (unscored.decidedAt ?? unscored.createdAt)) / 86_400_000)}d ago and hasn't been scored yet — stacking changes muddies the result.`);
  }

  if (!points.length) points.push('No red flags found.');
  return { verdict: level, points, source: 'rules' };
}

const CRITIC_PROMPT = `You are the CRITIC agent in the XAutoTrade app. Another agent proposed the change(s) below.
Your job is to argue AGAINST each one where it is warranted: too few trades to judge, changes too many things at once,
looks fitted to recent noise, repeats a past failure, or the reasoning does not follow from the evidence. Be fair: if a
proposal is sound, say so. You cannot propose actions.

Reply with ONLY a JSON array, one object per proposal, in the same order:
[{"verdict":"support"|"caution"|"oppose","points":["short point", "..."]}]
At most 3 points each, each under 25 words.`;

function parseLlm(text: string, n: number): { verdict: CriticLevel; points: string[] }[] | null {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]) as unknown[];
    if (!Array.isArray(arr) || arr.length !== n) return null;
    return arr.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const verdict = (['support', 'caution', 'oppose'] as const).includes(o.verdict as CriticLevel) ? (o.verdict as CriticLevel) : 'caution';
      const points = Array.isArray(o.points) ? o.points.filter((p): p is string => typeof p === 'string').slice(0, 3) : [];
      return { verdict, points };
    });
  } catch {
    return null;
  }
}

/** Rules for every proposal, then one LLM call covering all of them (if enabled). */
export async function critique(
  inputs: CriticInput[],
  history: ChangeRecord[],
  opts: { backend?: ChatBackend; model?: string; lessons?: string[]; now?: number } = {},
): Promise<CriticVerdict[]> {
  const base = inputs.map((p) => ruleCritic(p, history, 30, opts.now));
  if (!opts.backend || !inputs.length) return base;
  const payload = inputs.map((p, i) => ({
    action: p.actionType,
    summary: p.summary,
    reason: p.reason,
    validation: p.validation ? { verdict: p.validation.verdict, reasons: p.validation.reasons } : 'not run',
    ruleChecks: base[i].points,
  }));
  const prompt = [
    CRITIC_PROMPT,
    opts.lessons?.length ? `PROVEN LESSONS FROM PAST CHANGES\n${opts.lessons.join('\n')}` : '',
    `PROPOSALS\n${JSON.stringify(payload)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const parsed = parseLlm(await opts.backend.complete(prompt, { model: opts.model, tag: 'critic' }), inputs.length);
    if (!parsed) return base;
    return base.map((b, i) => {
      const llm = parsed[i];
      const points = [...b.points.filter((p) => p !== 'No red flags found.'), ...llm.points];
      return { verdict: worst(b.verdict, llm.verdict), points: points.length ? points : b.points, source: 'rules+llm' };
    });
  } catch {
    return base;
  }
}
