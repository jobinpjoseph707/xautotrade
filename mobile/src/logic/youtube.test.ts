import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Strategy, YoutubeGate, YoutubeResult } from '../types';
import { canPropose, gateLine, resultHeadline } from './youtube';

const gate = (o: Partial<YoutubeGate> = {}): YoutubeGate => ({ passed: true, reasons: [], trades: 42, maxDrawdownPct: 4.26, profitFactor: 1.123, bars: 3000, ...o });
const result = (o: Partial<YoutubeResult> = {}): YoutubeResult => ({
  status: 'candidate', candidateId: 'yt_1', videoId: 'abc', strategy: { id: 's' } as Strategy, gaps: [], notes: [], gate: gate(), ...o,
});

test('YM-1 a passing gate line names the real candles and the numbers', () => {
  assert.equal(gateLine(gate()), 'Tested on 3000 real MT5 candles: 42 trades, profit factor 1.12, worst drawdown 4.3%.');
});

test('YM-2 a failing gate line gives the reasons, not the numbers', () => {
  const line = gateLine(gate({ passed: false, reasons: ['Only 3 trades (need at least 10).'] }));
  assert.match(line, /Did not hold up on real MT5 history/);
  assert.match(line, /Only 3 trades/);
});

test('YM-3 headlines: pass is not a promise, fail can still be reviewed, no rules is an error', () => {
  const pass = resultHeadline(result());
  assert.equal(pass.tone, 'good');
  assert.match(pass.detail, /not a promise/i);
  const fail = resultHeadline(result({ gate: gate({ passed: false, reasons: ['x'] }) }));
  assert.equal(fail.tone, 'warning');
  assert.match(fail.detail, /until you Approve/);
  const none = resultHeadline(result({ status: 'needs_review', candidateId: null, strategy: null, gate: null }));
  assert.equal(none.tone, 'critical');
});

test('YM-4 only a built candidate with an id can be sent to the Inbox', () => {
  assert.equal(canPropose(result()), true);
  assert.equal(canPropose(result({ candidateId: null })), false);
  assert.equal(canPropose(result({ status: 'needs_review', candidateId: null, strategy: null })), false);
  assert.equal(canPropose(null), false);
});
