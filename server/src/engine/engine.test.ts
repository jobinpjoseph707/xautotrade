import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adx, atr, bbands, ema, macd, rsi, sma, stochastic, computeIndicators } from './indicators.js';
import { evaluateCondition, evaluateGroup, validateStrategy, type EvalContext } from './rules.js';
import { computeLots, isTradingTime, positionProfit, roundLot, slTpPrices, trailStop } from './risk.js';
import { runBacktest } from './backtest.js';
import { generateCandles } from './synthetic.js';

/** Fixed end time (a Thursday, 18:00 UTC) so these tests do not depend on when they are run. */
const FIXED_END = Date.UTC(2026, 0, 8, 18, 0, 0);
const genCandles = (o: Parameters<typeof generateCandles>[0]) => generateCandles({ endTime: FIXED_END, ...o });
import { emaPullbackScalp, bollingerFadeScalp, macdMomentumScalp, orderPathTest } from './presets.js';
import { DEFAULT_RISK, DEFAULT_SPEC, type Candle, type Strategy } from './types.js';

const approx = (a: number | null, b: number, tol = 0.01, msg?: string) => {
  assert.ok(a != null, msg ?? `expected a value, got null`);
  assert.ok(Math.abs((a as number) - b) <= tol, `${msg ?? ''} expected ~${b}, got ${a}`);
};

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

test('sma matches hand-computed values and warms up correctly', () => {
  const v = [1, 2, 3, 4, 5, 6];
  const out = sma(v, 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  approx(out[2], 2);
  approx(out[3], 3);
  approx(out[5], 5);
});

test('ema is SMA-seeded and converges toward a constant series', () => {
  const flat = new Array(50).fill(7);
  const out = ema(flat, 10);
  assert.equal(out[8], null);
  approx(out[9], 7);
  approx(out[49], 7);

  // Known: EMA(3) of 1..5 seeded with SMA(3)=2 -> 3, 4
  const out2 = ema([1, 2, 3, 4, 5], 3);
  approx(out2[2], 2);
  approx(out2[3], 3);
  approx(out2[4], 4);
});

test('rsi reproduces the published Wilder worked example', () => {
  const prices = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
    46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  ];
  const out = rsi(prices, 14);
  assert.equal(out[13], null, 'RSI must be null before 14 deltas exist');
  approx(out[14], 70.53, 0.1, 'first RSI value');
  approx(out[15], 66.32, 0.2, 'second RSI value');
  approx(out[16], 66.55, 0.3, 'third RSI value');
});

test('rsi is 100 on a monotonically rising series and 0 on a falling one', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);
  approx(rsi(up, 14)[39], 100, 0.001);
  approx(rsi(down, 14)[39], 0, 0.001);
});

test('atr on a constant-range series equals that range', () => {
  const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
    time: i * 300000,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 1,
  }));
  approx(atr(candles, 14)[39], 2, 0.001);
});

test('bollinger bands are symmetric around the SMA', () => {
  const v = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const b = bbands(v, 20, 2);
  const i = 59;
  const mid = b.middle[i] as number;
  approx((b.upper[i] as number) - mid, mid - (b.lower[i] as number), 1e-9);
});

test('macd hist equals macd line minus signal line', () => {
  const v = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 3 + i * 0.02);
  const m = macd(v, 12, 26, 9);
  const i = 199;
  approx((m.hist[i] as number), (m.macd[i] as number) - (m.signal[i] as number), 1e-9);
  assert.equal(m.signal[30], null, 'signal must still be warming up at bar 30');
});

test('stochastic stays inside 0..100', () => {
  const candles = genCandles({ count: 300, seed: 7 });
  const s = stochastic(candles, 14, 3, 3);
  for (const v of s.k) if (v != null) assert.ok(v >= -1e-9 && v <= 100 + 1e-9, `k out of range: ${v}`);
  for (const v of s.d) if (v != null) assert.ok(v >= -1e-9 && v <= 100 + 1e-9, `d out of range: ${v}`);
});

test('adx stays inside 0..100 and DI lines are defined together', () => {
  const candles = genCandles({ count: 400, seed: 11 });
  const a = adx(candles, 14);
  for (const v of a.adx) if (v != null) assert.ok(v >= 0 && v <= 100, `adx out of range: ${v}`);
  const last = a.adx.length - 1;
  assert.ok(a.plusDI[last] != null && a.minusDI[last] != null);
});

test('every indicator output series aligns with the candle array length', () => {
  const candles = genCandles({ count: 500, seed: 3 });
  const out = computeIndicators(candles, [
    { id: 'a', type: 'ema', params: { period: 21 } },
    { id: 'b', type: 'macd', params: { fast: 12, slow: 26, signal: 9 } },
    { id: 'c', type: 'bbands', params: { period: 20, mult: 2 } },
    { id: 'd', type: 'stoch', params: { kPeriod: 14, dPeriod: 3, slowing: 3 } },
    { id: 'e', type: 'adx', params: { period: 14 } },
    { id: 'f', type: 'atr', params: { period: 14 } },
    { id: 'g', type: 'cci', params: { period: 20 } },
  ]);
  for (const [key, lines] of Object.entries(out)) {
    for (const [line, series] of Object.entries(lines)) {
      assert.equal(series.length, candles.length, `${key}.${line} length mismatch`);
    }
  }
});

// ---------------------------------------------------------------------------
// Rule DSL
// ---------------------------------------------------------------------------

function ctxFor(candles: Candle[], specs: Parameters<typeof computeIndicators>[1]): EvalContext {
  return { candles, indicators: computeIndicators(candles, specs), spreadPoints: 12 };
}

test('crossesAbove fires exactly on the crossing bar, not before or after', () => {
  // fast rises through slow between bar 2 and bar 3
  const candles: Candle[] = [1, 1, 1, 1, 1].map((_, i) => ({
    time: i * 300000, open: 1, high: 1, low: 1, close: 1, volume: 1,
  }));
  const ctx: EvalContext = {
    candles,
    indicators: {
      fast: { value: [1, 2, 3, 5, 6] },
      slow: { value: [4, 4, 4, 4, 4] },
    },
    spreadPoints: 10,
  };
  const cond = {
    left: { kind: 'indicator' as const, id: 'fast' },
    op: 'crossesAbove' as const,
    right: { kind: 'indicator' as const, id: 'slow' },
  };
  assert.equal(evaluateCondition(cond, 2, ctx), false, 'no cross yet at bar 2');
  assert.equal(evaluateCondition(cond, 3, ctx), true, 'cross at bar 3');
  assert.equal(evaluateCondition(cond, 4, ctx), false, 'already above at bar 4, not a new cross');
});

test('crossesBelow is the mirror image of crossesAbove', () => {
  const candles: Candle[] = new Array(5).fill(0).map((_, i) => ({
    time: i * 300000, open: 1, high: 1, low: 1, close: 1, volume: 1,
  }));
  const ctx: EvalContext = {
    candles,
    indicators: { fast: { value: [6, 5, 4.5, 3, 2] }, slow: { value: [4, 4, 4, 4, 4] } },
    spreadPoints: 10,
  };
  const cond = {
    left: { kind: 'indicator' as const, id: 'fast' },
    op: 'crossesBelow' as const,
    right: { kind: 'indicator' as const, id: 'slow' },
  };
  assert.equal(evaluateCondition(cond, 2, ctx), false);
  assert.equal(evaluateCondition(cond, 3, ctx), true);
  assert.equal(evaluateCondition(cond, 4, ctx), false);
});

test('risingFor requires N consecutive increases', () => {
  const candles: Candle[] = [1, 2, 3, 4, 3].map((c, i) => ({
    time: i * 300000, open: c, high: c, low: c, close: c, volume: 1,
  }));
  const ctx = ctxFor(candles, []);
  const cond = (n: number) => ({
    left: { kind: 'price' as const, field: 'close' as const },
    op: 'risingFor' as const,
    right: { kind: 'const' as const, value: n },
  });
  assert.equal(evaluateCondition(cond(3), 3, ctx), true, 'bars 1,2,3 all rose');
  assert.equal(evaluateCondition(cond(3), 4, ctx), false, 'bar 4 fell');
});

test('AND requires all conditions, OR requires any', () => {
  const candles: Candle[] = new Array(5).fill(0).map((_, i) => ({
    time: i * 300000, open: 1, high: 1, low: 1, close: 10, volume: 1,
  }));
  const ctx = ctxFor(candles, []);
  const truthy = { left: { kind: 'price' as const, field: 'close' as const }, op: 'gt' as const, right: { kind: 'const' as const, value: 5 } };
  const falsy = { left: { kind: 'price' as const, field: 'close' as const }, op: 'lt' as const, right: { kind: 'const' as const, value: 5 } };
  assert.equal(evaluateGroup({ logic: 'AND', conditions: [truthy, falsy] }, 4, ctx), false);
  assert.equal(evaluateGroup({ logic: 'OR', conditions: [truthy, falsy] }, 4, ctx), true);
  assert.equal(evaluateGroup({ logic: 'AND', conditions: [] }, 4, ctx), false, 'empty group must not fire');
  assert.equal(evaluateGroup(undefined, 4, ctx), false);
});

test('conditions referencing a warming-up indicator evaluate to false, never throw', () => {
  const candles = genCandles({ count: 300, seed: 5 });
  const ctx = ctxFor(candles, [{ id: 'ema200', type: 'ema', params: { period: 200 } }]);
  const cond = {
    left: { kind: 'price' as const, field: 'close' as const },
    op: 'gt' as const,
    right: { kind: 'indicator' as const, id: 'ema200' },
  };
  assert.equal(evaluateCondition(cond, 10, ctx), false);
  assert.equal(typeof evaluateCondition(cond, 299, ctx), 'boolean');
});

test('validateStrategy catches unknown indicator references and empty entries', () => {
  const errs = validateStrategy({
    indicators: [{ id: 'ema1', type: 'ema' }],
    entryLong: {
      logic: 'AND',
      conditions: [{ left: { kind: 'indicator', id: 'ghost' }, op: 'gt', right: { kind: 'const', value: 1 } }],
    },
  });
  assert.ok(errs.some((e) => e.includes('ghost')), 'should flag the unknown indicator');

  const errs2 = validateStrategy({ indicators: [], entryLong: { logic: 'AND', conditions: [] } });
  assert.ok(errs2.some((e) => e.includes('never trade')));
});

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

test('roundLot floors to the step and respects min/max', () => {
  const b = { lotStep: 0.01, minLot: 0.01, maxLot: 5 };
  assert.equal(roundLot(0.137, b), 0.13);
  assert.equal(roundLot(0.001, b), 0.01, 'below min clamps up to min');
  assert.equal(roundLot(99, b), 5, 'above max clamps down to max');
});

test('percentRisk sizing loses approximately the intended percent at the stop', () => {
  const risk = { ...DEFAULT_RISK, lotMode: 'percentRisk' as const, riskPercent: 1, maxLot: 100 };
  const spec = { ...DEFAULT_SPEC, commissionPerLot: 0 };
  const balance = 10_000;
  const slPoints = 200; // 20 pips on a 5-digit pair
  const lots = computeLots(risk, balance, slPoints, spec);
  const lossAtStop = slPoints * spec.pointValuePerLot * lots;
  approx(lossAtStop, 100, 1, 'should risk ~1% of 10,000');
});

test('percentRisk falls back to the fixed lot when there is no stop', () => {
  const risk = { ...DEFAULT_RISK, lotMode: 'percentRisk' as const, riskPercent: 1, fixedLot: 0.03 };
  assert.equal(computeLots(risk, 10_000, null, DEFAULT_SPEC), 0.03);
});

test('stop and target sit on the correct side of the entry for both directions', () => {
  const long = slTpPrices('long', 1.1, 100, 200, DEFAULT_SPEC);
  assert.ok((long.sl as number) < 1.1 && (long.tp as number) > 1.1);
  const short = slTpPrices('short', 1.1, 100, 200, DEFAULT_SPEC);
  assert.ok((short.sl as number) > 1.1 && (short.tp as number) < 1.1);
});

test('positionProfit is signed correctly for longs and shorts', () => {
  // 100 points on 1.0 lot at 1 unit/point = 100
  approx(positionProfit('long', 1, 1.1, 1.101, DEFAULT_SPEC), 100, 0.01);
  approx(positionProfit('short', 1, 1.1, 1.101, DEFAULT_SPEC), -100, 0.01);
  approx(positionProfit('short', 1, 1.1, 1.099, DEFAULT_SPEC), 100, 0.01);
});

test('trailing stop only ever tightens', () => {
  const risk = { ...DEFAULT_RISK, trailingEnabled: true, trailingStartPoints: 50, trailingStepPoints: 20 };
  const entry = 1.1;
  const first = trailStop('long', entry, 1.1006, null, risk, DEFAULT_SPEC);
  assert.ok(first != null && first > entry - 1, 'should trail once in profit');
  // Price falls back: the stop must not move down.
  const second = trailStop('long', entry, 1.10055, first, risk, DEFAULT_SPEC);
  assert.equal(second, null, 'must not loosen an existing stop');
});

test('break-even moves the stop to entry once the trigger is reached', () => {
  const risk = { ...DEFAULT_RISK, trailingEnabled: false, breakEvenPoints: 40 };
  assert.equal(trailStop('long', 1.1, 1.1002, null, risk, DEFAULT_SPEC), null, 'not there yet');
  approx(trailStop('long', 1.1, 1.1005, null, risk, DEFAULT_SPEC), 1.1, 1e-9);
});

test('session gating respects UTC windows, weekdays, and windows that wrap midnight', () => {
  const risk = { ...DEFAULT_RISK, sessions: [{ startHour: 7, endHour: 16 }], tradingDays: [1, 2, 3, 4, 5] };
  const mondayNoon = Date.UTC(2026, 0, 5, 12, 0); // Monday
  const mondayNight = Date.UTC(2026, 0, 5, 22, 0);
  const saturdayNoon = Date.UTC(2026, 0, 3, 12, 0);
  assert.equal(isTradingTime(risk, mondayNoon), true);
  assert.equal(isTradingTime(risk, mondayNight), false);
  assert.equal(isTradingTime(risk, saturdayNoon), false);

  const overnight = { ...DEFAULT_RISK, sessions: [{ startHour: 22, endHour: 6 }] };
  assert.equal(isTradingTime(overnight, Date.UTC(2026, 0, 5, 23, 0)), true);
  assert.equal(isTradingTime(overnight, Date.UTC(2026, 0, 5, 3, 0)), true);
  assert.equal(isTradingTime(overnight, Date.UTC(2026, 0, 5, 12, 0)), false);

  assert.equal(isTradingTime(DEFAULT_RISK, mondayNight), true, 'no sessions configured = always on');
});

// ---------------------------------------------------------------------------
// Backtester
// ---------------------------------------------------------------------------

const BT = { initialBalance: 10_000, spec: DEFAULT_SPEC };

test('backtest of a never-triggering strategy produces zero trades and a flat curve', () => {
  const candles = genCandles({ count: 500, seed: 1 });
  const s: Strategy = {
    id: 's', name: 'never', symbol: 'EURUSD', timeframe: '5m',
    indicators: [],
    entryLong: { logic: 'AND', conditions: [{ left: { kind: 'const', value: 0 }, op: 'gt', right: { kind: 'const', value: 1 } }] },
    entryShort: { logic: 'AND', conditions: [{ left: { kind: 'const', value: 0 }, op: 'gt', right: { kind: 'const', value: 1 } }] },
    risk: DEFAULT_RISK,
  };
  const r = runBacktest(s, candles, BT);
  assert.equal(r.metrics.totalTrades, 0);
  assert.equal(r.metrics.finalBalance, 10_000);
  assert.equal(r.metrics.maxDrawdownPct, 0);
});

test('backtest accounting is internally consistent', () => {
  const candles = genCandles({ count: 4000, seed: 21 });
  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = { ...strategy.risk, sessions: [], tradingDays: [], maxDailyLossPercent: 0, maxDailyTrades: 0 };
  const r = runBacktest(strategy, candles, BT);

  assert.ok(r.metrics.totalTrades > 5, `expected trades, got ${r.metrics.totalTrades}`);
  assert.equal(r.metrics.wins + r.metrics.losses, r.metrics.totalTrades);
  assert.equal(r.metrics.longTrades + r.metrics.shortTrades, r.metrics.totalTrades);

  // Sum of net P&L must reconstruct the final balance.
  const summed = r.trades.reduce((a, t) => a + t.netProfit, 0);
  approx(10_000 + summed, r.metrics.finalBalance, 0.5, 'balance must equal initial + sum of trades');

  // The last trade's recorded balance must match the reported final balance.
  approx(r.trades[r.trades.length - 1].balanceAfter, r.metrics.finalBalance, 0.01);

  // Every trade must be chronologically sane and non-overlapping (single position).
  for (let i = 0; i < r.trades.length; i++) {
    const t = r.trades[i];
    assert.ok(t.closeTime >= t.openTime, `trade ${t.id} closes before it opens`);
    assert.ok(t.lots > 0, `trade ${t.id} has non-positive lots`);
    if (i > 0) assert.ok(t.openTime >= r.trades[i - 1].closeTime, `trade ${t.id} overlaps the previous one`);
  }
});

test('backtest never looks ahead: truncating the series cannot change earlier trades', () => {
  const full = genCandles({ count: 3000, seed: 33 });
  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = { ...strategy.risk, sessions: [], tradingDays: [], maxDailyLossPercent: 0, maxDailyTrades: 0 };

  const rFull = runBacktest(strategy, full, BT);
  const rShort = runBacktest(strategy, full.slice(0, 2000), BT);

  // Every trade that closed inside the truncated window must be identical.
  const cutoff = full[1999].time;
  const a = rFull.trades.filter((t) => t.closeTime < cutoff);
  const b = rShort.trades.filter((t) => t.closeTime < cutoff);
  assert.ok(a.length > 0, 'need trades in the shared window to compare');
  assert.equal(a.length, b.length, 'trade count in the shared window must match');
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].openTime, b[i].openTime, `trade ${i} open time diverged`);
    approx(a[i].openPrice, b[i].openPrice, 1e-9, `trade ${i} open price`);
    approx(a[i].netProfit, b[i].netProfit, 0.01, `trade ${i} P&L`);
  }
});

test('stops and targets land where the risk config says they should', () => {
  const candles = genCandles({ count: 3000, seed: 44 });
  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = {
    ...strategy.risk,
    slMode: 'points', slPoints: 100,
    tpMode: 'points', tpPoints: 150,
    trailingEnabled: false, breakEvenPoints: 0,
    sessions: [], tradingDays: [], maxDailyLossPercent: 0, maxDailyTrades: 0,
  };
  const r = runBacktest(strategy, candles, BT);
  assert.ok(r.trades.length > 3);
  for (const t of r.trades) {
    const slDist = Math.abs(t.openPrice - (t.sl as number)) / DEFAULT_SPEC.point;
    const tpDist = Math.abs(t.openPrice - (t.tp as number)) / DEFAULT_SPEC.point;
    approx(slDist, 100, 1.5, `trade ${t.id} stop distance`);
    approx(tpDist, 150, 1.5, `trade ${t.id} target distance`);
  }
});

test('the daily loss cap actually stops trading for that day', () => {
  const candles = genCandles({ count: 6000, seed: 99, volatility: 0.0012 });
  const strategy = emaPullbackScalp('EURUSD');
  const base = { ...strategy.risk, sessions: [], tradingDays: [], cooldownBars: 0, maxDailyTrades: 0 };

  const uncapped = runBacktest({ ...strategy, risk: { ...base, maxDailyLossPercent: 0 } }, candles, BT);
  const capped = runBacktest({ ...strategy, risk: { ...base, maxDailyLossPercent: 1 } }, candles, BT);

  assert.ok(capped.metrics.totalTrades <= uncapped.metrics.totalTrades, 'cap must not increase trade count');
  assert.ok(capped.metrics.totalTrades < uncapped.metrics.totalTrades, 'a 1% daily cap should block some trades');
});

test('the max-daily-trades cap is respected per UTC day', () => {
  const candles = genCandles({ count: 6000, seed: 77, volatility: 0.001 });
  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = { ...strategy.risk, sessions: [], tradingDays: [], cooldownBars: 0, maxDailyTrades: 2, maxDailyLossPercent: 0 };
  const r = runBacktest(strategy, candles, BT);

  const perDay = new Map<string, number>();
  for (const t of r.trades) {
    const d = new Date(t.openTime);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  for (const [day, n] of perDay) assert.ok(n <= 2, `${day} opened ${n} trades, cap was 2`);
});

test('session filter keeps every entry inside the configured window', () => {
  const candles = genCandles({ count: 6000, seed: 55 });
  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = { ...strategy.risk, sessions: [{ startHour: 8, endHour: 12 }], tradingDays: [1, 2, 3, 4, 5], maxDailyTrades: 0, maxDailyLossPercent: 0 };
  const r = runBacktest(strategy, candles, BT);
  assert.ok(r.trades.length > 0, 'need trades to verify the filter');
  for (const t of r.trades) {
    const d = new Date(t.openTime);
    // Entries fill on the bar AFTER the signal, so allow one bar of slack.
    const hour = d.getUTCHours();
    assert.ok(hour >= 8 && hour <= 12, `trade ${t.id} opened at ${hour}:00 UTC, outside 08-12`);
    assert.ok(d.getUTCDay() >= 1 && d.getUTCDay() <= 5, `trade ${t.id} opened on a weekend`);
  }
});

test('wider spreads and commissions can only reduce net profit', () => {
  const candles = genCandles({ count: 4000, seed: 66, spreadPoints: 0 });
  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = { ...strategy.risk, sessions: [], tradingDays: [], maxDailyLossPercent: 0, maxDailyTrades: 0, lotMode: 'fixed', fixedLot: 0.1 };

  const cheap = runBacktest(strategy, candles, { initialBalance: 10_000, spec: { ...DEFAULT_SPEC, spreadPoints: 1, commissionPerLot: 0, slippagePoints: 0 } });
  const pricey = runBacktest(strategy, candles, { initialBalance: 10_000, spec: { ...DEFAULT_SPEC, spreadPoints: 12, commissionPerLot: 15, slippagePoints: 5 } });
  // Changed on purpose (task 1.2): the spread used to be 40 points, but a spread above 15% of the
  // stop now blocks entries outright (R-11), so a 40-point spread would give zero trades, not a loss.

  assert.ok(cheap.metrics.totalTrades > 0);
  assert.ok(pricey.metrics.netProfit < cheap.metrics.netProfit, 'higher costs must hurt the bottom line');
});

test('all three presets run end to end and report coherent metrics', () => {
  const candles = genCandles({ count: 5000, seed: 123 });
  for (const build of [emaPullbackScalp, bollingerFadeScalp, macdMomentumScalp]) {
    const s = build('EURUSD');
    s.risk = { ...s.risk, sessions: [], tradingDays: [], maxDailyLossPercent: 0, maxDailyTrades: 0 };
    const r = runBacktest(s, candles, BT);
    assert.ok(r.metrics.totalTrades >= 0, `${s.name} produced invalid trade count`);
    assert.ok(Number.isFinite(r.metrics.finalBalance), `${s.name} produced a non-finite balance`);
    assert.ok(r.metrics.maxDrawdownPct >= 0 && r.metrics.maxDrawdownPct <= 100, `${s.name} drawdown out of range`);
    assert.ok(r.equity.length > 0, `${s.name} produced no equity curve`);
    if (r.metrics.totalTrades > 0) {
      assert.equal(r.trades.length, r.metrics.totalTrades);
    }
  }
});

test('spread override beats the per-bar spread recorded on the candles', () => {
  // MetaTrader candles carry their own `spread`, and the backtester used to
  // always prefer it — which silently disabled the stress-test control. These
  // candles claim a 1-point spread; the override must still be what bites.
  const candles = genCandles({ count: 4000, seed: 66, spreadPoints: 1 });
  assert.equal(candles[100].spread, 1, 'fixture must carry a per-bar spread');

  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = {
    ...strategy.risk,
    sessions: [], tradingDays: [], maxDailyLossPercent: 0, maxDailyTrades: 0,
    lotMode: 'fixed', fixedLot: 0.1,
    maxSpreadPoints: 0, // 0 disables the spread gate, so only costs differ
  };
  const spec = { ...DEFAULT_SPEC, commissionPerLot: 0, slippagePoints: 0 };

  const recorded = runBacktest(strategy, candles, { initialBalance: 10_000, spec });
  const forced = runBacktest(strategy, candles, {
    initialBalance: 10_000,
    spec,
    // Was 60. A spread that wide is now refused by the spread-to-stop rule (R-11) instead of
    // costing money, so the override is checked at 15 points, which still trades and still costs more.
    spreadOverridePoints: 15,
  });

  assert.ok(recorded.metrics.totalTrades > 3, 'need trades to compare');
  assert.ok(
    forced.metrics.netProfit < recorded.metrics.netProfit,
    `a 15-point forced spread must cost more than the 1-point recorded spread ` +
      `(got forced ${forced.metrics.netProfit} vs recorded ${recorded.metrics.netProfit})`,
  );
});

test('spread override also drives the max-spread entry filter', () => {
  const candles = genCandles({ count: 4000, seed: 66, spreadPoints: 1 });
  const strategy = emaPullbackScalp('EURUSD');
  strategy.risk = {
    ...strategy.risk,
    sessions: [], tradingDays: [], maxDailyLossPercent: 0, maxDailyTrades: 0,
    maxSpreadPoints: 20,
  };

  // Forcing a spread above the strategy's own limit must block every entry,
  // even though the candles themselves record a tight 1-point spread.
  const blocked = runBacktest(strategy, candles, {
    initialBalance: 10_000,
    spec: DEFAULT_SPEC,
    spreadOverridePoints: 50,
  });
  assert.equal(blocked.metrics.totalTrades, 0, 'spread filter must reject entries above the cap');
});

test('the ORDER TEST preset trades on nearly every bar, which is its whole purpose', () => {
  // Its job is to exercise the live order path fast. If it only trades
  // occasionally it cannot do that, so assert the trade RATE, not just a count.
  const candles = genCandles({ count: 2000, timeframe: '1m', seed: 5, spreadPoints: 20 });
  const s = orderPathTest('XAUUSD');
  // Lift the daily cap for this measurement; it exists for live safety.
  s.risk = { ...s.risk, maxDailyTrades: 0, maxDailyLossPercent: 0 };

  const goldSpec = { ...DEFAULT_SPEC, symbol: 'XAUUSD', point: 0.01, digits: 2, spreadPoints: 20, commissionPerLot: 0 };
  const r = runBacktest(s, candles, { initialBalance: 100_000, spec: goldSpec });

  assert.ok(
    r.metrics.totalTrades > 300,
    `expected hundreds of trades over 2000 bars, got ${r.metrics.totalTrades}`,
  );
  assert.ok(r.metrics.avgBarsHeld < 6, `expected very short holds, got ${r.metrics.avgBarsHeld} bars`);
  assert.ok(r.metrics.longTrades > 0 && r.metrics.shortTrades > 0, 'must trade both directions');
});

test('the ORDER TEST preset stays inside its daily trade cap', () => {
  // Unattended safety: this thing is a coin flip, so the cap is what stops it
  // grinding an account down while the user is away from the screen.
  const candles = genCandles({ count: 3000, timeframe: '1m', seed: 9 });
  const s = orderPathTest('XAUUSD');
  assert.equal(s.risk.maxDailyTrades, 20, 'preset must ship with a daily cap');
  assert.equal(s.risk.fixedLot, 0.01, 'preset must ship at minimum lot size');

  const r = runBacktest(s, candles, { initialBalance: 100_000, spec: DEFAULT_SPEC });
  const perDay = new Map<string, number>();
  for (const t of r.trades) {
    const d = new Date(t.openTime);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  for (const [day, n] of perDay) assert.ok(n <= 20, `${day} opened ${n} trades, cap is 20`);
});

test('the ORDER TEST preset needs no indicator warm-up, so it trades immediately', () => {
  // A warm-up period would delay the first live order by many minutes and make
  // the user think the bot is broken.
  const s = orderPathTest('XAUUSD');
  assert.equal(s.indicators.length, 0, 'no indicators means no warm-up wait');

  const candles = genCandles({ count: 60, timeframe: '1m', seed: 3 });
  const r = runBacktest(s, candles, { initialBalance: 100_000, spec: DEFAULT_SPEC });
  assert.ok(r.metrics.totalTrades > 3, `should trade within the first hour, got ${r.metrics.totalTrades}`);
});

test('equity curve is downsampled but keeps its endpoints', () => {
  const candles = genCandles({ count: 5000, seed: 8 });
  const s = emaPullbackScalp('EURUSD');
  s.risk = { ...s.risk, sessions: [], tradingDays: [] };
  const r = runBacktest(s, candles, { ...BT, maxEquityPoints: 100 });
  assert.ok(r.equity.length <= 101, `expected <=101 points, got ${r.equity.length}`);
  assert.equal(r.equity[r.equity.length - 1].time, candles[candles.length - 1].time);
});

test('fitSpreadCap: gold presets get a spread cap wide enough to trade, never narrower, 0 stays off', async () => {
  const { emaPullbackScalp, fastScalpTest, fitSpreadCap } = await import('./presets.js');
  const g = fitSpreadCap(emaPullbackScalp('XAUUSD'), 30);
  assert.equal(g.risk.maxSpreadPoints, 75);
  const e = fitSpreadCap(emaPullbackScalp('EURUSD'), 2);
  assert.equal(e.risk.maxSpreadPoints, 20, 'never lowered');
  const off = fastScalpTest('XAUUSD');
  assert.equal(fitSpreadCap(off, 30).risk.maxSpreadPoints, 0, 'a disabled cap stays disabled');
});

// ---------------------------------------------------------------------------
// Task 1.2: strategy rules (R-1 .. R-18)
// ---------------------------------------------------------------------------

import { validateRisk } from './rules.js';
import { computeLots as computeLotsR, isFlatTime, spreadTooWideForStop } from './risk.js';
import { resolveOperand } from './rules.js';
import { alwaysLong, flat as flatCandles, validStrategy } from '../testkit/index.js';
import { PRESETS } from './presets.js';

const riskWith = (over: Partial<typeof DEFAULT_RISK>) => ({ ...DEFAULT_RISK, ...over });
const errs = (over: Partial<typeof DEFAULT_RISK>, isTest = false) => validateRisk(riskWith(over), isTest);

test('R-1 a strategy with no stop is refused', () => {
  const e = errs({ slMode: 'none' });
  assert.ok(e.some((x) => /No stop-loss/.test(x)), e.join(' | '));
  const s = validStrategy();
  s.risk = riskWith({ slMode: 'none', tpMode: 'points', tpPoints: 300 });
  assert.ok(validateStrategy(s).some((x) => /No stop-loss/.test(x)));
});

test('R-2 a strategy with no target is refused', () => {
  assert.ok(errs({ tpMode: 'none' }).some((x) => /No take-profit/.test(x)));
});

test('R-3 target smaller than 1.5 x stop is refused (points)', () => {
  // 1.5 x 200 = 300 points
  const base = { slMode: 'points', slPoints: 200, tpMode: 'points' } as const;
  assert.ok(errs({ ...base, tpPoints: 299 }).length > 0, '299 must fail');
  assert.deepEqual(errs({ ...base, tpPoints: 300 }), [], '300 must pass');
});

test('R-4 target smaller than 1.5 x stop is refused (ATR multiples)', () => {
  const base = { slMode: 'atr', slAtrMult: 1.0, tpMode: 'atr' } as const;
  assert.ok(errs({ ...base, tpAtrMult: 1.4 }).length > 0, '1.0 / 1.4 must fail');
  assert.deepEqual(errs({ ...base, tpAtrMult: 1.5 }), [], '1.0 / 1.5 must pass');
  // The goldQuickScalpTest shape (1.0 / 0.8) fails as a normal strategy.
  assert.ok(errs({ ...base, tpAtrMult: 0.8 }).length > 0);
});

test('R-5 reward:risk mode needs tpRR of at least 1.5', () => {
  assert.ok(errs({ tpMode: 'rr', tpRR: 1.4 }).length > 0);
  assert.deepEqual(errs({ slMode: 'atr', slAtrMult: 1.5, tpMode: 'rr', tpRR: 1.5 }), []);
});

test('R-6 stop and target in different units are refused unless the target is reward:risk', () => {
  assert.ok(errs({ slMode: 'atr', slAtrMult: 1, tpMode: 'points', tpPoints: 5000 }).some((x) => /different units/.test(x)));
  assert.ok(errs({ slMode: 'points', slPoints: 200, tpMode: 'atr', tpAtrMult: 9 }).some((x) => /different units/.test(x)));
  assert.deepEqual(errs({ slMode: 'atr', slAtrMult: 1, tpMode: 'rr', tpRR: 2 }), []);
});

test('a strategy cannot lower its own minimum below 1.5, and test rigs skip only the reward:risk rule', () => {
  // minRewardRisk can only raise the bar. Lowering it to 0.5 changes nothing.
  assert.ok(errs({ slPoints: 200, tpPoints: 250, minRewardRisk: 0.5 }).length > 0);
  assert.ok(errs({ slPoints: 200, tpPoints: 300, minRewardRisk: 2 }).length > 0, 'a stricter own minimum applies');
  // isTest skips reward:risk but not the need for a stop and a target.
  assert.deepEqual(errs({ slPoints: 200, tpPoints: 200 }, true), []);
  assert.ok(errs({ slMode: 'none' }, true).length > 0);
  assert.ok(errs({ tpMode: 'none' }, true).length > 0);
});

test('R-7 the three real presets pass on XAUUSD and EURUSD; the test rigs are marked isTest', () => {
  for (const preset of PRESETS) {
    for (const symbol of ['XAUUSD', 'EURUSD']) {
      const s = preset.build(symbol);
      const problems = validateStrategy(s);
      const isRig = /test/i.test(preset.key);
      if (isRig) assert.equal(s.isTest, true, `${preset.key} must be marked isTest`);
      else {
        assert.notEqual(s.isTest, true, `${preset.key} is a real preset`);
        assert.deepEqual(problems, [], `${preset.key} on ${symbol}: ${problems.join(' ')}`);
      }
    }
  }
  assert.equal(PRESETS.filter((p) => p.build('EURUSD').isTest).length, 3);
});

test('R-8 presets carry no session hours', () => {
  for (const preset of PRESETS) assert.deepEqual(preset.build('XAUUSD').risk.sessions, [], preset.key);
});

test('R-9 spread 35 with a 150-point stop is blocked; with a 240-point stop it is allowed', () => {
  const r = { maxSpreadToStopRatio: 0.15 };
  assert.equal(spreadTooWideForStop(35, 150, r), true); // 35/150 = 23.3% > 15%
  assert.equal(spreadTooWideForStop(35, 240, r), false); // 35/240 = 14.6% <= 15%
  assert.equal(spreadTooWideForStop(35, null, r), false, 'no stop distance: nothing to compare');
  // A strategy cannot loosen it: 0.9 is capped at 0.15.
  assert.equal(spreadTooWideForStop(35, 150, { maxSpreadToStopRatio: 0.9 }), true);
});

// Candles on a Wednesday morning, away from the flat window.
const WED = Date.UTC(2026, 9, 7, 6, 0, 0);

test('R-10 when a bar has no spread, the symbol typical spread is used', () => {
  const candles = flatCandles(300, 1.1, { start: WED }); // no `spread` field
  const s = alwaysLong();
  const wide = runBacktest(s, candles, { initialBalance: 10_000, spec: { ...DEFAULT_SPEC, spreadPoints: 35 } });
  assert.equal(wide.metrics.totalTrades, 0, '35/200 = 17.5% of the stop is blocked');
  assert.ok((wide.gateBlocks?.spreadToStop ?? 0) > 0);
  const tight = runBacktest(s, candles, { initialBalance: 10_000, spec: { ...DEFAULT_SPEC, spreadPoints: 10 } });
  assert.ok(tight.metrics.totalTrades > 0, 'a 10-point spread on a 200-point stop is allowed');
  assert.equal(tight.gateBlocks?.spreadToStop ?? 0, 0);
});

test('R-11 a backtest with spread above 15% of the stop opens no trades and counts the blocks', () => {
  const s = alwaysLong();
  s.risk = { ...s.risk, slPoints: 150, tpPoints: 225 };
  const candles = flatCandles(300, 1.1, { start: WED }).map((c) => ({ ...c, spread: 35 }));
  const r = runBacktest(s, candles, { initialBalance: 10_000, spec: DEFAULT_SPEC });
  assert.equal(r.metrics.totalTrades, 0);
  assert.ok((r.gateBlocks?.spreadToStop ?? 0) > 0);
});

test('R-13 maxSpreadPoints still blocks on its own', () => {
  const s = alwaysLong();
  s.risk = { ...s.risk, maxSpreadPoints: 5 };
  const candles = flatCandles(300, 1.1, { start: WED }).map((c) => ({ ...c, spread: 10 }));
  const r = runBacktest(s, candles, { initialBalance: 10_000, spec: DEFAULT_SPEC });
  assert.equal(r.metrics.totalTrades, 0);
  assert.ok((r.gateBlocks?.spread ?? 0) > 0);
  assert.equal(r.gateBlocks?.spreadToStop ?? 0, 0, '10/200 is within the ratio, so only the old ceiling blocked');
});

test('a missing stop distance (ATR not ready) opens nothing instead of an order with no stop', () => {
  const s = alwaysLong();
  s.indicators = [{ id: 'atr', type: 'atr', params: { period: 14 } }];
  s.risk = { ...s.risk, slMode: 'atr', slAtrMult: 1, tpMode: 'rr', tpRR: 1.5, atrIndicatorId: 'missing_atr' };
  const candles = flatCandles(300, 1.1, { start: WED });
  const r = runBacktest(s, candles, { initialBalance: 10_000, spec: DEFAULT_SPEC });
  assert.equal(r.metrics.totalTrades, 0);
  assert.ok((r.gateBlocks?.noStop ?? 0) > 0);
});

// A flat price and 1-minute bars; the stop (200 points) is never reached.
const minuteBars = (fromUtc: number, count: number) => flatCandles(count, 1.1, { start: fromUtc });

test('R-14 a position open at 21:45 UTC is closed with reason "eod", and nothing opens until the next day', () => {
  const from = Date.UTC(2026, 9, 7, 17, 30, 0); // Wednesday 17:30 -> 22:30
  const r = runBacktest(alwaysLong(), minuteBars(from, 300), { initialBalance: 10_000, spec: DEFAULT_SPEC });
  assert.equal(r.trades.length, 1, 'one trade, then flat');
  assert.equal(r.trades[0].reason, 'eod');
  assert.equal(r.trades[0].closeTime, Date.UTC(2026, 9, 7, 21, 45, 0));
  assert.ok(r.trades.every((t) => t.openTime < Date.UTC(2026, 9, 7, 21, 45, 0)));
  assert.ok((r.gateBlocks?.flat ?? 0) > 0);
});

test('R-15 positions are closed before the weekend', () => {
  // Friday 22:00 -> Saturday 04:00 with the daily time pushed to 23:59 so only the weekend rule is in play.
  const from = Date.UTC(2026, 9, 9, 22, 0, 0);
  const s = alwaysLong();
  s.risk = { ...s.risk, flatAtUTC: '23:59', flatBeforeWeekend: true };
  const r = runBacktest(s, minuteBars(from, 360), { initialBalance: 10_000, spec: DEFAULT_SPEC });
  assert.equal(r.trades[0].reason, 'eod');
  assert.equal(r.trades[0].closeTime, Date.UTC(2026, 9, 9, 23, 59, 0), 'closed at the Friday cut-off');
  assert.equal(r.trades.length, 1, 'nothing opens on Saturday');

  // With the weekend rule off, the bot trades again on Saturday.
  const off = alwaysLong();
  off.risk = { ...off.risk, flatAtUTC: '23:59', flatBeforeWeekend: false };
  const r2 = runBacktest(off, minuteBars(from, 360), { initialBalance: 10_000, spec: DEFAULT_SPEC });
  assert.ok(r2.trades.length >= 2, 'a second trade opens after midnight');
  assert.ok(r2.trades.some((t) => t.openTime >= Date.UTC(2026, 9, 10, 0, 0, 0)));
});

test('isFlatTime: 21:44 is open, 21:45 is flat, Saturday and Sunday are flat, an unreadable time falls back to 21:45', () => {
  const r = { flatAtUTC: '21:45', flatBeforeWeekend: true };
  assert.equal(isFlatTime(r, Date.UTC(2026, 9, 7, 21, 44)), false);
  assert.equal(isFlatTime(r, Date.UTC(2026, 9, 7, 21, 45)), true);
  assert.equal(isFlatTime(r, Date.UTC(2026, 9, 10, 3, 0)), true, 'Saturday');
  assert.equal(isFlatTime(r, Date.UTC(2026, 9, 11, 12, 0)), true, 'Sunday');
  assert.equal(isFlatTime({ ...r, flatBeforeWeekend: false }, Date.UTC(2026, 9, 10, 3, 0)), false);
  assert.equal(isFlatTime({ ...r, flatAtUTC: 'nonsense' }, Date.UTC(2026, 9, 7, 21, 50)), true);
});

test('R-17 hourUTC is real UTC when the broker clock is UTC+3', () => {
  // The bridge labels broker time as UTC: a bar stamped 15:00 happened at 12:00 UTC.
  const candles = [{ time: Date.UTC(2026, 9, 7, 15, 0, 0), open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  const ctx = { candles, indicators: {}, spreadPoints: 0, serverOffsetMs: 3 * 3_600_000 };
  assert.equal(resolveOperand({ kind: 'hourUTC' }, 0, ctx), 12);
  assert.equal(resolveOperand({ kind: 'hourUTC' }, 0, { ...ctx, serverOffsetMs: undefined }), 15, 'no offset: unchanged');
});

test('sessions and the flat window use real UTC in a backtest when given the broker offset', () => {
  // Broker bars stamped UTC+3: 00:45 server time is 21:45 UTC the previous evening.
  const offset = 3 * 3_600_000;
  const from = Date.UTC(2026, 9, 7, 20, 30, 0) + offset; // 20:30 UTC expressed in server time
  const r = runBacktest(alwaysLong(), minuteBars(from, 150), { initialBalance: 10_000, spec: DEFAULT_SPEC, serverOffsetMs: offset });
  assert.equal(r.trades[0].reason, 'eod');
  assert.equal(r.trades[0].closeTime - offset, Date.UTC(2026, 9, 7, 21, 45, 0));
});

test('R-18 1% risk with a 4-point stop never sizes above maxLot', () => {
  // Regression: percent-risk sizing opened 5 lots on EURUSD. 1% of 10000 = 100; loss per lot = 4 + 7 = 11 -> 9.09 lots wanted.
  const risk = riskWith({ lotMode: 'percentRisk', riskPercent: 1 });
  assert.equal(computeLotsR(risk, 10_000, 4, DEFAULT_SPEC), 0.5);
  assert.ok(computeLotsR({ ...risk, maxLot: 5 }, 10_000, 4, DEFAULT_SPEC) <= 5);
  assert.equal(DEFAULT_RISK.maxLot, 0.5);
});
