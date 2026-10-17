/**
 * The backtest gate. A Strategy becomes an EligibleStrategy only by passing
 * through here; the rotation entry point for extracted strategies accepts
 * nothing else, so no extracted strategy can skip the backtester.
 */
import { PaperBroker } from '../broker/paper.js';
import { realGateData } from '../gates/source.js';
import { runBacktest } from '../engine/backtest.js';
import { validateStrategy } from '../engine/rules.js';
import { generateCandles } from '../engine/synthetic.js';
import type { GateData } from '../gates/types.js';
import type { Strategy } from '../engine/types.js';

export interface GateCriteria {
  minTrades: number;
  maxDrawdownPct: number;
  /**
   * 0 disables the check. Off by default: the synthetic feed is a random walk
   * with no edge, so an honest backtester loses on it (see build notes). Raise
   * this only if you feed the gate data you believe contains structure.
   */
  minProfitFactor: number;
}

export const DEFAULT_GATE: GateCriteria = { minTrades: 10, maxDrawdownPct: 25, minProfitFactor: 0 };

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

export async function defaultGateData(strategy: Strategy): Promise<GateData> {
  const broker = new PaperBroker();
  await broker.connect();
  const spec = await broker.getSymbolSpec(strategy.symbol);
  const quote = await broker.getQuote(strategy.symbol);
  const candles = generateCandles({
    count: 6000,
    timeframe: strategy.timeframe,
    startPrice: quote.bid,
    volatility: 0.0006,
    seed: 1234,
    spreadPoints: spec.spreadPoints,
    digits: spec.digits,
  });
  return { candles, spec };
}

export async function runBacktestGate(
  strategy: Strategy,
  criteria: GateCriteria = DEFAULT_GATE,
  data?: GateData,
): Promise<GateResult> {
  const reasons: string[] = [];
  const fail = (): GateResult => ({ passed: false, reasons, trades: 0, maxDrawdownPct: 0, profitFactor: 0 });

  const errors = validateStrategy(strategy);
  if (errors.length) {
    reasons.push(...errors);
    return fail();
  }
  try {
    const { candles, spec } = data ?? (await defaultGateData(strategy));
    const initial = 10_000;
    const r = runBacktest(strategy, candles, { initialBalance: initial, spec, maxEquityPoints: 100_000, serverOffsetMs: data?.serverOffsetMs });
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

const ELIGIBLE = Symbol('eligible');

export class GateFailedError extends Error {
  constructor(readonly gate: GateResult) {
    super(`Strategy failed the backtest gate: ${gate.reasons.join(' ')}`);
    this.name = 'GateFailedError';
  }
}

/** Can only be constructed by passing the gate. */
export class EligibleStrategy {
  readonly [ELIGIBLE] = true;
  private constructor(
    readonly strategy: Strategy,
    readonly gate: GateResult,
  ) {}

  static async fromGate(strategy: Strategy, criteria?: GateCriteria, data?: GateData): Promise<EligibleStrategy> {
    const gate = await runBacktestGate(strategy, criteria, data);
    if (!gate.passed) throw new GateFailedError(gate);
    return new EligibleStrategy(structuredClone(strategy), gate);
  }
}
