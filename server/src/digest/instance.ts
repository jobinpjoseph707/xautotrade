import { backend, changes } from '../api/chat.js';
import { gateStore } from '../gates/instance.js';
import { closedProfits } from '../gates/demoEvidence.js';
import { inbox } from '../inbox/instance.js';
import { chatUsage, logs, settings, strategies } from '../store.js';
import { DigestService } from './service.js';
import type { DigestInput } from './digest.js';

function gather(from: number, to: number): DigestInput {
  const all = strategies.list();
  const stats = all.map((s) => {
    const closes = closedProfits(logs.tradesBetween(s.id, from, to));
    return {
      name: s.name,
      isTest: s.isTest === true,
      stage: s.gate ?? 'backtest',
      trades: closes.length,
      netProfit: closes.reduce((n, c) => n + c.profit, 0),
      wins: closes.filter((c) => c.profit > 0).length,
    };
  });
  const decided = changes.all(2000).filter((c) => c.decidedAt != null && c.decidedAt >= from && c.decidedAt < to);
  const attempts = all.flatMap((s) => gateStore.list(s.id)).filter((a) => a.at >= from && a.at < to);
  const cards = [...inbox.list('open'), ...inbox.list('done'), ...inbox.list('dismissed')];
  const usage = chatUsage.summary(from);
  return {
    from,
    to,
    strategies: stats,
    proposalsApproved: decided.filter((c) => c.status === 'approved').length,
    proposalsRejected: decided.filter((c) => c.status === 'rejected').length,
    tests: {
      passed: attempts.filter((a) => a.verdict === 'pass').length,
      failed: attempts.filter((a) => a.verdict === 'fail').length,
      notEnough: attempts.filter((a) => a.verdict === 'not_enough_evidence').length,
    },
    safetyEvents: cards.filter((c) => c.kind === 'safety_action' && c.createdAt >= from && c.createdAt < to).length,
    claude: { calls: usage.calls, costUsd: usage.costUsd },
    openInbox: inbox.openCount(),
  };
}

export const digestService = new DigestService({ gather, backend, inbox, store: settings });
