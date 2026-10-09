import type { Proposal } from '../chat/actions.js';
import type { Inbox } from './inbox.js';

/** Mirrors chat proposals into the Inbox: one card per proposal, closed by a decision made anywhere. */
export function proposalFeed(inbox: Inbox) {
  return {
    proposalCreated(p: Proposal): void {
      inbox.raise({
        kind: 'proposal',
        severity: 'info',
        title: p.summary,
        body: [p.reason, ...p.warnings].filter(Boolean).join('\n'),
        strategyId: p.action.type === 'create_strategy' ? p.action.strategy.id : p.action.id,
        ref: p.id,
        data: { agent: p.agent, model: p.model, action: p.action.type, validation: p.validation?.verdict, critic: p.critic?.verdict },
      });
    },
    proposalDecided(p: Proposal): void {
      const outcome =
        p.status === 'approved'
          ? (p.resultMessage ?? 'Approved and applied.')
          : p.status === 'rejected'
            ? 'Rejected. Nothing was changed.'
            : `Could not apply it: ${p.resultMessage ?? 'unknown error'}`;
      inbox.resolveRef(p.id, outcome);
    },
  };
}
