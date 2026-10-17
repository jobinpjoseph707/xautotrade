/**
 * Scores approved changes on REAL demo trades made after the approval: helped, hurt or inconclusive.
 * It never runs a backtest. The backtest that argued for a change (its validation, any forward run)
 * is not an input here, so it can never score the change it argued for.
 *
 * Rule: at least 30 closed trades after the change. If the strategy also had 30 or more trades in the
 * 30 days before, the change in average profit per trade is judged with a 90% bootstrap interval
 * (clearly above zero = helped, clearly below = hurt, otherwise inconclusive). With no usable "before",
 * the average after the change is judged against zero the same way. Starting a bot, stopping one and
 * deleting a strategy leave no trades to measure, so they are not scored.
 */
import { demoProfits } from './demo.js';
import { writeOutcomeNote } from './outcomeNote.js';
import type { RecordStore } from './records.js';
import { betaSummary, bootstrapDifference, bootstrapInterval, mean, seededRng } from './stats.js';
import type { ChangeRecord, Score, TradeEvidence, TradeSummary } from './types.js';

const DAY = 86_400_000;
export const MIN_SCORE_TRADES = 30;
export const BEFORE_WINDOW_DAYS = 30;
export { demoProfits };

export interface ScoringConfig {
  /** Don't look at a change younger than this. */
  minAgeMs: number;
  /** After this long without enough trades, finalise as inconclusive. */
  maxAgeMs: number;
  minTrades: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  minAgeMs: Number(process.env.LEARN_SCORE_MIN_DAYS ?? 1) * DAY,
  maxAgeMs: Number(process.env.LEARN_SCORE_MAX_DAYS ?? 45) * DAY,
  minTrades: MIN_SCORE_TRADES,
};

export function dueForScoring(records: ChangeRecord[], now: number, cfg: ScoringConfig = DEFAULT_SCORING): ChangeRecord[] {
  return records.filter((r) => r.status === 'approved' && r.score === 'pending' && now - (r.decidedAt ?? r.createdAt) >= cfg.minAgeMs);
}

export function summarise(profits: number[]): TradeSummary {
  const wins = profits.filter((p) => p > 0).length;
  const losses = profits.filter((p) => p < 0).length;
  return { n: profits.length, wins, losses, mean: mean(profits), winRate: betaSummary(wins, losses) };
}

const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

export interface TradeScore {
  score: Score;
  reasons: string[];
  /** True when more trades are needed before judging. */
  wait: boolean;
  evidence?: TradeEvidence;
}

const money = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

/** Pure: the verdict for one change from its closed-trade profits. */
export function scoreFromTrades(args: {
  after: number[];
  before: number[];
  /** True for Risk Guard style changes that make a strategy safer rather than richer. */
  safetyChange?: boolean;
  /** True when we should stop waiting. */
  finalise: boolean;
  minTrades?: number;
  rng: () => number;
}): TradeScore {
  const min = args.minTrades ?? MIN_SCORE_TRADES;
  if (args.after.length < min) {
    const why = `Only ${args.after.length} demo trades since the change (need ${min}).`;
    return args.finalise
      ? { score: 'inconclusive', reasons: [why, 'Gave up waiting for more trades.'], wait: false }
      : { score: 'pending', reasons: [why], wait: true };
  }
  const hasBefore = args.before.length >= min;
  const after = summarise(args.after);
  const before = hasBefore ? summarise(args.before) : null;
  const interval = hasBefore ? bootstrapDifference(args.after, args.before, args.rng) : bootstrapInterval(args.after, args.rng);
  const evidence: TradeEvidence = { after, before, interval, against: hasBefore ? 'before' : 'zero' };
  const lines = [
    `${after.n} demo trades since the change: average ${money(after.mean)} per trade, win rate ${Math.round(after.winRate.mean * 100)}% (${Math.round(after.winRate.lo * 100)}–${Math.round(after.winRate.hi * 100)}%).`,
    before ? `Before: ${before.n} trades, average ${money(before.mean)}.` : 'No 30-trade "before" to compare with, so the average is judged against zero.',
  ];
  const range = `90% range for the ${hasBefore ? 'change in ' : ''}average: ${money(interval.lo)} to ${money(interval.hi)}.`;

  if (args.safetyChange) {
    if (!before) return { score: 'inconclusive', reasons: [...lines, 'A safety change needs a "before" to compare risk with.'], wait: false, evidence };
    if (interval.hi < 0) return { score: 'hurt', reasons: [...lines, range, 'Not safer, or it cost too much.'], wait: false, evidence };
    if (stdev(args.after) <= 0.9 * stdev(args.before)) return { score: 'helped', reasons: [...lines, range, 'Results swing less, at no clear cost.'], wait: false, evidence };
    return { score: 'inconclusive', reasons: [...lines, range, 'No clear difference in risk.'], wait: false, evidence };
  }
  if (interval.lo > 0) return { score: 'helped', reasons: [...lines, range, 'Clearly better.'], wait: false, evidence };
  if (interval.hi < 0) return { score: 'hurt', reasons: [...lines, range, 'Clearly worse.'], wait: false, evidence };
  return { score: 'inconclusive', reasons: [...lines, range, 'The range includes zero, so it is within noise.'], wait: false, evidence };
}

/** A repeatable random source per change, so scoring it twice gives the same answer. */
function rngFor(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return seededRng(h);
}

export interface ScoreDeps {
  /** Closed-trade profits for a strategy in [from, to), oldest first. */
  profits(strategyId: string, from: number, to: number): number[];
  now?: number;
  cfg?: ScoringConfig;
  force?: boolean;
}

export async function scoreDue(
  store: RecordStore<ChangeRecord>,
  deps: ScoreDeps,
): Promise<{ scored: ChangeRecord[]; waiting: number; errors: string[] }> {
  const now = deps.now ?? Date.now();
  const base = deps.cfg ?? DEFAULT_SCORING;
  const cfg = deps.force ? { ...base, minAgeMs: 0 } : base;
  const scored: ChangeRecord[] = [];
  const errors: string[] = [];
  let waiting = 0;
  for (const rec of dueForScoring(store.all(2000), now, cfg)) {
    const since = rec.decidedAt ?? rec.createdAt;
    try {
      const done = (score: Score, reasons: string[], extra: Partial<ChangeRecord> = {}) => {
        Object.assign(rec, extra, { score, scoreReasons: reasons, scoredAt: now });
        if (score === 'helped' || score === 'hurt' || score === 'inconclusive') rec.outcomeNote = writeOutcomeNote(rec);
        scored.push(rec);
      };
      if (rec.actionType === 'start_bot') done('n/a', ['Starting a bot does not change a strategy.']);
      else if (rec.actionType === 'delete_strategy' || rec.actionType === 'stop_bot') done('n/a', ['Nothing trades after this, so there are no demo trades to measure.']);
      else if (!rec.strategyId) done('n/a', ['No strategy to measure.']);
      else if (rec.signatures.some((s) => s === 'symbol:changed' || s === 'timeframe:changed')) done('inconclusive', ['The market or timeframe changed, so before and after cannot be compared.']);
      else {
        const after = deps.profits(rec.strategyId, since, now);
        const before = rec.actionType === 'update_strategy' ? deps.profits(rec.strategyId, since - BEFORE_WINDOW_DAYS * DAY, since) : [];
        const res = scoreFromTrades({
          after, before, safetyChange: rec.agent === 'guard', finalise: now - since >= cfg.maxAgeMs, minTrades: cfg.minTrades, rng: rngFor(rec.id),
        });
        const demo = { from: since, to: now, trades: after.length, netProfit: Math.round(after.reduce((a, b) => a + b, 0) * 100) / 100 };
        rec.followUp = { measuredAt: now, demo, trades: res.evidence };
        if (res.wait) {
          waiting++;
          rec.scoreReasons = res.reasons;
        } else {
          done(res.score, res.reasons);
        }
      }
      store.put(rec);
    } catch (err) {
      errors.push(`${rec.summary.slice(0, 60)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { scored, waiting, errors };
}

export interface ScoreRow {
  key: string;
  agent: string;
  model: string | null;
  proposed: number;
  heldBack: number;
  approved: number;
  rejected: number;
  helped: number;
  hurt: number;
  inconclusive: number;
  pending: number;
  /** helped / (helped + hurt), null until something is decisive. */
  hitRate: number | null;
}

function row(key: string, agent: string, model: string | null, recs: ChangeRecord[]): ScoreRow {
  const c = (f: (r: ChangeRecord) => boolean) => recs.filter(f).length;
  const helped = c((r) => r.status === 'approved' && r.score === 'helped');
  const hurt = c((r) => r.status === 'approved' && r.score === 'hurt');
  return {
    key,
    agent,
    model,
    proposed: recs.length,
    heldBack: c((r) => r.status === 'blocked'),
    approved: c((r) => r.status === 'approved'),
    rejected: c((r) => r.status === 'rejected'),
    helped,
    hurt,
    inconclusive: c((r) => r.status === 'approved' && r.score === 'inconclusive'),
    pending: c((r) => r.status === 'approved' && r.score === 'pending'),
    hitRate: helped + hurt ? Math.round((helped / (helped + hurt)) * 100) / 100 : null,
  };
}

export interface Scoreboard {
  byAgent: ScoreRow[];
  byModel: ScoreRow[];
  critic: { opposedThenHurt: number; opposedThenHelped: number; supportedThenHelped: number; supportedThenHurt: number };
  /** Helped-rate over the last 30 days vs the 30 before: is the system getting better? */
  trend: { recent: number | null; previous: number | null };
}

export function scoreboard(records: ChangeRecord[], now = Date.now()): Scoreboard {
  const group = (keyOf: (r: ChangeRecord) => string) => {
    const m = new Map<string, ChangeRecord[]>();
    for (const r of records) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]);
    return m;
  };
  const byAgent = [...group((r) => r.agent)].map(([k, v]) => row(k, k, null, v));
  const byModel = [...group((r) => `${r.agent}|${r.model}`)].map(([k, v]) => row(k, v[0].agent, v[0].model, v));
  const decisive = records.filter((r) => r.status === 'approved' && (r.score === 'helped' || r.score === 'hurt'));
  const cc = (verdict: string, score: string) => decisive.filter((r) => r.critic?.verdict === verdict && r.score === score).length;
  const rate = (from: number, to: number) => {
    const w = decisive.filter((r) => (r.scoredAt ?? 0) >= from && (r.scoredAt ?? 0) < to);
    return w.length ? Math.round((w.filter((r) => r.score === 'helped').length / w.length) * 100) / 100 : null;
  };
  return {
    byAgent: byAgent.sort((a, b) => b.proposed - a.proposed),
    byModel: byModel.sort((a, b) => b.proposed - a.proposed),
    critic: {
      opposedThenHurt: cc('oppose', 'hurt'),
      opposedThenHelped: cc('oppose', 'helped'),
      supportedThenHelped: cc('support', 'helped'),
      supportedThenHurt: cc('support', 'hurt'),
    },
    trend: { recent: rate(now - 30 * DAY, now + 1), previous: rate(now - 60 * DAY, now - 30 * DAY) },
  };
}
