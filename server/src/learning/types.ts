/**
 * Learning layer types: outcome memory, validation, critic verdicts, scoring
 * and auto-evolve candidates.
 *
 * Hard lines that no agent can cross, whatever these records say: risk limits,
 * the live-trading flag and the approval step live in code. Learning only ever
 * reads backtest and demo results.
 */
import type { Proposal } from '../chat/actions.js';
import type { Strategy, Timeframe } from '../engine/types.js';

export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'blocked';
/** 'n/a' = the action has no measurable effect on performance (e.g. start_bot). */
export type Score = 'pending' | 'helped' | 'hurt' | 'inconclusive' | 'n/a';

/** The handful of backtest numbers we keep per window. */
export interface MetricsLite {
  bars: number;
  trades: number;
  netProfitPct: number;
  profitFactor: number;
  winRatePct: number;
  maxDrawdownPct: number;
}

/** Before/after results on one time window. `before` is null for new strategies. */
export interface WindowResult {
  from: number;
  to: number;
  before: MetricsLite | null;
  after: MetricsLite | null;
}

export type ValidationVerdict = 'pass' | 'fail' | 'insufficient' | 'skipped' | 'error';

export interface Validation {
  verdict: ValidationVerdict;
  reasons: string[];
  /** The recent window the agent was shown (its backtest evidence). */
  inSample?: WindowResult;
  /** An older window the agent never saw. This is what decides. */
  outOfSample?: WindowResult;
}

export interface MarketSnapshot {
  symbol: string;
  timeframe: Timeframe;
  bars: number;
  /** Average true range as a percent of price. */
  atrPct: number;
  /** Net move over the window, percent. */
  trendPct: number;
  avgSpreadPoints: number | null;
}

export type CriticLevel = 'support' | 'caution' | 'oppose';

export interface CriticVerdict {
  verdict: CriticLevel;
  points: string[];
  source: 'rules' | 'llm' | 'rules+llm';
}

/** Realised demo-account results for one strategy over a period (from the trade log). */
export interface DemoStats {
  from: number;
  to: number;
  trades: number;
  netProfit: number;
}

export interface FollowUp {
  measuredAt: number;
  /** Backtest of before/after on bars that formed AFTER the decision: truly unseen. */
  forward: WindowResult;
  demo?: DemoStats;
}

export type ChangeAction = 'create_strategy' | 'update_strategy' | 'delete_strategy' | 'start_bot' | 'stop_bot';

/** One row of outcome memory. Every proposal gets one; approved ones get scored. */
export interface ChangeRecord {
  id: string;
  createdAt: number;
  source: 'chat' | 'evolve';
  agent: string;
  /** Which brain produced it, e.g. "claude-cli/default". Compared per model on the scoreboard. */
  model: string;
  actionType: ChangeAction;
  strategyId: string | null;
  symbol: string | null;
  timeframe: Timeframe | null;
  summary: string;
  reason?: string;
  /** Machine-readable kinds of change, e.g. "risk.slPoints:down". Notebooks group by these. */
  signatures: string[];
  before: Strategy | null;
  after: Strategy | null;
  /** Raw field changes for updates (what gets re-merged on approve). */
  changes?: Record<string, unknown>;
  market?: MarketSnapshot;
  validation?: Validation;
  critic?: CriticVerdict;
  warnings: string[];
  status: ChangeStatus;
  decidedAt?: number;
  resultMessage?: string;
  demoBefore?: DemoStats;
  followUp?: FollowUp;
  score: Score;
  scoreReasons: string[];
  scoredAt?: number;
  /** The proposal as shown, so it survives a server restart and can still be approved. */
  proposal?: Proposal;
}

export type CandidateStatus = 'testing' | 'winner' | 'loser' | 'inconclusive' | 'promoted' | 'dismissed';

/** An auto-evolve variant being shadow-tested forward (never trades). */
export interface EvolveCandidate {
  id: string;
  createdAt: number;
  parentId: string;
  parentName: string;
  /** Parent config at the moment the variant was made (the fair comparison). */
  baseline: Strategy;
  variant: Strategy;
  changes: Record<string, unknown>;
  summary: string;
  reason?: string;
  model: string;
  validation: Validation;
  status: CandidateStatus;
  evaluatedAt?: number;
  forward?: WindowResult;
  verdictReasons: string[];
}

export interface EvolveSettings {
  enabled: boolean;
  /** Strategies the loop may make variants of. Empty = none (explicit opt-in). */
  strategyIds: string[];
  intervalHours: number;
  /** How long a variant is shadow-tested before it is judged. */
  testDays: number;
  lastRunAt: number | null;
}

export const DEFAULT_EVOLVE: EvolveSettings = {
  enabled: false,
  strategyIds: [],
  intervalHours: 168,
  testDays: 7,
  lastRunAt: null,
};
