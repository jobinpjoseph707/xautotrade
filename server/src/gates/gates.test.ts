import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { runBacktest } from '../engine/backtest.js';
import { DEFAULT_SPEC, type BacktestResult, type BacktestTrade, type Strategy } from '../engine/types.js';
import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import db from '../store.js';
import { flat, validStrategy } from '../testkit/index.js';
import { GateEngine, judgeBacktest, judgeDemo } from './engine.js';
import { MemoryGateStore } from './store.js';
import { SqliteGateStore } from './sqlite.js';
import { testboardRows } from './testboard.js';
import { GateLockedError, type DemoEvidence, type GateAttempt, type GateDataSource } from './types.js';

const BARS = 1000;
const candles = flat(BARS, 2000);
const unseenFrom = candles[Math.floor(BARS * 0.7)].time;
const source: GateDataSource = async () => ({ candles, spec: DEFAULT_SPEC });

function trade(i: number, openTime: number, netProfit: number): BacktestTrade {
  return {
    id: i, side: 'long', lots: 0.1, openTime, openPrice: 1, closeTime: openTime + 60_000, closePrice: 1, sl: null, tp: null,
    reason: 'tp', grossProfit: netProfit, commission: 0, netProfit, balanceAfter: 0, maxFavourablePoints: 0, maxAdversePoints: 0, barsHeld: 1,
  };
}

/** `n` trades whose profit factor is exactly `pf`: one loss of 100, the rest wins. */
function trades(n: number, pf: number, openTime: number): BacktestTrade[] {
  if (n === 0) return [];
  const out = [trade(0, openTime, -100)];
  for (let i = 1; i < n; i++) out.push(trade(i, openTime + i, (pf * 100) / Math.max(n - 1, 1)));
  return out;
}

interface Script { seen: number; unseen: number; pf: number; stressedPf: number }
function fakeBacktest(script: () => Script): typeof runBacktest {
  return ((_s: Strategy, _c: unknown, o: { spreadOverridePoints?: number | null }) => {
    const sc = script();
    const pf = o.spreadOverridePoints != null ? sc.stressedPf : sc.pf;
    return { trades: [...trades(sc.seen, 1, unseenFrom - 1_000_000), ...trades(sc.unseen, pf, unseenFrom + 1_000)] } as BacktestResult;
  }) as unknown as typeof runBacktest;
}

function setup(script: () => Script = () => ({ seen: 80, unseen: 40, pf: 1.5, stressedPf: 1.1 }), strategy: Strategy = validStrategy()) {
  const store = new MemoryGateStore();
  const inbox = new Inbox(new MemoryInboxStore());
  const saved = new Map<string, Strategy>([[strategy.id, strategy]]);
  let t = 1_000;
  const engine = new GateEngine({
    store,
    inbox,
    strategies: { get: (id) => saved.get(id) ?? null, save: (s) => (saved.set(s.id, s), s) },
    now: () => (t += 1000),
    backtest: fakeBacktest(script),
  });
  return { engine, store, inbox, saved, strategy };
}

const asAttempt = (r: unknown): GateAttempt => {
  assert.ok(!(r as { refused?: boolean }).refused, 'expected an attempt, got a refusal');
  return r as GateAttempt;
};

test('G-1: the backtest gate passes and fails at each pass mark', () => {
  const base = { trades: 100, unseenTrades: 30, unseenProfitFactor: 1.2, stressedProfitFactor: 1, requiredProfitFactor: 1.2 };
  assert.equal(judgeBacktest(base).verdict, 'pass');
  assert.notEqual(judgeBacktest({ ...base, trades: 99 }).verdict, 'pass');
  assert.notEqual(judgeBacktest({ ...base, unseenTrades: 29 }).verdict, 'pass');
  assert.equal(judgeBacktest({ ...base, unseenProfitFactor: 1.19 }).verdict, 'fail');
  assert.equal(judgeBacktest({ ...base, stressedProfitFactor: 0.99 }).verdict, 'fail');
  assert.ok(judgeBacktest({ ...base, stressedProfitFactor: 0.99 }).reasons.some((r) => /spread doubled/.test(r)));
});

test('G-1b: through the engine, 99 trades fail and 100 pass on the same strategy', async () => {
  const a = setup(() => ({ seen: 69, unseen: 30, pf: 1.3, stressedPf: 1.1 }));
  assert.equal(asAttempt(await a.engine.runBacktestGate(a.strategy, source)).passed, false);
  const b = setup(() => ({ seen: 70, unseen: 30, pf: 1.3, stressedPf: 1.1 }));
  assert.equal(asAttempt(await b.engine.runBacktestGate(b.strategy, source)).passed, true);
});

test('G-2: the gate never uses made-up candles', async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/synthetic|generateCandles/.test(text), `${f} must not touch the synthetic candle generator`);
  }
  // The data source is required and its answer is the only data used.
  let calls = 0;
  const counting: GateDataSource = async () => { calls++; return { candles, spec: DEFAULT_SPEC }; };
  const { engine, strategy } = setup();
  await engine.runBacktestGate(strategy, counting);
  assert.equal(calls, 1);
  // A source that has no real data makes the gate throw instead of testing on something else.
  await assert.rejects(() => engine.runBacktestGate(strategy, async () => { throw new Error('too few candles'); }), /too few candles/);
});

test('G-3: the second attempt on the same unseen bars needs profit factor 1.25', async () => {
  const { engine, store, strategy } = setup(() => ({ seen: 80, unseen: 40, pf: 1.22, stressedPf: 1.1 }));
  const first = asAttempt(await engine.runBacktestGate(strategy, source));
  assert.equal(first.requiredProfitFactor, 1.2);
  assert.equal(first.passed, true);
  const second = asAttempt(await engine.runBacktestGate(strategy, source));
  assert.equal(second.attemptNo, 2);
  assert.equal(second.requiredProfitFactor, 1.25);
  assert.equal(second.passed, false);
  assert.equal(second.unseenFrom, first.unseenFrom, 'the unseen bars stay the same');
  const third = asAttempt(await engine.runBacktestGate(strategy, source));
  assert.equal(third.requiredProfitFactor, 1.3);
  assert.equal(store.list(strategy.id, 'backtest').length, 3);
});

test('G-4: a sixth attempt is refused until 500 new bars exist, then the count resets', async () => {
  const { engine, strategy } = setup(() => ({ seen: 80, unseen: 40, pf: 1.1, stressedPf: 1.1 }));
  for (let i = 1; i <= 5; i++) assert.equal(asAttempt(await engine.runBacktestGate(strategy, source)).attemptNo, i);

  const refused = await engine.runBacktestGate(strategy, source);
  assert.equal((refused as { refused?: boolean }).refused, true);
  assert.match((refused as { reason: string }).reason, /500 new bars/);

  const some = flat(BARS + 499, 2000);
  const almost = await engine.runBacktestGate(strategy, async () => ({ candles: some, spec: DEFAULT_SPEC }));
  assert.equal((almost as { refused?: boolean }).refused, true, '499 new bars is not enough');

  const enough = flat(BARS + 500, 2000);
  const again = asAttempt(await engine.runBacktestGate(strategy, async () => ({ candles: enough, spec: DEFAULT_SPEC })));
  assert.equal(again.attemptNo, 1, 'the count resets');
  assert.equal(again.requiredProfitFactor, 1.2);
  assert.ok(again.unseenFrom! > unseenFrom, 'a fresh unseen window');
});

const demo = (o: Partial<DemoEvidence> = {}): DemoEvidence => ({ days: 14, trades: 150, profitFactor: 1.4, avgWin: 12, avgLoss: 10, maxDrawdownPct: 10, ...o });

test('G-5: the demo gate needs both 7 days and 100 trades', () => {
  assert.equal(judgeDemo(demo()).verdict, 'pass');
  const days = judgeDemo(demo({ days: 6, trades: 300 }));
  assert.equal(days.verdict === 'pass', false);
  const trades99 = judgeDemo(demo({ days: 14, trades: 99 }));
  assert.equal(trades99.verdict, 'not_enough_evidence');
  assert.ok(trades99.reasons.some((r) => /99 demo trades/.test(r)));
  assert.equal(judgeDemo(demo({ days: 7, trades: 100 })).verdict, 'pass');
  // exactly 1.2 is not above 1.2
  assert.equal(judgeDemo(demo({ profitFactor: 1.2 })).verdict, 'fail');
  assert.equal(judgeDemo(demo({ maxDrawdownPct: 26 })).verdict, 'fail');
  assert.equal(judgeDemo(demo({ maxDrawdownPct: 26 }), 30).verdict, 'pass');
});

test('G-6: average win smaller than average loss fails the demo gate', () => {
  const r = judgeDemo(demo({ avgWin: 8, avgLoss: 10, profitFactor: 1.5 }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => /Bigger wins, smaller losses/.test(x)));
});

test('G-7: passing a gate writes an inbox item and does not move the strategy', async () => {
  const { engine, inbox, saved, strategy } = setup();
  const a = asAttempt(await engine.runBacktestGate(strategy, source));
  assert.equal(a.passed, true);
  const cards = inbox.list('open').filter((i) => i.kind === 'gate_result');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].ref, a.id);
  assert.equal(cards[0].strategyId, strategy.id);
  assert.deepEqual(cards[0].actions, ['stage', 'keep']);
  assert.equal(saved.get(strategy.id)!.gate ?? 'backtest', 'backtest', 'the strategy has not moved');

  // A failing run raises nothing.
  const f = setup(() => ({ seen: 80, unseen: 40, pf: 1.0, stressedPf: 1.0 }));
  await f.engine.runBacktestGate(f.strategy, source);
  assert.equal(f.inbox.list('open').length, 0);

  // Only the owner's tap moves it, and only one stage.
  const moved = engine.moveStage(strategy.id, 'paper', { allowLiveTrading: false });
  assert.equal(moved.gate, 'paper');
  assert.equal(saved.get(strategy.id)!.gate, 'paper');
  assert.throws(() => engine.moveStage(strategy.id, 'demo', { allowLiveTrading: false }), /has not been passed/);
});

test('G-8: moving to live is always refused', () => {
  const { engine, strategy } = setup();
  for (const allowLiveTrading of [false, true]) {
    assert.throws(() => engine.moveStage(strategy.id, 'live', { allowLiveTrading }), (e: unknown) => e instanceof GateLockedError && /locked/.test((e as Error).message));
  }
  // Even from the demo stage with a passing demo record.
  const s = { ...validStrategy('XAUUSD', 'str_demo'), gate: 'demo' as const };
  const x = setup(undefined, s);
  x.engine.runDemoGate(s, demo());
  for (const allowLiveTrading of [false, true]) {
    assert.throws(() => x.engine.moveStage(s.id, 'live', { allowLiveTrading }), /locked/);
  }
  assert.equal(x.saved.get(s.id)!.gate, 'demo');
});

test('G-9: gate history can be added to but never changed', async () => {
  const { engine, store, strategy } = setup();
  const a = asAttempt(await engine.runBacktestGate(strategy, source));
  assert.throws(() => store.append({ ...a }), /already exists/);
  assert.throws(() => {
    (store.list(strategy.id)[0] as { passed: boolean }).passed = false;
  }, TypeError);
  assert.throws(() => {
    (store.list(strategy.id)[0].evidence as Record<string, number>).trades = 1;
  }, TypeError);
  assert.equal(store.list(strategy.id)[0].passed, true);

  // The database itself refuses to rewrite or remove a record.
  const sql = new SqliteGateStore();
  const row: GateAttempt = { ...a, id: 'sqlite-1', strategyId: 'sqlite-strategy' };
  sql.append(row);
  assert.throws(() => sql.append(row));
  assert.throws(() => db.prepare("UPDATE gate_history SET json = '{}' WHERE id = ?").run('sqlite-1'), /never changed/);
  assert.throws(() => db.prepare('DELETE FROM gate_history WHERE id = ?').run('sqlite-1'), /never changed/);
  assert.equal(sql.latest('sqlite-strategy')!.id, 'sqlite-1');
});

test('G-10: test strategies never appear on the Testboard', () => {
  const store = new MemoryGateStore();
  const real = validStrategy('XAUUSD', 'real');
  const rig = { ...validStrategy('XAUUSD', 'rig'), isTest: true };
  const rows = testboardRows([real, rig], store);
  assert.deepEqual(rows.map((r) => r.strategyId), ['real']);
  assert.equal(rows[0].stage, 'backtest');
  assert.equal(rows[0].latest, null);
});

test('a strategy that breaks the rules fails the gate without being run', async () => {
  const bad = { ...validStrategy(), risk: { ...validStrategy().risk, slMode: 'none' as const } };
  let ran = false;
  const store = new MemoryGateStore();
  const engine = new GateEngine({
    store,
    strategies: { get: () => bad, save: (s) => s },
    backtest: (() => { ran = true; return { trades: [] }; }) as unknown as typeof runBacktest,
  });
  const a = asAttempt(await engine.runBacktestGate(bad, source));
  assert.equal(a.passed, false);
  assert.equal(ran, false);
  assert.ok(a.reasons.length > 0);
});
