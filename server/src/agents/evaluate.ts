import { DEFAULT_CRITERIA, type EquitySample, type SuccessCriteria, type Verdict, type WeekOutcome } from './types.js';

/**
 * Peak-to-trough drawdown in percent, measured on EQUITY samples (same rule as
 * the daily loss cap). The starting balance seeds the peak, so an immediate
 * slide from the opening balance counts.
 */
export function maxDrawdownPctFromEquity(startingBalance: number, curve: EquitySample[]): number {
  let peak = startingBalance;
  let maxDd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = ((peak - p.equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

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
