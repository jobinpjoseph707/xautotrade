import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRun, WhyProposal } from '../types';
import { agentLabel, checklistRows, hasWhy, lessonsLine, MAX_POLL_MS, outcomeLabel, OUTCOME_LABEL, RUN_BUTTONS, shouldPoll, stepLine } from './agentRuns';

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'r', createdAt: 1000, strategyId: 's', strategyName: 'S', kind: 'tune', trigger: 'owner', status: 'running', steps: [], ...over,
});
const why = (over: Partial<WhyProposal['rationale']> = {}): WhyProposal => ({
  summary: 's',
  rationale: {
    trialId: 't', claim: 'c', disproof: 'profitFactor < 1 on unseen bars', lessonsUsed: [],
    checklist: { market: 'XAUUSD', timeframe: 'M5', marketState: 'volatility high', tier: 'demo', evidence: 'e', change: 'x', wouldProveWrong: 'w' },
    ...over,
  },
});

test('AG-14 (app) there is a button for diagnose and one for tune, each with a one-line hint', () => {
  assert.deepEqual(RUN_BUTTONS.map((b) => b.kind), ['diagnose', 'tune']);
  assert.ok(RUN_BUTTONS.every((b) => b.hint.length > 10));
});

test('AG-14 (app) every way a run can end has plain words, and an unknown one is not shown as a result', () => {
  for (const k of Object.keys(OUTCOME_LABEL)) assert.ok(outcomeLabel(k).length > 5);
  assert.equal(outcomeLabel(undefined), 'Still working');
  assert.equal(outcomeLabel('mystery'), 'Still working');
  assert.match(outcomeLabel('claude_unreachable'), /Claude could not be reached/);
});

test('AG-14 (app) the app keeps asking only while a run is going, and gives up after a quarter of an hour', () => {
  assert.equal(shouldPoll(run(), 2000), true);
  assert.equal(shouldPoll(run({ status: 'done' }), 2000), false);
  assert.equal(shouldPoll(run({ status: 'failed' }), 2000), false);
  assert.equal(shouldPoll(run(), 1000 + MAX_POLL_MS + 1), false);
  assert.equal(shouldPoll(null, 0), false);
});

test('steps read as "who: what" with a friendly name', () => {
  assert.equal(agentLabel('risk_guard'), 'Risk Guard');
  assert.equal(agentLabel('newcomer'), 'newcomer');
  assert.equal(stepLine({ agent: 'doctor', at: 1, text: 'Losses cluster at night.' }), 'Doctor: Losses cluster at night.');
});

test('P-6 "Why was this proposed?" shows all seven answers in a fixed order', () => {
  const rows = checklistRows(why());
  assert.deepEqual(rows.map((r) => r.label), ['Market', 'Timeframe', 'Market state', 'Tier', 'Evidence', 'The change', 'Would prove it wrong']);
  assert.equal(rows[0].value, 'XAUUSD');
});

test('lessons line says so when none applied', () => {
  assert.equal(lessonsLine(why()), 'No earlier lessons applied to this market.');
  assert.equal(lessonsLine(why({ lessonsUsed: ['a', 'b'] })), 'Lessons used: 2');
});

test('only proposal cards with a reference offer the reasoning link', () => {
  assert.equal(hasWhy({ kind: 'proposal', ref: 'p1' }), true);
  assert.equal(hasWhy({ kind: 'proposal' }), false);
  assert.equal(hasWhy({ kind: 'digest', ref: 'p1' }), false);
});
