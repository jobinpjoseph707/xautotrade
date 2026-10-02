/**
 * Out-of-sample validation and forward scoring. Pure: candles in, verdicts out.
 *
 * Why this exists: an agent sees backtests on the most recent window. A change
 * that looks better on that same window has mostly learned that window's noise.
 * So the decision is made on an OLDER window the agent never saw, and later on
 * bars that did not exist yet when the change was approved.
 */
import { runBacktest } from '../engine/backtest.js';
import { warmupBars } from '../engine/indicators.js';
import type { BacktestMetrics, Candle, Strategy, SymbolSpec } from '../engine/types.js';
import type { MarketSnapshot, MetricsLite, Score, Validation, WindowResult } from './types.js';

export interface LabOptions {
  /** Bars at the end of the series the agent was shown (matches the chat backtest window). */
  inSampleBars: number;
  /** Fewer trades than this on a window = not enough evidence. */
  minTrades: number;
  initialBalance: number;
}

export const DEFAULT_LAB: LabOptions = { inSampleBars: 1500, minTrades: 15, initialBalance: 10_000 };

/** Margins so noise-level differences never count as "better" or "worse". */
const PROFIT_MARGIN_PCT = 0.25;
const MIN_OOS_BARS = 300;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function lite(m: BacktestMetrics): MetricsLite {
  return {
    bars: m.barsProcessed,
    trades: m.totalTrades,
    netProfitPct: r2(m.netProfitPct),
    profitFactor: Number.isFinite(m.profitFactor) ? r2(m.profitFactor) : 99,
    winRatePct: r2(m.winRatePct),
    maxDrawdownPct: r2(m.maxDrawdownPct),
  };
}

function run(s: Strategy, candles: Candle[], spec: SymbolSpec, opts: LabOptions): MetricsLite {
  return lite(runBacktest(s, candles, { initialBalance: opts.initialBalance, spec, maxEquityPoints: 10 }).metrics);
}

/** Same instrument and timeframe, so before/after can be compared on the same bars. */
export function comparable(before: Strategy | null, after: Strategy): boolean {
  return !!before && before.symbol === after.symbol && before.timeframe === after.timeframe;
}

/**
 * Slice [from, end) plus enough bars in front for indicator warm-up. The
 * backtester skips its warm-up bars, so trades start at roughly `from`.
 */
export function withWarmup(candles: Candle[], from: number, end: number, strategies: Strategy[]): Candle[] {
  const warm = Math.max(...strategies.map((s) => warmupBars(s.indicators)), 0) + 2;
  return candles.slice(Math.max(0, from - warm), end);
}

export function marketSnapshot(s: { symbol: string; timeframe: Strategy['timeframe'] }, candles: Candle[]): MarketSnapshot {
  const n = candles.length;
  let trSum = 0;
  let spreadSum = 0;
  let spreadN = 0;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    trSum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)) / (c.close || 1);
    if (typeof c.spread === 'number') {
      spreadSum += c.spread;
      spreadN++;
    }
  }
  return {
    symbol: s.symbol,
    timeframe: s.timeframe,
    bars: n,
    atrPct: n > 1 ? r2((trSum / (n - 1)) * 100 * 100) / 100 : 0,
    trendPct: n > 1 ? r2(((candles[n - 1].close - candles[0].close) / candles[0].close) * 100) : 0,
    avgSpreadPoints: spreadN ? r2(spreadSum / spreadN) : null,
  };
}

function describe(m: MetricsLite | null): string {
  if (!m) return 'n/a';
  return `${m.trades} trades, ${m.netProfitPct >= 0 ? '+' : ''}${m.netProfitPct}%, PF ${m.profitFactor}, DD ${m.maxDrawdownPct}%`;
}

export interface ValidateArgs {
  before: Strategy | null;
  after: Strategy;
  candles: Candle[];
  spec: SymbolSpec;
  /** Risk Guard: judged on drawdown, not profit (it trades return for safety on purpose). */
  safetyChange?: boolean;
  opts?: Partial<LabOptions>;
}

export function validateOnCandles(a: ValidateArgs): Validation {
  const opts = { ...DEFAULT_LAB, ...a.opts };
  const before = comparable(a.before, a.after) ? a.before : null;
  const strategies = before ? [before, a.after] : [a.after];
  const n = a.candles.length;
  const isStart = Math.max(0, n - opts.inSampleBars);
  if (isStart < MIN_OOS_BARS) {
    return {
      verdict: 'insufficient',
      reasons: [`Only ${n} bars of history available; need at least ${opts.inSampleBars + MIN_OOS_BARS} to test on unseen data.`],
    };
  }

  const isCandles = withWarmup(a.candles, isStart, n, strategies);
  const oosCandles = withWarmup(a.candles, 0, isStart, strategies);
  const inSample: WindowResult = {
    from: a.candles[isStart].time,
    to: a.candles[n - 1].time,
    before: before ? run(before, isCandles, a.spec, opts) : null,
    after: run(a.after, isCandles, a.spec, opts),
  };
  const outOfSample: WindowResult = {
    from: a.candles[0].time,
    to: a.candles[isStart - 1].time,
    before: before ? run(before, oosCandles, a.spec, opts) : null,
    after: run(a.after, oosCandles, a.spec, opts),
  };

  const reasons: string[] = [`Unseen window: before ${describe(outOfSample.before)} → after ${describe(outOfSample.after)}.`];
  const oa = outOfSample.after!;
  const ob = outOfSample.before;

  // New strategy (or changed instrument): judge the absolute result.
  if (!ob) {
    if (oa.trades < opts.minTrades) {
      reasons.push(`Only ${oa.trades} trades on unseen data (need ${opts.minTrades}) — not enough to judge.`);
      return { verdict: 'insufficient', reasons, inSample, outOfSample };
    }
    const ok = oa.netProfitPct > 0 && oa.profitFactor >= 1;
    reasons.push(ok ? 'Profitable on data it was not designed on.' : 'Loses money on data it was not designed on.');
    return { verdict: ok ? 'pass' : 'fail', reasons, inSample, outOfSample };
  }

  if (oa.trades < opts.minTrades && ob.trades < opts.minTrades) {
    reasons.push(`Fewer than ${opts.minTrades} trades on unseen data either way — not enough to judge.`);
    return { verdict: 'insufficient', reasons, inSample, outOfSample };
  }

  const delta = oa.netProfitPct - ob.netProfitPct;
  const ddAllowance = Math.max(0.5, ob.maxDrawdownPct * 0.25);
  const ddOk = oa.maxDrawdownPct <= ob.maxDrawdownPct + ddAllowance;

  let pass: boolean;
  if (a.safetyChange) {
    pass = oa.maxDrawdownPct <= ob.maxDrawdownPct + 0.25;
    reasons.push(pass ? 'Drawdown did not get worse on unseen data.' : 'Drawdown got WORSE on unseen data, so it is not actually safer.');
  } else {
    pass = delta >= 0 && ddOk;
    if (delta < 0) reasons.push(`Return fell by ${r2(-delta)} points on unseen data.`);
    if (!ddOk) reasons.push(`Drawdown rose from ${ob.maxDrawdownPct}% to ${oa.maxDrawdownPct}%.`);
    if (pass) reasons.push(`Held up on unseen data (${delta >= 0 ? '+' : ''}${r2(delta)} points).`);
  }

  const ia = inSample.after!;
  const ib = inSample.before!;
  if (!pass && ia.netProfitPct > ib.netProfitPct + PROFIT_MARGIN_PCT) {
    reasons.push('It looked better on the window the agent saw but worse on unseen data — the classic sign of overfitting.');
  }
  return { verdict: pass ? 'pass' : 'fail', reasons, inSample, outOfSample };
}

/** Candles strictly after `since` (with warm-up in front), for forward measurement. */
export function forwardWindow(candles: Candle[], since: number, strategies: Strategy[]): Candle[] {
  const first = candles.findIndex((c) => c.time > since);
  if (first < 0) return [];
  return withWarmup(candles, first, candles.length, strategies);
}

export function measureWindow(before: Strategy | null, after: Strategy | null, candles: Candle[], spec: SymbolSpec, since: number, opts?: Partial<LabOptions>): WindowResult | null {
  const o = { ...DEFAULT_LAB, ...opts };
  const list = [before, after].filter((s): s is Strategy => !!s);
  if (!list.length) return null;
  const fwd = forwardWindow(candles, since, list);
  const firstIdx = candles.findIndex((c) => c.time > since);
  if (firstIdx < 0 || fwd.length < 20) return null;
  return {
    from: candles[firstIdx].time,
    to: candles[candles.length - 1].time,
    before: before ? run(before, fwd, spec, o) : null,
    after: after ? run(after, fwd, spec, o) : null,
  };
}

export interface ScoreResult {
  score: Score;
  reasons: string[];
  /** True when we should wait for more data instead of finalising. */
  wait: boolean;
}

/**
 * Judge an approved change on the forward window.
 *  - update:  after vs before on the same bars
 *  - create:  after on its own
 *  - delete / stop_bot: the removed config's forward result (a loss avoided = helped)
 */
export function scoreForward(
  action: string,
  fwd: WindowResult | null,
  minTrades: number,
  finalise: boolean,
  safetyChange = false,
): ScoreResult {
  const wait = (why: string): ScoreResult =>
    finalise ? { score: 'inconclusive', reasons: [why, 'Gave up waiting for more data.'], wait: false } : { score: 'pending', reasons: [why], wait: true };

  if (action === 'start_bot') return { score: 'n/a', reasons: ['Starting a bot does not change a strategy.'], wait: false };
  if (!fwd) return wait('No bars have formed since the change yet.');

  const m = PROFIT_MARGIN_PCT;
  if (action === 'update_strategy') {
    const a = fwd.after;
    const b = fwd.before;
    if (!a || !b) return { score: 'inconclusive', reasons: ['Symbol or timeframe changed, so before/after cannot be compared.'], wait: false };
    if (a.trades < minTrades && b.trades < minTrades) return wait(`Only ${Math.max(a.trades, b.trades)} trades since the change (need ${minTrades}).`);
    const delta = r2(a.netProfitPct - b.netProfitPct);
    const lines = [`Since the change: before ${describe(b)} → after ${describe(a)}.`];
    if (safetyChange) {
      if (a.maxDrawdownPct < b.maxDrawdownPct - 0.1 && delta >= -1) return { score: 'helped', reasons: [...lines, 'Lower drawdown at little cost.'], wait: false };
      if (a.maxDrawdownPct > b.maxDrawdownPct + 0.25 || delta < -1) return { score: 'hurt', reasons: [...lines, 'Not safer, or cost too much return.'], wait: false };
      return { score: 'inconclusive', reasons: [...lines, 'No clear difference.'], wait: false };
    }
    if (delta > m && a.maxDrawdownPct <= b.maxDrawdownPct + 1) return { score: 'helped', reasons: [...lines, `+${delta} points better.`], wait: false };
    if (delta < -m) return { score: 'hurt', reasons: [...lines, `${delta} points worse.`], wait: false };
    return { score: 'inconclusive', reasons: [...lines, 'Difference is within noise.'], wait: false };
  }

  if (action === 'create_strategy') {
    const a = fwd.after;
    if (!a || a.trades < minTrades) return wait(`Only ${a?.trades ?? 0} trades since it was created (need ${minTrades}).`);
    const lines = [`Since creation: ${describe(a)}.`];
    if (a.netProfitPct > m && a.profitFactor >= 1.1) return { score: 'helped', reasons: [...lines, 'Made money on new data.'], wait: false };
    if (a.netProfitPct < -m || a.profitFactor < 0.9) return { score: 'hurt', reasons: [...lines, 'Lost money on new data.'], wait: false };
    return { score: 'inconclusive', reasons: [...lines, 'Roughly break-even.'], wait: false };
  }

  // delete_strategy / stop_bot: what would the removed config have done?
  const b = fwd.before;
  if (!b || b.trades < minTrades) return wait(`The removed strategy would have taken only ${b?.trades ?? 0} trades since (need ${minTrades}).`);
  const lines = [`Had it kept running: ${describe(b)}.`];
  if (b.netProfitPct < -m) return { score: 'helped', reasons: [...lines, 'Removing it avoided a loss.'], wait: false };
  if (b.netProfitPct > m) return { score: 'hurt', reasons: [...lines, 'It would have made money.'], wait: false };
  return { score: 'inconclusive', reasons: [...lines, 'It would have roughly broken even.'], wait: false };
}
