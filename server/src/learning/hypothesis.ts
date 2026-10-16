/**
 * A theory: why a strategy is failing, the ONE change that follows from it, and the result on bars
 * nobody saw that would prove the theory wrong. Parsing here is strict: anything missing is refused,
 * and the facts the server already knows (market, timeframe, market state, tier) are never taken from the agent.
 */
import type { Strategy } from '../engine/types.js';
import type { MetricsLite } from './types.js';

export const DISPROOF_METRICS = ['netProfitPct', 'profitFactor', 'maxDrawdownPct', 'winRatePct', 'trades'] as const;
export type DisproofMetric = (typeof DISPROOF_METRICS)[number];
export const DISPROOF_OPS = ['<', '<=', '>', '>='] as const;
export type DisproofOp = (typeof DISPROOF_OPS)[number];

/** "If the unseen-bars result has <metric> <op> <value>, I am wrong." */
export interface Disproof {
  metric: DisproofMetric;
  op: DisproofOp;
  value: number;
}

/** The seven answers stored with every proposal. The server fills four; the agent writes three. */
export interface Checklist {
  market: string;
  timeframe: string;
  marketState: string;
  tier: string;
  evidence: string;
  change: string;
  wouldProveWrong: string;
}
export const CHECKLIST_KEYS = ['market', 'timeframe', 'marketState', 'tier', 'evidence', 'change', 'wouldProveWrong'] as const;

export interface Theory {
  id: string;
  strategyId: string;
  agent: string;
  claim: string;
  /** Raw field changes, exactly as an update_strategy action carries them. */
  changes: Record<string, unknown>;
  disproof: Disproof;
  checklist: Checklist;
  /** The period the evidence came from (ms). Test bars must not touch it. */
  formedOn: { from: number; to: number };
  lessonsUsed: string[];
  runId?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function disproofMet(d: Disproof, m: MetricsLite): boolean {
  const v = m[d.metric];
  switch (d.op) {
    case '<': return v < d.value;
    case '<=': return v <= d.value;
    case '>': return v > d.value;
    case '>=': return v >= d.value;
  }
}

export const describeDisproof = (d: Disproof): string => `${d.metric} ${d.op} ${d.value} on unseen bars`;

export interface TheoryContext {
  strategy: Strategy;
  agent: string;
  id: string;
  formedOn: { from: number; to: number };
  /** The four answers the server knows for itself. */
  known: Pick<Checklist, 'market' | 'timeframe' | 'marketState' | 'tier'>;
  lessonsUsed: string[];
  runId?: string;
}

export function parseDisproof(raw: unknown): Disproof | string {
  if (!isObj(raw)) return 'A theory needs a "would prove me wrong" line.';
  if (!DISPROOF_METRICS.includes(raw.metric as DisproofMetric)) return `The disproof metric must be one of ${DISPROOF_METRICS.join(', ')}.`;
  if (!DISPROOF_OPS.includes(raw.op as DisproofOp)) return `The disproof operator must be one of ${DISPROOF_OPS.join(' ')}.`;
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return 'The disproof value must be a number.';
  return { metric: raw.metric as DisproofMetric, op: raw.op as DisproofOp, value: raw.value };
}

/** Build a theory from what an agent sent, or say why it cannot be one. */
export function parseTheory(raw: unknown, ctx: TheoryContext): { theory: Theory } | { error: string } {
  if (!isObj(raw)) return { error: 'The theory must be an object.' };
  const claim = text(raw.claim, 600);
  if (!claim) return { error: 'A theory needs a claim: what is going wrong and why.' };
  if (!isObj(raw.changes) || Object.keys(raw.changes).length === 0) return { error: 'A theory needs the one change it implies.' };
  const disproof = parseDisproof(raw.disproof);
  if (typeof disproof === 'string') return { error: disproof };
  const c = isObj(raw.checklist) ? raw.checklist : {};
  const evidence = text(c.evidence ?? raw.evidence, 500);
  const change = text(c.change ?? raw.changeText, 300);
  const wouldProveWrong = text(c.wouldProveWrong, 300) || describeDisproof(disproof);
  if (!evidence) return { error: 'A theory needs its evidence (the numbers it came from).' };
  if (!change) return { error: 'A theory needs a one-line description of the change.' };
  const checklist: Checklist = { ...ctx.known, evidence, change, wouldProveWrong };
  return {
    theory: {
      id: ctx.id, strategyId: ctx.strategy.id, agent: ctx.agent, claim, changes: raw.changes, disproof, checklist,
      formedOn: ctx.formedOn, lessonsUsed: ctx.lessonsUsed.slice(0, 10), runId: ctx.runId,
    },
  };
}
