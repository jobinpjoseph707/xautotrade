/**
 * Saved chats. Test IDs CS-1 to CS-8 are from docs/plan/xautotrade-test-plan.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { fakeBackend, makeHost, validStrategy } from '../testkit/index.js';
import type { Proposal } from './actions.js';
import { ChatService } from './service.js';
import { ChatSessions, chatInSession, HISTORY_TURNS, MAX_MESSAGES, MAX_SESSIONS, NEW_TITLE, SessionError, TITLE_MAX, withLiveProposals } from './sessions.js';

let t = 1000;
const mem = () => {
  t = 1000;
  return new ChatSessions(new Database(':memory:'), () => (t += 10));
};
const reply = (text = 'ok', extra: Partial<{ proposals: Proposal[]; rejected: string[] }> = {}) => ({ reply: text, agentName: 'Optimizer', proposals: [], rejected: [], ...extra });

test('CS-1 the Agents tab and each strategy have their own chats, newest first', () => {
  const s = mem();
  const a = s.create(null);
  const b = s.create('str_1');
  const c = s.create(null);
  s.append(a.id, [{ role: 'user', text: 'older but just used' }]);
  assert.deepEqual(s.list(null).map((x) => x.id), [a.id, c.id], 'the Agents tab: most recently used first, no strategy chats');
  assert.deepEqual(s.list('str_1').map((x) => x.id), [b.id]);
  assert.deepEqual(s.list('str_2'), []);
  assert.equal(s.list().length, 3, 'no filter = every chat');
});

test('CS-2 a chat is named after the first thing said, and can be renamed', () => {
  const s = mem();
  const c = s.create(null);
  assert.equal(c.title, NEW_TITLE);
  const long = 'Why is my gold scalper not trading since the broker clock drifted? '.repeat(3);
  const after = s.append(c.id, [{ role: 'user', text: `  ${long}  ` }, { role: 'agent', text: 'Because…' }]);
  assert.ok(after.title.length <= TITLE_MAX);
  assert.ok(after.title.endsWith('…'));
  assert.ok(after.title.startsWith('Why is my gold scalper'));
  s.append(c.id, [{ role: 'user', text: 'second question' }]);
  assert.equal(s.get(c.id)!.title, after.title, 'later messages do not rename it');
  assert.equal(s.rename(c.id, '  Clock drift  ').title, 'Clock drift');
  assert.throws(() => s.rename(c.id, '   '), /name/);
  assert.throws(() => s.rename('nope', 'x'), /no longer exists/);
  s.rename(c.id, 'Mine');
  s.append(c.id, [{ role: 'user', text: 'more' }]);
  assert.equal(s.get(c.id)!.title, 'Mine', 'a name you chose is kept');
});

test('CS-3 chats survive a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'xat-chat-')), 'chats.db');
  const first = new ChatSessions(new Database(file));
  const c = first.create('str_1');
  first.append(c.id, [{ role: 'user', text: 'tune the stop' }, { role: 'agent', text: 'Widen it by 20.', agentName: 'Optimizer', rejected: ['x'] }]);
  const second = new ChatSessions(new Database(file));
  const back = second.get(c.id)!;
  assert.equal(back.strategyId, 'str_1');
  assert.deepEqual(back.messages.map((m) => m.text), ['tune the stop', 'Widen it by 20.']);
  assert.deepEqual(back.messages[1].rejected, ['x']);
  assert.equal(second.list('str_1')[0].preview, 'Widen it by 20.');
});

test('CS-4 an agent is shown only the last few turns of its own chat, as plain text', () => {
  const s = mem();
  const c = s.create(null);
  s.append(c.id, Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? ('agent' as const) : ('user' as const), text: `m${i}`, proposals: [] })));
  const h = s.history(c.id);
  assert.equal(h.length, HISTORY_TURNS);
  assert.deepEqual(h[h.length - 1], { role: 'agent', text: 'm29' });
  assert.deepEqual(Object.keys(h[0]).sort(), ['role', 'text']);
  assert.deepEqual(s.history('nope'), []);
});

test('CS-5 a message in a chat: the agent sees that chat\'s history, and both sides are saved after it answers', async () => {
  const s = mem();
  const c = s.create(null);
  const seen: unknown[] = [];
  await chatInSession(s, { sessionId: c.id, message: 'first', agent: 'optimizer' }, async (i) => (seen.push(i.history), reply('one')));
  await chatInSession(s, { sessionId: c.id, message: 'second' }, async (i) => (seen.push(i.history), reply('two')));
  assert.deepEqual(seen[0], []);
  assert.deepEqual(seen[1], [{ role: 'user', text: 'first' }, { role: 'agent', text: 'one' }]);
  assert.deepEqual(s.get(c.id)!.messages.map((m) => `${m.role}:${m.text}`), ['user:first', 'agent:one', 'user:second', 'agent:two']);
  assert.equal(s.get(c.id)!.messages[1].agentName, 'Optimizer');

  await assert.rejects(() => chatInSession(s, { sessionId: c.id, message: 'boom' }, async () => { throw new Error('Claude is not signed in'); }), /not signed in/);
  assert.equal(s.get(c.id)!.messages.length, 4, 'a failed call leaves the chat as it was');

  await chatInSession(s, { sessionId: c.id, button: 'tune' }, async () => reply('tuned'));
  assert.equal(s.get(c.id)!.messages.at(-2)!.text, '(tune)', 'a button press is saved as what was pressed');
});

test('CS-5 a chat is used only where it belongs, and an unknown chat is refused', async () => {
  const s = mem();
  const tab = s.create(null);
  const strat = s.create('str_1');
  const ask = async () => reply();
  await assert.rejects(() => chatInSession(s, { sessionId: tab.id, strategyId: 'str_1', message: 'x' }, ask), (e) => e instanceof SessionError && e.status === 400);
  await assert.rejects(() => chatInSession(s, { sessionId: strat.id, message: 'x' }, ask), (e) => e instanceof SessionError && e.status === 400);
  await assert.rejects(() => chatInSession(s, { sessionId: strat.id, strategyId: 'str_2', message: 'x' }, ask), /belongs somewhere else/);
  await assert.rejects(() => chatInSession(s, { sessionId: 'nope', message: 'x' }, ask), (e) => e instanceof SessionError && e.status === 404);
  await chatInSession(s, { sessionId: strat.id, strategyId: 'str_1', message: 'ok' }, ask);
  assert.equal(s.get(strat.id)!.messages.length, 2);
  assert.equal(s.get(tab.id)!.messages.length, 0, 'nothing leaked into the other chat');
});

test('CS-6 a proposal in an old chat shows what has been decided since', () => {
  const s = mem();
  const c = s.create(null);
  const p = { id: 'p1', status: 'pending', summary: 'Widen stop', warnings: [], agent: 'optimizer', createdAt: 1, action: { type: 'stop_bot', id: 'x' } } as Proposal;
  s.append(c.id, [{ role: 'agent', text: 'I propose', proposals: [p] }]);
  const fresh = withLiveProposals(s.get(c.id)!, (id) => (id === 'p1' ? { ...p, status: 'approved', resultMessage: 'Applied.' } : null));
  assert.equal(fresh.messages[0].proposals![0].status, 'approved');
  assert.equal(fresh.messages[0].proposals![0].resultMessage, 'Applied.');
  assert.equal(s.get(c.id)!.messages[0].proposals![0].status, 'pending', 'the saved copy is not rewritten');
  assert.equal(withLiveProposals(s.get(c.id)!, () => null).messages[0].proposals![0].status, 'pending', 'unknown to the learning log: left as it was');
});

test('CS-7 deleting a chat removes it; there is a cap on chats and on messages in one chat', () => {
  const s = mem();
  const c = s.create(null);
  assert.equal(s.remove(c.id), true);
  assert.equal(s.remove(c.id), false);
  assert.equal(s.get(c.id), null);

  const big = s.create(null);
  s.append(big.id, Array.from({ length: MAX_MESSAGES + 25 }, (_, i) => ({ role: 'user' as const, text: `m${i}` })));
  const kept = s.get(big.id)!.messages;
  assert.equal(kept.length, MAX_MESSAGES);
  assert.equal(kept[kept.length - 1].text, `m${MAX_MESSAGES + 24}`, 'the oldest go first');

  for (let i = 0; i < MAX_SESSIONS + 5; i++) s.create(null);
  assert.equal(s.list().length, MAX_SESSIONS);
});

test('CS-8 in a strategy\'s chat the agent is shown the saved turns, not another strategy\'s', async () => {
  const gold = validStrategy('XAUUSD', 'str_gold');
  const eur = validStrategy('EURUSD', 'str_eur');
  const backend = fakeBackend('Fine.');
  const service = new ChatService({ backend, host: makeHost([gold, eur]).host, bots: () => [], issues: () => [] });
  await service.chat({ agent: 'doctor', strategyId: 'str_gold', message: 'next', savedHistory: [{ role: 'user', text: 'SECRET-GOLD-TALK' }, { role: 'agent', text: 'noted' }] });
  assert.ok(backend.prompts.at(-1)!.includes('SECRET-GOLD-TALK'), 'the saved turns reach the agent');
  await service.chat({ agent: 'doctor', strategyId: 'str_eur', message: 'hello', savedHistory: [] });
  assert.ok(!backend.prompts.at(-1)!.includes('SECRET-GOLD-TALK'), 'and only that chat\'s own');
});
