import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ChatService } from '../chat/service.js';
import type { LogEntry } from '../store.js';
import { fakeBackend, makeHost, validStrategy } from '../testkit/index.js';
import { attachInboxFeed, LOSING_STREAK } from './feed.js';
import { Inbox, MemoryInboxStore } from './inbox.js';
import { proposalFeed } from './proposals.js';

function clockInbox() {
  let t = 1_000;
  const inbox = new Inbox(new MemoryInboxStore(), {}, () => (t += 10));
  return inbox;
}

// I-1
test('an item is added, listed newest first, and leaves the list when acted on', async () => {
  const inbox = clockInbox();
  const a = inbox.raise({ kind: 'digest', title: 'first' }).item;
  const b = inbox.raise({ kind: 'losing_streak', title: 'second' }).item;
  assert.deepEqual(inbox.list().map((i) => i.title), ['second', 'first']);
  const closed = await inbox.act(b.id, 'dismiss');
  assert.equal(closed.status, 'dismissed');
  assert.deepEqual(inbox.list().map((i) => i.id), [a.id], 'dismissed items are no longer open');
  assert.deepEqual(inbox.list('dismissed').map((i) => i.id), [b.id]);
  assert.equal(inbox.openCount(), 1);
});

// I-2
test('acting on the same item twice is refused', async () => {
  const inbox = clockInbox();
  const item = inbox.raise({ kind: 'digest', title: 'x' }).item;
  await inbox.act(item.id, 'dismiss');
  await assert.rejects(() => inbox.act(item.id, 'dismiss'), /already dismissed/);
  await assert.rejects(() => inbox.act('missing', 'dismiss'), /no longer exists/);
});

test('a card only offers the buttons that belong to it', async () => {
  const inbox = clockInbox();
  const p = inbox.raise({ kind: 'proposal', title: 'p', ref: 'abc' }).item;
  assert.deepEqual(p.actions, ['approve', 'reject']);
  await assert.rejects(() => inbox.act(p.id, 'dismiss'), /not available on this card/);
  await assert.rejects(() => inbox.act(p.id, 'restart'), /not available on this card/);
  const g = inbox.raise({ kind: 'gate_result', title: 'g' }).item;
  await assert.rejects(() => inbox.act(g.id, 'stage'), /not available yet/);
});

function proposalSetup(reply: string, initial = [validStrategy('XAUUSD', 'str_valid')]) {
  const { host, db, calls } = makeHost(initial);
  const inbox = clockInbox();
  const svc = new ChatService({ backend: fakeBackend(reply), host, bots: () => [], issues: () => [], inbox: proposalFeed(inbox) });
  inbox.setHandlers({ approveProposal: (id) => svc.approve(id), rejectProposal: (id) => svc.reject(id) });
  return { svc, inbox, db, calls };
}
const block = (actions: unknown) => `Here.\n\n\`\`\`xat-actions\n${JSON.stringify(actions)}\n\`\`\``;
const lowerLot = block([{ type: 'update_strategy', id: 'str_valid', changes: { risk: { fixedLot: 0.01 } }, reason: 'smaller size' }]);

// I-3
test('a new proposal writes exactly one inbox item that points to it', async () => {
  const { svc, inbox } = proposalSetup(lowerLot);
  const r = await svc.chat({ agent: 'guard', message: 'make it smaller' });
  assert.equal(r.proposals.length, 1);
  const items = inbox.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'proposal');
  assert.equal(items[0].ref, r.proposals[0].id);
  assert.equal(items[0].strategyId, 'str_valid');
  assert.match(items[0].body, /smaller size/);
});

// I-4
test('approving from the inbox applies the proposal once', async () => {
  const { svc, inbox, calls, db } = proposalSetup(lowerLot);
  const r = await svc.chat({ agent: 'guard', message: 'x' });
  const item = inbox.list()[0];
  const done = await inbox.act(item.id, 'approve');
  assert.equal(done.status, 'done');
  assert.match(done.outcome ?? '', /Updated/);
  assert.equal(calls.filter((c) => c === 'save:str_valid').length, 1, 'saved once');
  assert.equal(db.get('str_valid')!.risk.fixedLot, 0.01);
  await assert.rejects(() => inbox.act(item.id, 'approve'), /already done/);
  await assert.rejects(() => svc.approve(r.proposals[0].id), /already approved/);
  assert.equal(calls.filter((c) => c === 'save:str_valid').length, 1, 'still saved once');
});

// I-5
test('rejecting from the inbox changes nothing', async () => {
  const { svc, inbox, calls, db } = proposalSetup(lowerLot);
  await svc.chat({ agent: 'guard', message: 'x' });
  const before = JSON.stringify([...db.values()]);
  const done = await inbox.act(inbox.list()[0].id, 'reject');
  assert.equal(done.status, 'done');
  assert.deepEqual(calls, [], 'the host was never touched');
  assert.equal(JSON.stringify([...db.values()]), before);
  assert.equal(svc.pending().length, 0);
});

test('a proposal decided in the Agents tab closes its inbox card', async () => {
  const { svc, inbox } = proposalSetup(lowerLot);
  const r = await svc.chat({ agent: 'guard', message: 'x' });
  await svc.approve(r.proposals[0].id);
  assert.equal(inbox.list().length, 0);
  assert.equal(inbox.list('done').length, 1);
});

test('a proposal that cannot be applied closes its card and says why', async () => {
  const { svc, inbox, db } = proposalSetup(lowerLot);
  await svc.chat({ agent: 'guard', message: 'x' });
  db.delete('str_valid'); // removed before approval
  const done = await inbox.act(inbox.list()[0].id, 'approve');
  assert.match(done.outcome ?? '', /Could not apply it/);
});

// I-6
test('the same stall on the same strategy does not create a second open item', () => {
  const inbox = clockInbox();
  const first = inbox.raise({ kind: 'stall', strategyId: 's1', dedupeKey: 'stall:s1', title: 'no bars' });
  const again = inbox.raise({ kind: 'stall', strategyId: 's1', dedupeKey: 'stall:s1', title: 'no bars', body: 'still nothing' });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);
  assert.equal(again.item.count, 2);
  assert.equal(inbox.list().length, 1);
  inbox.raise({ kind: 'stall', strategyId: 's2', dedupeKey: 'stall:s2', title: 'other strategy' });
  assert.equal(inbox.list().length, 2, 'a different strategy is a different problem');
});

test('once a stall card is closed, the same problem later opens a new card', async () => {
  const inbox = clockInbox();
  const a = inbox.raise({ kind: 'stall', strategyId: 's1', dedupeKey: 'stall:s1', title: 't' }).item;
  await inbox.act(a.id, 'dismiss');
  const b = inbox.raise({ kind: 'stall', strategyId: 's1', dedupeKey: 'stall:s1', title: 't' });
  assert.equal(b.created, true);
  assert.notEqual(b.item.id, a.id);
});

test('restart runs the bot restart for the card strategy and nothing else', async () => {
  const restarted: string[] = [];
  const inbox = new Inbox(new MemoryInboxStore(), { restartBot: async (id) => void restarted.push(id) });
  const item = inbox.raise({ kind: 'error', strategyId: 'bot1', title: 'e' }).item;
  const done = await inbox.act(item.id, 'restart');
  assert.deepEqual(restarted, ['bot1']);
  assert.equal(done.outcome, 'Bot restarted.');
  const noBot = inbox.raise({ kind: 'error', title: 'server error' }).item;
  await assert.rejects(() => inbox.act(noBot.id, 'restart'), /not about a bot/);
});

// --- the feed from the bots' log stream -------------------------------------------

let n = 0;
const entry = (over: Partial<LogEntry>): LogEntry => ({ id: ++n, ts: 1, strategyId: 'bot1', level: 'info', event: 'x', message: 'm', ...over });
const close = (profit: number) => entry({ level: 'trade', event: 'position_closed', data: { profit } });

function feed() {
  const bus = new EventEmitter();
  const inbox = clockInbox();
  attachInboxFeed(bus, inbox, (id) => `Name of ${id}`);
  return { bus, inbox, emit: (e: LogEntry) => bus.emit('log', e) };
}

test('a bot error becomes one critical card, repeats are counted, and starting the bot closes it', () => {
  const { inbox, emit } = feed();
  emit(entry({ level: 'error', event: 'tick_failed', message: 'broker timeout' }));
  emit(entry({ level: 'error', event: 'tick_failed', message: 'broker timeout again' }));
  const open = inbox.list();
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'error');
  assert.equal(open[0].severity, 'critical');
  assert.equal(open[0].count, 2);
  assert.match(open[0].title, /Name of bot1/);
  emit(entry({ event: 'bot_start' }));
  assert.equal(inbox.list().length, 0);
  assert.equal(inbox.list('done')[0].outcome, 'The bot started again.');
});

test('losing streak: four losses raise nothing, the fifth does, a win ends it', () => {
  const { inbox, emit } = feed();
  for (let i = 0; i < LOSING_STREAK - 1; i++) emit(close(-1));
  assert.equal(inbox.list().length, 0);
  emit(close(-1));
  assert.equal(inbox.list()[0].kind, 'losing_streak');
  emit(close(-1));
  assert.equal(inbox.list()[0].count, 2, 'the same streak is one card');
  emit(close(2));
  assert.equal(inbox.list().length, 0, 'a win closes the card');
  for (let i = 0; i < LOSING_STREAK - 1; i++) emit(close(-1));
  assert.equal(inbox.list().length, 0, 'the count starts again after a win');
});

test('ordinary info and trade log lines never reach the inbox', () => {
  const { inbox, emit } = feed();
  emit(entry({ level: 'info', event: 'day_reset' }));
  emit(entry({ level: 'trade', event: 'entry', message: 'Opened LONG' }));
  emit(entry({ level: 'warn', event: 'sizing' }));
  assert.equal(inbox.list().length, 0);
});
