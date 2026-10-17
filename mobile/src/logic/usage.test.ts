import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentLabel, capLine, capTone, costLabel, dayLabel, groupLine, tokensLabel } from './usage';

test('token counts are short and readable', () => {
  assert.equal(tokensLabel(950), '950');
  assert.equal(tokensLabel(1200), '1.2k');
  assert.equal(tokensLabel(12_400), '12k');
  assert.equal(tokensLabel(2_300_000), '2.3M');
  assert.equal(costLabel(0.836), '$0.84');
});

test('a group reads as one line', () => {
  assert.equal(groupLine({ calls: 1, totalTokens: 450, costUsd: 0.03 }), '1 call · 450 tokens · $0.03');
  assert.equal(groupLine({ calls: 12, totalTokens: 12_400, costUsd: 0.836 }), '12 calls · 12k tokens · $0.84');
});

test('the daily limit line says how much is left, and says plainly when it has stopped', () => {
  assert.equal(capLine({ day: 'd', used: 7, cap: 40, signedOut: false }), '7 of 40 automatic calls used today');
  assert.match(capLine({ day: 'd', used: 40, cap: 40, signedOut: false }), /All 40 automatic calls are used.*00:00 UTC/);
  assert.match(capLine({ day: 'd', used: 3, cap: 40, signedOut: true }), /not signed in/);
  assert.equal(capTone({ day: 'd', used: 7, cap: 40, signedOut: false }), 'neutral');
  assert.equal(capTone({ day: 'd', used: 33, cap: 40, signedOut: false }), 'warning');
  assert.equal(capTone({ day: 'd', used: 40, cap: 40, signedOut: false }), 'critical');
  assert.equal(capTone({ day: 'd', used: 0, cap: 40, signedOut: true }), 'critical');
});

test('agent and day labels', () => {
  assert.equal(agentLabel('evolve'), 'Auto-evolve');
  assert.equal(agentLabel('optimizer'), 'Optimizer');
  assert.equal(dayLabel('2026-10-07'), '7 Oct');
});
