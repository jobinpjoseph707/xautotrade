export interface EquitySample {
  time: number;
  equity: number;
}

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
