import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatProposal, Strategy, YoutubeAgentResult, YoutubeGate, YoutubeResult } from '../types';
import { agentOutcome, canAskStrategist, canPropose, gateLine, resultHeadline, truncatedNote } from './youtube';

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

const agent = (o: Partial<YoutubeAgentResult> = {}): YoutubeAgentResult => ({ videoId: 'abc', reply: 'ok', proposals: [], rejected: [], transcriptChars: 1000, truncated: false, ...o });

test('YM-5 a Strategist proposal is reported as waiting for Approve; no proposal or a refusal is a warning with the reason', () => {
  const ok = agentOutcome(agent({ proposals: [{ id: 'p' } as ChatProposal] }));
  assert.equal(ok.tone, 'good');
  assert.match(ok.title, /1 proposal sent to your Inbox/);
  assert.match(ok.title, /Nothing is saved or started until you do/);
  const refused = agentOutcome(agent({ rejected: ['Invalid strategy: no stop.'] }));
  assert.equal(refused.tone, 'warning');
  assert.match(refused.title, /Invalid strategy: no stop\./);
  const none = agentOutcome(agent());
  assert.equal(none.tone, 'warning');
  assert.match(none.title, /did not create a strategy/);
});

test('YM-6 the Strategist is offered only after the rule reader gave up, and a cut transcript is said out loud', () => {
  assert.equal(canAskStrategist(result({ status: 'needs_review', candidateId: null, strategy: null })), true);
  assert.equal(canAskStrategist(result()), false);
  assert.equal(canAskStrategist(null), false);
  assert.equal(truncatedNote(agent()), null);
  assert.match(truncatedNote(agent({ truncated: true, transcriptChars: 90000 }))!, /90000 characters.*only the first part/);
});
