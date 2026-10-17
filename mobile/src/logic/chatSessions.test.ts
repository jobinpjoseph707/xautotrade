import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSessions, sessionWhen, messageCountLabel, istDay } from './chatSessions';
import type { ChatSessionSummary } from '../types';

const mk = (id: string, updatedAt: number, n = 2): ChatSessionSummary => ({
  id, title: id, strategyId: null, createdAt: updatedAt, updatedAt, messageCount: n, preview: '',
});
// 17 Oct 2026, 12:00 IST
const NOW = Date.UTC(2026, 9, 17, 6, 30);
const H = 3600_000;

test('CS-M1 groups by IST day, newest first', () => {
  const g = groupSessions([mk('old', NOW - 5 * 24 * H), mk('today1', NOW - H), mk('yest', NOW - 20 * H), mk('today2', NOW - 2 * H)], NOW);
  assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', 'Earlier']);
  assert.deepEqual(g[0].sessions.map((s) => s.id), ['today1', 'today2']);
});

test('CS-M2 midnight follows India, not UTC', () => {
  // 00:30 IST on the 17th is 19:00 UTC on the 16th — still "today" for an IST user
  const justAfterMidnightIst = Date.UTC(2026, 9, 16, 19, 0);
  assert.equal(istDay(justAfterMidnightIst), istDay(NOW));
  assert.equal(groupSessions([mk('a', justAfterMidnightIst)], NOW)[0].label, 'Today');
});

test('CS-M3 empty groups are left out; labels', () => {
  assert.deepEqual(groupSessions([], NOW), []);
  assert.equal(messageCountLabel(1), '1 message');
  assert.equal(messageCountLabel(4), '4 messages');
  assert.match(sessionWhen(NOW - H, NOW), /^\d\d:\d\d$/);
  assert.match(sessionWhen(NOW - 3 * 24 * H, NOW), /Oct/);
});

import { patchProposal, type ChatMsg } from '../screens/useChatSession';
test('CS-M4 patchProposal updates only the matching proposal', () => {
  const prop = (id: string, status: string) => ({ id, status, summary: id }) as never;
  const msgs: ChatMsg[] = [
    { id: 'a', role: 'user', text: 'hi', at: 1 },
    { id: 'b', role: 'agent', text: 'x', at: 2, proposals: [prop('p1', 'pending'), prop('p2', 'pending')] },
  ];
  const out = patchProposal(msgs, 'p1', { status: 'approved' } as never);
  assert.equal((out[1].proposals![0] as { status: string }).status, 'approved');
  assert.equal((out[1].proposals![1] as { status: string }).status, 'pending');
  assert.equal(out[0], msgs[0]);
  assert.equal((msgs[1].proposals![0] as { status: string }).status, 'pending');
});
