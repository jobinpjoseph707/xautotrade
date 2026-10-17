/**
 * The backtest check for a strategy taken from a video. It runs on real broker candles only: there is no
 * simulated-price path any more, and no "eligible" type that other code could treat as permission.
 * Whether a strategy moves up a stage is decided by the Phase 2 gates (src/gates), not here.
 */
import { realGateData } from '../gates/source.js';
import { runBacktest } from '../engine/backtest.js';
import { validateStrategy } from '../engine/rules.js';
import type { GateData } from '../gates/types.js';
import type { Strategy } from '../engine/types.js';

export interface GateCriteria {
  minTrades: number;
  maxDrawdownPct: number;
  /** 0 disables the check. */
  minProfitFactor: number;
}

export interface GateResult {
  passed: boolean;
  reasons: string[];
  trades: number;
  maxDrawdownPct: number;
  profitFactor: number;
}

export type { GateData };

/** Gate criteria for real broker history. Profit factor is enforced here, unlike the synthetic default. */
export const REAL_DATA_GATE: GateCriteria = { minTrades: 10, maxDrawdownPct: 25, minProfitFactor: 1 };

export { realGateData };

export async function runBacktestGate(
  strategy: Strategy,
  criteria: GateCriteria,
  data: GateData,
): Promise<GateResult> {
  const reasons: string[] = [];
  const fail = (): GateResult => ({ passed: false, reasons, trades: 0, maxDrawdownPct: 0, profitFactor: 0 });

  const errors = validateStrategy(strategy);
  if (errors.length) {
    reasons.push(...errors);
    return fail();
  }
  try {
    const { candles, spec } = data;
    const initial = 10_000;
    const r = runBacktest(strategy, candles, { initialBalance: initial, spec, maxEquityPoints: 100_000, serverOffsetMs: data.serverOffsetMs });
    const m = r.metrics;

    const sum = r.trades.reduce((a, t) => a + t.netProfit, 0);
    if (Math.abs(initial + sum - m.finalBalance) > 0.01 * Math.max(r.trades.length, 1)) {
      reasons.push('Backtest accounting does not reconcile (sum of trades != final balance).');
    }
    if (m.totalTrades < criteria.minTrades) reasons.push(`Only ${m.totalTrades} trades (need at least ${criteria.minTrades}).`);
    if (m.maxDrawdownPct > criteria.maxDrawdownPct) reasons.push(`Max drawdown ${m.maxDrawdownPct.toFixed(1)}% exceeds ${criteria.maxDrawdownPct}%.`);
    if (criteria.minProfitFactor > 0 && m.profitFactor < criteria.minProfitFactor) {
      reasons.push(`Profit factor ${m.profitFactor.toFixed(2)} below ${criteria.minProfitFactor}.`);
    }
    return { passed: reasons.length === 0, reasons, trades: m.totalTrades, maxDrawdownPct: m.maxDrawdownPct, profitFactor: m.profitFactor };
  } catch (err) {
    reasons.push(`Backtest threw: ${err instanceof Error ? err.message : String(err)}`);
    return fail();
  }
}
