import type { Timeframe } from '../engine/types.js';

/** What one agent concluded about a strategy, kept so the others (and the next run) can build on it. */
export interface AgentNote {
  id: string;
  createdAt: number;
  strategyId: string;
  /** Notes are shown only in dossiers of the same market, so they carry it. */
  symbol: string;
  timeframe: Timeframe;
  agent: string;
  runId?: string;
  text: string;
  /** The numbers or facts the agent used. */
  evidence: string[];
}

export const RUN_KINDS = ['diagnose', 'tune'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export type RunTrigger = 'owner' | 'weekly';

export type RunOutcome =
  | 'proposal' // a surviving theory is now a card in the Inbox
  | 'nothing_wrong' // the Doctor found nothing to fix
  | 'dropped' // the theory failed its own test
  | 'refused' // the Risk Guard or the server refused the change
  | 'hold' // trusted lessons disagree about the setting
  | 'no_agreement' // the Critic kept objecting
  | 'budget' // the run used its model calls
  | 'call_cap' // the daily limit on automatic calls
  | 'claude_unreachable'
  | 'service_down'
  | 'error';

export interface RunStep {
  /** doctor, optimizer, tester, critic, risk_guard, submit */
  agent: string;
  at: number;
  /** A few lines in plain words: what this agent said or found. */
  text: string;
  data?: unknown;
}

export interface RunResult {
  runId: string;
  outcome: RunOutcome;
  summary: string;
  steps: RunStep[];
  proposalId?: string;
  modelCalls: number;
}

export interface AgentRunRecord {
  id: string;
  createdAt: number;
  strategyId: string;
  strategyName: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: 'running' | 'done' | 'failed';
  outcome?: RunOutcome;
  summary?: string;
  steps: RunStep[];
  proposalId?: string;
  modelCalls?: number;
  finishedAt?: number;
}
