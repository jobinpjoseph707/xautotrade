/** Pure rules for agent runs in the strategy chat (no React Native imports) so they can be unit-tested. */
import type { AgentRun, AgentRunOutcome, AgentRunStep, WhyProposal } from '../types';

export const RUN_BUTTONS: { kind: 'diagnose' | 'tune'; label: string; hint: string }[] = [
  { kind: 'diagnose', label: 'Agents: diagnose', hint: 'The Doctor looks for what is wrong. Nothing is proposed.' },
  { kind: 'tune', label: 'Agents: tune', hint: 'Doctor, Optimizer, Tester and Critic work together. A change that survives its test becomes an Inbox card.' },
];

/** Plain words for how a run ended. A run that ends without a proposal is a normal result, not a failure. */
export const OUTCOME_LABEL: Record<AgentRunOutcome, string> = {
  proposal: 'Proposed a change (see your Inbox)',
  nothing_wrong: 'Nothing to fix',
  diagnosed: 'Diagnosis only',
  dropped: 'The idea failed its own test and was dropped',
  refused: 'The change was refused by a safety check',
  hold: 'Held: the lessons disagree about this setting',
  no_agreement: 'The Critic and Optimizer did not agree',
  budget: 'Stopped: the run used its model calls',
  call_cap: 'Stopped: the daily limit on automatic calls',
  claude_unreachable: 'Claude could not be reached',
  service_down: 'The agent service is not running',
  error: 'Stopped by an error',
};

export const outcomeLabel = (o: string | undefined): string => (o && o in OUTCOME_LABEL ? OUTCOME_LABEL[o as AgentRunOutcome] : 'Still working');

export const AGENT_LABEL: Record<string, string> = {
  dossier: 'Loaded the facts',
  doctor: 'Doctor',
  optimizer: 'Optimizer',
  tester: 'Tester',
  critic: 'Critic',
  risk_guard: 'Risk Guard',
  submit: 'Submitted',
};
export const agentLabel = (a: string): string => AGENT_LABEL[a] ?? a;

/** Keep asking the server while the run is going. Stop when it is done, failed or has been going far too long. */
export const POLL_MS = 3000;
export const MAX_POLL_MS = 15 * 60_000;
export function shouldPoll(run: Pick<AgentRun, 'status' | 'createdAt'> | null, now: number): boolean {
  return !!run && run.status === 'running' && now - run.createdAt < MAX_POLL_MS;
}

export const stepLine = (s: AgentRunStep): string => `${agentLabel(s.agent)}: ${s.text}`;

const CHECKLIST_LABEL: [keyof WhyProposal['rationale']['checklist'], string][] = [
  ['market', 'Market'],
  ['timeframe', 'Timeframe'],
  ['marketState', 'Market state'],
  ['tier', 'Tier'],
  ['evidence', 'Evidence'],
  ['change', 'The change'],
  ['wouldProveWrong', 'Would prove it wrong'],
];

/** The seven answers the agent had to give before it could propose, in a fixed order. */
export const checklistRows = (w: Pick<WhyProposal, 'rationale'>): { label: string; value: string }[] =>
  CHECKLIST_LABEL.map(([k, label]) => ({ label, value: w.rationale.checklist[k] || 'not given' }));

export const lessonsLine = (w: Pick<WhyProposal, 'rationale'>): string =>
  w.rationale.lessonsUsed.length ? `Lessons used: ${w.rationale.lessonsUsed.length}` : 'No earlier lessons applied to this market.';

/** Only proposals made by an agent run have reasoning to show. */
export const hasWhy = (item: { kind: string; ref?: string }): boolean => item.kind === 'proposal' && !!item.ref;
