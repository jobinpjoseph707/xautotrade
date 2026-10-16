/** Pure Inbox presentation rules (no React Native imports) so they can be unit-tested. */
import type { InboxAction, InboxItem, InboxKind } from '../types';

export const KIND_LABEL: Record<InboxKind, string> = {
  proposal: 'Proposal',
  gate_result: 'Test result',
  error: 'Error',
  stall: 'Stalled',
  losing_streak: 'Losing streak',
  safety_action: 'Safety stop',
  claude_unavailable: 'Claude offline',
  agent_unavailable: 'Agent service off',
  digest: 'Weekly summary',
};

export const ACTION_LABEL: Record<InboxAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  restart: 'Restart bot',
  dismiss: 'Dismiss',
  ok: 'OK',
  undo: 'Undo',
  stage: 'Move to next stage',
  keep: 'Keep here',
};

/** Every button the server can do. A card only lists the ones that apply to it. */
const AVAILABLE: InboxAction[] = ['approve', 'reject', 'restart', 'dismiss', 'ok', 'undo', 'stage', 'keep'];
export const usableActions = (item: Pick<InboxItem, 'actions'>): InboxAction[] => item.actions.filter((a) => AVAILABLE.includes(a));

export const actionVariant = (a: InboxAction): 'success' | 'danger' | 'primary' | 'ghost' =>
  a === 'approve' || a === 'stage' ? 'success' : a === 'reject' ? 'danger' : a === 'restart' ? 'primary' : 'ghost';

export const EMPTY_TITLE = 'Nothing needs you';
export const EMPTY_BODY = 'You can close the app.';
export const INBOX_SUBTITLE = 'Everything that needs you will appear here';

export const badgeText = (open: number): string => (open <= 0 ? '' : open > 99 ? '99+' : String(open));

/** Newest first; critical items ahead of the rest. */
export function sortItems(items: InboxItem[]): InboxItem[] {
  const rank = { critical: 0, warn: 1, info: 2 } as const;
  return [...items].sort((a, b) => rank[a.severity] - rank[b.severity] || b.createdAt - a.createdAt);
}

export const repeatNote = (item: Pick<InboxItem, 'count'>): string => (item.count > 1 ? `Happened ${item.count} times` : '');
