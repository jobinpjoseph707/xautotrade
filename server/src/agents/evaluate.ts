import { maxDrawdownPctFromEquity } from '../portfolio/drawdown.js';
import { DEFAULT_CRITERIA, type SuccessCriteria, type Verdict, type WeekOutcome } from './types.js';

export interface Evaluation {
  verdict: Verdict;
  returnPct: number;
  maxDrawdownPct: number;
  reasons: string[];
}

export function evaluateWeek(outcome: WeekOutcome, criteria: SuccessCriteria = DEFAULT_CRITERIA): Evaluation {
  const start = outcome.startingBalance;
  const returnPct = start > 0 ? ((outcome.endingBalance - start) / start) * 100 : 0;
  const maxDrawdownPct = maxDrawdownPctFromEquity(start, outcome.equityCurve);

  if (outcome.tradeCount === 0) {
    return {
      verdict: 'no_trades',
      returnPct,
      maxDrawdownPct,
      reasons: ['No trades were taken this week; there is no evidence to pass or fail the strategy.'],
    };
  }

  const reasons: string[] = [];
  const returnOk = returnPct >= criteria.minReturnPct;
  const ddOk = maxDrawdownPct < criteria.maxDrawdownPct;
  reasons.push(
    `Return ${returnPct.toFixed(2)}% ${returnOk ? '>=' : '<'} required ${criteria.minReturnPct}%.`,
    `Max equity drawdown ${maxDrawdownPct.toFixed(2)}% ${ddOk ? '<' : '>='} limit ${criteria.maxDrawdownPct}%.`,
  );
  return { verdict: returnOk && ddOk ? 'pass' : 'fail', returnPct, maxDrawdownPct, reasons };
}
