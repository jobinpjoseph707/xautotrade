import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canRunTest, progressLabel, reasonsToShow, stageState, verdictLine, verdictTone } from './testboard';
import type { TestboardEntry } from '../types';

const entry = (o: Partial<TestboardEntry> = {}): TestboardEntry => ({
  strategyId: 's', name: 'S', symbol: 'EURUSD', gate: 'backtest', stage: 'backtest', latest: null, progress: null, waiting: false, ...o,
});
const demo = (trades: number, o: Partial<TestboardEntry> = {}) =>
  entry({ stage: 'demo', gate: 'demo', progress: { trades, tradesNeeded: 100, days: 2, daysNeeded: 7 }, ...o });
const verdict = (v: 'pass' | 'fail' | 'not_enough_evidence', reasons: string[] = []) => ({ verdict: v, passed: v === 'pass', reasons, at: 1 });

// TB-1
test('TB-1 a demo strategy with 40 trades reads "40 / 100 trades" and "Not enough trades yet"', () => {
  assert.equal(progressLabel(demo(40)), '40 / 100 trades');
  assert.equal(verdictLine(demo(40)), 'Not enough trades yet');
  // an older pass does not hide thin evidence
  assert.equal(verdictLine(demo(40, { latest: verdict('pass') })), 'Not enough trades yet');
  assert.equal(progressLabel(entry()), null);
});

// TB-2
test('TB-2 every verdict has one plain line, and the live stage is a padlock with no test button', () => {
  assert.equal(verdictLine(entry()), 'Not tested yet');
  assert.equal(verdictLine(entry({ latest: verdict('pass') })), 'Passed.');
  assert.match(verdictLine(entry({ latest: verdict('pass'), waiting: true })), /Move to next stage/);
  assert.equal(verdictLine(entry({ latest: verdict('not_enough_evidence') })), 'Not enough trades yet');
  assert.equal(verdictLine(entry({ latest: verdict('fail', ['a']) })), 'Did not pass');
  assert.match(verdictLine(entry({ stage: 'live', gate: 'live' })), /Locked/);
  assert.equal(canRunTest(entry({ stage: 'live', gate: 'live' })), false);
  assert.equal(canRunTest(entry()), true);
  assert.equal(stageState('demo', 'live'), 'locked');
  assert.equal(stageState('live', 'live'), 'locked');
});

// TB-3
test('TB-3 stages read done, current, later in order, and reasons show only for a miss', () => {
  assert.deepEqual((['backtest', 'paper', 'demo', 'live'] as const).map((s) => stageState('paper', s)), ['done', 'current', 'later', 'locked']);
  const miss = entry({ latest: verdict('fail', ['one', 'two', 'three', 'four']) });
  assert.deepEqual(reasonsToShow(miss), ['one', 'two', 'three']);
  assert.deepEqual(reasonsToShow(entry({ latest: verdict('pass', ['x']) })), []);
  assert.equal(verdictTone(miss), 'critical');
  assert.equal(verdictTone(entry({ latest: verdict('pass') })), 'good');
  assert.equal(verdictTone(entry({ latest: verdict('not_enough_evidence') })), 'warning');
});
