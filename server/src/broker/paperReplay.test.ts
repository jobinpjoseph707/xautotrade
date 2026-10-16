import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBacktest } from '../engine/backtest.js';
import { warmupBars } from '../engine/indicators.js';
import { DEFAULT_SPEC, type Candle } from '../engine/types.js';
import { alwaysLong } from '../testkit/index.js';
import { judgeReplay, runReplay, type ReplayBroker } from './paperReplay.js';
import type { Broker } from './types.js';

/** Fixture candles: a wandering price with real-looking highs and lows. Only tests use this, never the gate. */
function wander(count: number, start = Date.UTC(2026, 9, 5, 0, 0, 0), seed = 12345, amp = 1): Candle[] {
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  const out: Candle[] = [];
  let price = 1.1;
  for (let i = 0; i < count; i++) {
    const open = price;
    const drift = amp * (0.00004 * Math.sin(i / 40) + rnd() * 0.0001);
    const close = open + drift;
    out.push({
      time: start + i * 60_000,
      open: Number(open.toFixed(5)),
      close: Number(close.toFixed(5)),
      high: Number((Math.max(open, close) + Math.abs(rnd()) * 0.00008).toFixed(5)),
      low: Number((Math.min(open, close) - Math.abs(rnd()) * 0.00008).toFixed(5)),
      volume: 100,
    });
    price = close;
  }
  return out;
}

const candles = wander(4320 + 400); // 3 days of M1 plus the history the bot needs
const data = { candles, spec: DEFAULT_SPEC };

function strategy(over: Partial<ReturnType<typeof alwaysLong>['risk']> = {}) {
  const s = alwaysLong();
  s.risk = { ...s.risk, maxDailyTrades: 0, cooldownBars: 0, maxOpenPositions: 1, ...over };
  return s;
}

test('replay: a sound strategy runs three days of candles with no errors', async () => {
  const r = await runReplay(strategy(), data);
  assert.equal(r.reasons.join(' | '), '');
  assert.equal(r.passed, true);
  assert.ok(r.trades.length > 5, `expected trades, got ${r.trades.length}`);
  assert.ok(r.ticks > 4000);
  assert.equal(r.errors.length, 0);
});

test('G-11: replay: a strategy with break-even inside the spread fails with "stop move illegal"', async () => {
  // Spread is 12 points; break-even at 5 points of profit puts the stop inside it.
  const r = await runReplay(strategy({ breakEvenPoints: 5 }), data);
  assert.equal(r.passed, false);
  assert.ok(r.illegalStopMoves.length > 0);
  assert.match(r.reasons.join(' '), /Stop move illegal/);
  assert.match(r.reasons.join(' '), /spread/);
  // The same strategy with break-even well outside the spread is fine.
  const ok = await runReplay(strategy({ breakEvenPoints: 60 }), data);
  assert.equal(ok.illegalStopMoves.length, 0);
  assert.equal(ok.passed, true, ok.reasons.join(' | '));
});

test('G-12: replay and backtest of the same bars give the same trades', async () => {
  // Kept inside one UTC day (and slippage off) so the comparison is about trading and nothing else. Two real
  // differences exist and are written up in the PR: (1) the bot prices its stop from the quote it saw and the
  // backtest from the fill, so with slippage the two stops differ by a few points and an exit can land a few bars
  // apart; (2) after the flat window the bot may re-enter on the first bar of the new day, one bar before the
  // backtest does.
  const spec = { ...DEFAULT_SPEC, slippagePoints: 0 };
  const day = wander(1270, Date.UTC(2026, 9, 5, 0, 0, 0), 99, 6);
  const s = strategy();
  const r = await runReplay(s, { candles: day, spec }, { days: 0.7 });
  assert.equal(r.reasons.join(' | '), '');
  // Start the backtest on the same bar the replay's first tick looks at, so both begin flat and in step.
  const startAt = r.windowStart - 1 - (warmupBars(s.indicators) + 2);
  const bt = runBacktest(s, r.candles.slice(startAt), { initialBalance: 10_000, spec, maxEquityPoints: 10 });
  const end = r.candles[r.candles.length - 1].time;
  const back = bt.trades.filter((t) => t.closeTime < end);
  const played = r.trades.filter((t) => t.closeTime < end);
  assert.ok(back.length >= 3, `expected trades, got ${back.length}`);
  assert.equal(played.length, back.length, 'the same number of trades');
  for (let i = 0; i < back.length; i++) {
    assert.equal(played[i].side, back[i].side, `trade ${i} side`);
    assert.equal(played[i].openTime, back[i].openTime, `trade ${i} entry is on a different bar`);
    assert.ok(Math.abs(played[i].closeTime - back[i].closeTime) <= 60_000, `trade ${i} exit is more than one bar apart`);
    assert.equal(played[i].lots, back[i].lots, `trade ${i} lots`);
  }
});

test('G-13: replay fails if any lot is above maxLot or any error is logged', async () => {
  assert.deepEqual(judgeReplay({ illegalStopMoves: [], maxLotUsed: 0.5, maxLot: 0.5, errors: [] }), []);
  assert.match(judgeReplay({ illegalStopMoves: [], maxLotUsed: 0.51, maxLot: 0.5, errors: [] }).join(' '), /cap is 0.5/);
  assert.match(judgeReplay({ illegalStopMoves: [], maxLotUsed: 0, maxLot: 0.5, errors: ['boom'] }).join(' '), /logged 1 error: boom/);

  // End to end: a lot ten times too big gets through to the broker...
  const big = await runReplay(strategy(), data, {
    wrapBroker: (inner: ReplayBroker): Broker =>
      new Proxy(inner, { get: (t, k, rx) => (k === 'openPosition' ? (req: { volume: number }) => t.openPosition({ ...req, volume: req.volume * 10 } as never) : Reflect.get(t, k, rx)) }),
  });
  assert.equal(big.passed, false);
  assert.match(big.reasons.join(' '), /cap is/);

  // ...and a broker that refuses every order is an error in the log.
  const refusing = await runReplay(strategy(), data, {
    wrapBroker: (inner: ReplayBroker): Broker =>
      new Proxy(inner, { get: (t, k, rx) => (k === 'openPosition' ? async () => { throw new Error('Trade disabled'); } : Reflect.get(t, k, rx)) }),
  });
  assert.equal(refusing.passed, false);
  assert.match(refusing.reasons.join(' '), /Trade disabled/);

  // A sound run uses no lot above the cap.
  const sound = await runReplay(strategy(), data);
  assert.ok(sound.maxLotUsed <= strategy().risk.maxLot);
});

test('replay needs real candles: too few is a plain refusal, not a made-up series', async () => {
  const r = await runReplay(strategy(), { candles: candles.slice(0, 100), spec: DEFAULT_SPEC });
  assert.equal(r.passed, false);
  assert.match(r.reasons.join(' '), /too few/);
});
