/**
 * Weekly agent-rotation types.
 *
 * One "agent" = one strategy config run for one week against the PAPER broker.
 * At week's end it is evaluated, its record is written once (immutable), and
 * either the same config continues (pass / no_trades) or a successor with a
 * modified config is spawned (fail).
 */

import type { BacktestTrade, Strategy } from '../engine/types.js';

/** Realistic, configurable bar. Deliberately not a "10x in a month" target. */
export interface SuccessCriteria {
  /** Net return over the week must be at least this many percent. */
  minReturnPct: number;
  /** Max peak-to-trough EQUITY drawdown must stay strictly under this percent. */
  maxDrawdownPct: number;
}

export const DEFAULT_CRITERIA: SuccessCriteria = {
  minReturnPct: 1,
  maxDrawdownPct: 5,
};

/** 'no_trades' is its own state: no evidence either way, never a silent pass/fail. */
export type Verdict = 'pass' | 'fail' | 'no_trades';

export interface ActiveAgent {
  agentId: string;
  generation: number;
  parentAgentId: string | null;
  weekStart: string; // ISO date
  weekEnd: string; // ISO date
  strategy: Strategy;
  startingBalance: number;
}

export interface AgentRecord {
  agentId: string;
  generation: number;
  parentAgentId: string | null;
  weekStart: string;
  weekEnd: string;
  /** Exact strategy config used this week. */
  strategy: Strategy;
  startingBalance: number;
  endingBalance: number;
  returnPct: number;
  /** Peak-to-trough drawdown measured on equity, not balance. */
  maxDrawdownPct: number;
  tradeCount: number;
  verdict: Verdict;
  /** Human-readable explanation of the verdict. */
  reasons: string[];
  criteria: SuccessCriteria;
  closedAt: string;
}

export interface EquitySample {
  time: number;
  equity: number;
}

/** What running one week produced. Independent of how the week was run. */
export interface WeekOutcome {
  startingBalance: number;
  endingBalance: number;
  equityCurve: EquitySample[];
  tradeCount: number;
  /** Full trade log for the week; the lesson step reads it. */
  trades?: BacktestTrade[];
  /** Signals suppressed per risk gate (dailyLoss, dailyTrades, cooldown, spread, session). */
  gateBlocks?: Record<string, number>;
}
