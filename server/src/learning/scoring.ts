/**
 * Scores approved changes once enough time has passed: helped, hurt or
 * inconclusive. Runs from the learning loop and from "Score now".
 */
import type { Lab } from './lab.js';
import type { RecordStore } from './records.js';
import type { ChangeRecord, DemoStats } from './types.js';
import { scoreForward } from './validate.js';

const DAY = 86_400_000;

export interface ScoringConfig {
  /** Don't judge a change younger than this. */
  minAgeMs: number;
  /** After this long, finalise as inconclusive instead of waiting for more trades. */
  maxAgeMs: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  minAgeMs: Number(process.env.LEARN_SCORE_MIN_DAYS ?? 3) * DAY,
  maxAgeMs: Number(process.env.LEARN_SCORE_MAX_DAYS ?? 21) * DAY,
};

export function dueForScoring(records: ChangeRecord[], now: number, cfg: ScoringConfig = DEFAULT_SCORING): ChangeRecord[] {
  return records.filter((r) => r.status === 'approved' && r.score === 'pending' && now - (r.decidedAt ?? r.createdAt) >= cfg.minAgeMs);
}

export async function scoreDue(
  store: RecordStore<ChangeRecord>,
  lab: Lab,
  opts: { now?: number; cfg?: ScoringConfig; demoStats?: (id: string, from: number, to: number) => DemoStats; force?: boolean } = {},
): Promise<{ scored: ChangeRecord[]; waiting: number; errors: string[] }> {
  const now = opts.now ?? Date.now();
  const cfg = opts.force ? { ...(opts.cfg ?? DEFAULT_SCORING), minAgeMs: 0 } : (opts.cfg ?? DEFAULT_SCORING);
  const scored: ChangeRecord[] = [];
  const errors: string[] = [];
  let waiting = 0;
  for (const rec of dueForScoring(store.all(2000), now, cfg)) {
    const since = rec.decidedAt ?? rec.createdAt;
    try {
      const fwd = await lab.forward(rec.before, rec.after, since);
      const finalise = now - since >= cfg.maxAgeMs;
      const res = scoreForward(rec.actionType, fwd, lab.minTrades, finalise, rec.agent === 'guard');
      const demo = rec.strategyId && opts.demoStats && rec.actionType !== 'delete_strategy' ? opts.demoStats(rec.strategyId, since, now) : undefined;
      if (fwd) rec.followUp = { measuredAt: now, forward: fwd, demo };
      if (res.wait) {
        waiting++;
        rec.scoreReasons = res.reasons;
      } else {
        rec.score = res.score;
        rec.scoreReasons = [...res.reasons, ...(demo && demo.trades ? [`Demo account since the change: ${demo.trades} trades, ${demo.netProfit >= 0 ? '+' : ''}${demo.netProfit.toFixed(2)}.`] : [])];
        rec.scoredAt = now;
        scored.push(rec);
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
