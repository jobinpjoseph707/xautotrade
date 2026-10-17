import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SPEC, type Strategy } from '../engine/types.js';
import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import type { LogEntry } from '../store.js';
import { ScriptedBroker, flat, validStrategy } from '../testkit/index.js';
import { demoEvidence } from './demoEvidence.js';
import { GateService } from './service.js';
import { MemoryGateStore } from './store.js';
import { GateLockedError } from './types.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 10, 0, 0);

function closes(n: number, from: number, profit: (i: number) => number = (i) => (i % 3 === 0 ? -8 : 10)): LogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: from + i * 60_000, strategyId: 's', level: 'trade' as const, event: 'position_closed', message: 'x', data: { positionId: `p${i}`, profit: profit(i) },
  }));
}

function setup(initial: Strategy[], logsFor: (id: string) => LogEntry[] = () => []) {
  const store = new MemoryGateStore();
  const inbox = new Inbox(new MemoryInboxStore());
  const db = new Map(initial.map((s) => [s.id, s]));
  const broker = new ScriptedBroker();
  broker.candles = flat(1000, 1.1);
  broker.spec = { ...DEFAULT_SPEC };
  const service = new GateService({
    broker: () => broker,
    savedOffset: () => 0,
    store,
    inbox,
    strategies: { list: () => [...db.values()], get: (id) => db.get(id) ?? null, save: (s) => (db.set(s.id, s), s) },
    tradesBetween: (id, from, to) => logsFor(id).filter((e) => e.ts >= from && e.ts < to),
    allowLiveTrading: () => true,
    now: () => NOW,
  });
  return { service, store, inbox, db, broker };
}

test('demoEvidence: profit factor, averages, drawdown and days come from the closed trades', () => {
  // +10, +10, -20, +10, +10 starting from 1000
  const profits = [10, 10, -20, 10, 10];
  const e = demoEvidence(closes(5, NOW - 2 * DAY, (i) => profits[i]), NOW - 3 * DAY, NOW, 1000);
  assert.equal(e.trades, 5);
  assert.equal(e.days, 3);
  assert.equal(e.profitFactor, 2);
  assert.equal(e.avgWin, 10);
  assert.equal(e.avgLoss, 20);
  // peak 1020, trough 1000 -> 1.96%
  assert.equal(e.maxDrawdownPct, 1.96);
  // trades before the stage began are not counted
  assert.equal(demoEvidence(closes(5, NOW - 2 * DAY), NOW - 1 * DAY, NOW, 1000).trades, 0);
  // nothing closed: nothing to judge
  assert.equal(demoEvidence([], 0, NOW, 1000).profitFactor, 0);
});

test('the Testboard row for a demo strategy shows trades so far, and the tests never use test strategies', () => {
  const real: Strategy = { ...validStrategy('EURUSD', 'real'), gate: 'demo' };
  const rig: Strategy = { ...validStrategy('EURUSD', 'rig'), isTest: true, gate: 'demo' };
  const { service } = setup([real, rig], () => closes(40, NOW - 5 * 60_000 * 40));
  const rows = service.rows();
  assert.deepEqual(rows.map((r) => r.strategyId), ['real']);
  assert.equal(rows[0].stage, 'demo');
  assert.equal(rows[0].gate, 'demo');
  assert.equal(rows[0].progress!.trades, 40);
  assert.equal(rows[0].progress!.tradesNeeded, 100);
  assert.equal(rows[0].progress!.daysNeeded, 7);
  assert.equal(rows[0].latest, null);
});

test('Running the demo gate with 40 trades says not enough evidence; the live stage cannot be run', async () => {
  const s: Strategy = { ...validStrategy('EURUSD', 'real'), gate: 'demo' };
  const { service, store } = setup([s], () => closes(40, NOW - DAY));
  const a = (await service.run('real')) as { verdict: string; reasons: string[] };
  assert.equal(a.verdict, 'not_enough_evidence');
  assert.match(a.reasons.join(' '), /40 demo trades/);
  assert.equal(store.list('real', 'demo').length, 1);

  const live: Strategy = { ...validStrategy('EURUSD', 'liv'), gate: 'live' };
  const l = setup([live]);
  await assert.rejects(() => l.service.run('liv'), GateLockedError);
  const rig: Strategy = { ...validStrategy('EURUSD', 'rig2'), isTest: true };
  await assert.rejects(() => setup([rig]).service.run('rig2'), /Test strategies/);
  await assert.rejects(() => service.run('missing'), /does not exist/);
});

test('Move to next stage moves exactly one stage after a pass; Keep moves nothing', async () => {
  const s: Strategy = { ...validStrategy('EURUSD', 'real'), gate: 'paper' };
  const { service, store, inbox, db } = setup([s]);
  inbox.setHandlers({ moveStage: (id) => service.moveNext(id) });

  // Not passed yet: refused.
  await assert.rejects(() => service.moveNext('real'), /has not been passed/);

  // A passing paper replay writes the card; the strategy has not moved.
  service.engine.runPaperGate(s, { passed: true, reasons: [], trades: [{}], ticks: 10 });
  assert.equal(store.latest('real', 'paper')!.passed, true);
  const card = inbox.list('open').find((i) => i.kind === 'gate_result')!;
  assert.equal(db.get('real')!.gate, 'paper');

  const done = await inbox.act(card.id, 'stage');
  assert.equal(done.status, 'done');
  assert.match(done.outcome ?? '', /Moved to demo/);
  assert.equal(db.get('real')!.gate, 'demo', 'one stage, to demo, never to live');

  // Keep on another card leaves the strategy where it is.
  const k: Strategy = { ...validStrategy('EURUSD', 'keep'), gate: 'paper' };
  const other = setup([k]);
  other.service.engine.runPaperGate(k, { passed: true, reasons: [], trades: [], ticks: 1 });
  const kc = other.inbox.list('open')[0];
  const kept = await other.inbox.act(kc.id, 'keep');
  assert.equal(kept.status, 'done');
  assert.equal(other.db.get('keep')!.gate, 'paper');
});

test('a failed paper replay is recorded as a fail and raises no card', () => {
  const s: Strategy = { ...validStrategy('EURUSD', 'real'), gate: 'paper' };
  const { service, store, inbox } = setup([s]);
  const a = service.engine.runPaperGate(s, { passed: false, reasons: ['Stop move illegal: x'], trades: [], ticks: 5 });
  assert.equal(a.verdict, 'fail');
  assert.equal(store.list('real', 'paper').length, 1);
  assert.equal(inbox.list('open').length, 0);
});
