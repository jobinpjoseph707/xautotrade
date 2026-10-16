/**
 * The Inbox: the one place that holds everything that needs the owner.
 * Logs stay in the `logs` table; this holds only things a person has to look at or decide.
 */
export const INBOX_KINDS = [
  'proposal',
  'gate_result',
  'error',
  'stall',
  'losing_streak',
  'safety_action',
  'claude_unavailable',
  'digest',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxStatus = 'open' | 'done' | 'dismissed';
export type InboxSeverity = 'info' | 'warn' | 'critical';

export const INBOX_ACTIONS = ['approve', 'reject', 'restart', 'dismiss', 'ok', 'undo', 'stage', 'keep'] as const;
export type InboxAction = (typeof INBOX_ACTIONS)[number];

/** Which actions each kind of card offers. Anything else is refused. */
export const ACTIONS_BY_KIND: Record<InboxKind, InboxAction[]> = {
  proposal: ['approve', 'reject'],
  gate_result: ['stage', 'keep'],
  error: ['restart', 'dismiss'],
  stall: ['restart', 'dismiss'],
  losing_streak: ['dismiss'],
  safety_action: ['ok', 'restart'],
  claude_unavailable: ['dismiss'],
  digest: ['dismiss'],
};

export interface InboxItem {
  id: string;
  kind: InboxKind;
  status: InboxStatus;
  severity: InboxSeverity;
  title: string;
  body: string;
  strategyId: string | null;
  /** Points at the thing this card is about, e.g. the proposal id. */
  ref: string | null;
  /** Same key while open = the same problem: counted, not duplicated. */
  dedupeKey: string | null;
  /** How many times the same open problem was seen. */
  count: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** What happened when it was acted on, in plain words. */
  outcome: string | null;
  actions: InboxAction[];
  data?: unknown;
}

export interface NewInboxItem {
  kind: InboxKind;
  title: string;
  body?: string;
  severity?: InboxSeverity;
  strategyId?: string | null;
  ref?: string | null;
  dedupeKey?: string | null;
  data?: unknown;
}
