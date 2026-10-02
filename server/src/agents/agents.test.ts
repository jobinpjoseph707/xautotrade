import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateWeek, maxDrawdownPctFromEquity } from './evaluate.js';
import { closeOutWeek, startFirstAgent } from './rotation.js';
import { MemoryAgentStore } from './store.js';
import { runWeekOnPaper } from './paperRunner.js';
import { emaPullbackScalp } from '../engine/presets.js';
import type { SuccessCriteria, WeekOutcome } from './types.js';

const criteria: SuccessCriteria = { minReturnPct: 2, maxDrawdownPct: 5 };
const quiet = () => {};
const T0 = new Date('2026-09-14T00:00:00Z');

function outcome(over: Partial<WeekOutcome> = {}): WeekOutcome {
  return {
    startingBalance: 10_000,
    endingBalance: 10_300, // +3%
    equityCurve: [
      { time: 1, equity: 10_100 },
      { time: 2, equity: 10_300 },
    ],
    tradeCount: 5,
    ...over,
  };
}

function setup() {
  const store = new MemoryAgentStore();
  const agent = startFirstAgent(store, emaPullbackScalp('XAUUSD'), 10_000, T0);
  return { store, agent };
}

test('agent beating both thresholds passes and its config carries over unchanged', () => {
  const { store, agent } = setup();
  const { record, next } = closeOutWeek(store, agent, outcome(), criteria, quiet);
  assert.equal(record.verdict, 'pass');
  assert.equal(next.agentId, agent.agentId);
  assert.deepEqual(next.strategy, agent.strategy);
  assert.equal(next.startingBalance, 10_300);
  assert.equal(next.weekStart, agent.weekEnd);
});

test('missing the return threshold fails and spawns a new agent', () => {
  const { store, agent } = setup();
  const logs: string[] = [];
  const { record, next } = closeOutWeek(store, agent, outcome({ endingBalance: 10_050 }), criteria, (m) => logs.push(m));
  assert.equal(record.verdict, 'fail');
  assert.notEqual(next.agentId, agent.agentId);
  assert.equal(next.generation, 2);
  assert.equal(next.parentAgentId, agent.agentId);
  assert.ok(logs.some((l) => l.includes('would modify strategy here')));
});

test('breaching the drawdown limit fails even when return is good', () => {
  const { store, agent } = setup();
  const o = outcome({
    endingBalance: 10_400,
    equityCurve: [
      { time: 1, equity: 10_200 },
      { time: 2, equity: 9_600 }, // (10200-9600)/10200 = 5.88%
      { time: 3, equity: 10_400 },
    ],
  });
  const { record, next } = closeOutWeek(store, agent, o, criteria, quiet);
  assert.equal(record.verdict, 'fail');
  assert.ok(record.maxDrawdownPct > 5);
  assert.equal(next.generation, 2);
});

test('zero-trade week is its own verdict and does not crash', () => {
  const { store, agent } = setup();
  const { record, next } = closeOutWeek(
    store,
    agent,
    outcome({ tradeCount: 0, endingBalance: 10_000, equityCurve: [] }),
    criteria,
    quiet,
  );
  assert.equal(record.verdict, 'no_trades');
  assert.notEqual(record.verdict, 'pass');
  assert.notEqual(record.verdict, 'fail');
  assert.equal(next.agentId, agent.agentId);
  assert.deepEqual(next.strategy, agent.strategy);
});

test('a written record is immutable and a second close-out does not double count', () => {
  const { store, agent } = setup();
  const first = closeOutWeek(store, agent, outcome({ endingBalance: 10_050 }), criteria, quiet);
  assert.equal(first.alreadyClosed, false);

  // Re-run with a DIFFERENT outcome: the stored verdict must not change.
  const second = closeOutWeek(store, agent, outcome({ endingBalance: 11_000 }), criteria, quiet);
  assert.equal(second.alreadyClosed, true);
  assert.equal(second.record.verdict, 'fail');
  assert.equal(second.record.endingBalance, 10_050);
  assert.equal(store.allRecords().length, 1);
  assert.equal(second.next.agentId, first.next.agentId, 'no second successor spawned');

  assert.throws(() => store.appendRecord({ ...first.record }), /already exists/);
  assert.throws(() => {
    (store.allRecords()[0] as { verdict: string }).verdict = 'pass';
  }, TypeError);
});

test('drawdown is measured on equity, not balance, and catches a mid-week dip that recovers', () => {
  // Balance never moves (no closed trades) but equity dips 8% and recovers to +3%.
  const curve = [
    { time: 1, equity: 10_000 },
    { time: 2, equity: 9_200 },
    { time: 3, equity: 10_300 },
  ];
  assert.ok(Math.abs(maxDrawdownPctFromEquity(10_000, curve) - 8) < 1e-9);

  const ev = evaluateWeek(
    { startingBalance: 10_000, endingBalance: 10_300, equityCurve: curve, tradeCount: 3 },
    criteria,
  );
  assert.equal(ev.verdict, 'fail'); // return +3% is fine; drawdown 8% is not
  assert.ok(Math.abs(ev.maxDrawdownPct - 8) < 1e-9);

  // Peak is running: a dip after a new high is measured from that high.
  const dd = maxDrawdownPctFromEquity(10_000, [
    { time: 1, equity: 11_000 },
    { time: 2, equity: 10_450 },
  ]);
  assert.ok(Math.abs(dd - 5) < 1e-9);
});

test('paper runner works end to end and never needs a live broker', async () => {
  const { store, agent } = setup();
  const o = await runWeekOnPaper(agent);
  assert.ok(o.equityCurve.length > 0);
  const { record } = closeOutWeek(store, agent, o, criteria, quiet);
  assert.ok(['pass', 'fail', 'no_trades'].includes(record.verdict));
});
