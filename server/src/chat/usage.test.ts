import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import { chatUsage } from '../store.js';
import { fakeBackend, fakeClock } from '../testkit/index.js';
import { CallCapError, CappedBackend, ChatAuthError, parseCliOutput, UNATTENDED_DAILY_CAP, type ChatBackend } from './backend.js';
import { groupUsage } from './usage.js';

test('chatUsage: records add up and group by tag', () => {
  // A unique tag per run — the backing DB is a real (persistent) file shared
  // across the whole test process, so summing "since the beginning of time"
  // would pick up rows from other tests/runs. Filtering by tag isolates ours.
  const tag = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  chatUsage.add({ ts: now, tag, model: 'sonnet', inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
  chatUsage.add({ ts: now + 1, tag, model: 'sonnet', inputTokens: 20, outputTokens: 10 }); // no cost reported — should not crash
  chatUsage.add({ ts: now + 2, tag: 'other_tag', inputTokens: 1000, outputTokens: 1000, costUsd: 5 });

  const summary = chatUsage.summary(now - 1000);
  const mine = summary.byTag.find((b) => b.tag === tag);
  assert.ok(mine, 'tag group missing from summary');
  assert.equal(mine!.calls, 2);
  assert.equal(mine!.totalTokens, 100 + 50 + 20 + 10);
  assert.ok(Math.abs(mine!.costUsd - 0.01) < 1e-9);

  // A window that excludes everything we just wrote sees none of it.
  const empty = chatUsage.summary(now + 10_000);
  assert.equal(empty.byTag.find((b) => b.tag === tag), undefined);
});

const WED = Date.UTC(2026, 9, 7, 10, 0, 0);
const DAY = 86_400_000;

function capRig(inner: ChatBackend = fakeBackend('ok')) {
  const clock = fakeClock(WED);
  const kv = new Map<string, unknown>();
  const inbox = new Inbox(new MemoryInboxStore(), {}, clock.now);
  const capped = new CappedBackend(inner, {
    store: { get: <T>(k: string, f: T) => (kv.has(k) ? (kv.get(k) as T) : f), set: (k, v) => void kv.set(k, v) },
    inbox,
    clock: clock.now,
  });
  return { clock, inbox, capped };
}

// U-1
test('U-1 usage is grouped by day and by agent', () => {
  const rows = [
    { ts: WED, tag: 'optimizer', inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    { ts: WED + 1000, tag: 'router', inputTokens: 10, outputTokens: 5, costUsd: null },
    { ts: WED + 2000, tag: 'optimizer', inputTokens: 200, outputTokens: 100, costUsd: 0.02 },
    { ts: WED - DAY, tag: 'optimizer', inputTokens: 1000, outputTokens: 0, costUsd: 0.1 },
    { ts: WED - DAY, tag: null, inputTokens: 1, outputTokens: 1 },
  ];
  const g = groupUsage(rows);
  assert.deepEqual(g.byDay.map((d) => d.day), ['2026-10-07', '2026-10-06'], 'newest day first');
  assert.equal(g.byDay[0].calls, 3);
  assert.equal(g.byDay[0].totalTokens, 465);
  assert.ok(Math.abs(g.byDay[0].costUsd - 0.03) < 1e-9);
  assert.deepEqual(g.byDay[0].agents.map((a) => [a.agent, a.calls, a.totalTokens]), [['optimizer', 2, 450], ['router', 1, 15]]);
  assert.deepEqual(g.byDay[1].agents.map((a) => a.agent), ['optimizer', 'other'], 'a call with no label is "other"');
  assert.deepEqual(g.byAgent.map((a) => [a.agent, a.calls, a.totalTokens]), [['optimizer', 3, 1450], ['router', 1, 15], ['other', 1, 2]]);
  assert.deepEqual(groupUsage([]), { byDay: [], byAgent: [] });
});

// U-2
test('U-2 the 41st unattended call in a day is refused', async () => {
  const inner = fakeBackend('ok');
  const { capped, inbox } = capRig(inner);
  assert.equal(UNATTENDED_DAILY_CAP, 40);
  for (let i = 0; i < 40; i++) await capped.complete('p', { unattended: true, tag: 'evolve' });
  assert.equal(inner.prompts.length, 40);
  await assert.rejects(() => capped.complete('p', { unattended: true }), (e) => e instanceof CallCapError && /40/.test(e.message));
  assert.equal(inner.prompts.length, 40, 'the 41st never reached Claude');
  assert.equal(capped.status().used, 40);
  assert.equal(inbox.list().filter((c) => c.kind === 'claude_unavailable').length, 1, 'one card says why');
  await assert.rejects(() => capped.complete('p', { unattended: true }), CallCapError);
  assert.equal(inbox.list().length, 1, 'still one card, counted');
});

// U-3
test('U-3 your own chat messages do not count toward the cap', async () => {
  const inner = fakeBackend('ok');
  const { capped } = capRig(inner);
  for (let i = 0; i < 40; i++) await capped.complete('mine', { tag: 'optimizer' });
  assert.equal(capped.status().used, 0);
  for (let i = 0; i < 40; i++) await capped.complete('auto', { unattended: true });
  await assert.rejects(() => capped.complete('auto', { unattended: true }), CallCapError);
  assert.equal((await capped.complete('mine again')), 'ok', 'your message still works when the cap is used up');
  assert.equal(inner.prompts.length, 81);
});

// U-4
test('U-4 the cap resets at the next UTC day', async () => {
  const inner = fakeBackend('ok');
  const { capped, clock } = capRig(inner);
  clock.set(Date.UTC(2026, 9, 7, 23, 59, 0));
  for (let i = 0; i < 40; i++) await capped.complete('p', { unattended: true });
  await assert.rejects(() => capped.complete('p', { unattended: true }), CallCapError);
  clock.set(Date.UTC(2026, 9, 8, 0, 0, 1));
  assert.equal(capped.status().used, 0);
  assert.equal(await capped.complete('p', { unattended: true }), 'ok');
  assert.equal(capped.status().used, 1);
});

// U-5
test('U-5 "Not logged in" from the CLI writes one inbox item and stops calls for the day', async () => {
  const authError = (): Error => {
    try {
      parseCliOutput(JSON.stringify({ is_error: true, result: 'Not logged in' })); // the same shape the CLI test uses
    } catch (e) {
      return e as Error;
    }
    throw new Error('parseCliOutput should have thrown');
  };
  let reached = 0;
  const inner: ChatBackend = {
    name: 'fake',
    complete: async () => {
      reached++;
      throw authError();
    },
  };
  const { capped, inbox, clock } = capRig(inner);
  await assert.rejects(() => capped.complete('p', { unattended: true }), ChatAuthError);
  assert.equal(inbox.list().length, 1);
  assert.equal(inbox.list()[0].kind, 'claude_unavailable');
  assert.match(inbox.list()[0].body, /Not logged in/);

  for (let i = 0; i < 5; i++) await assert.rejects(() => capped.complete('p', { unattended: true }), CallCapError);
  assert.equal(reached, 1, 'no more unattended calls reached Claude');
  assert.equal(inbox.list().length, 1, 'still one card');
  assert.equal(capped.status().signedOut, true);

  clock.set(WED + DAY);
  assert.equal(capped.status().signedOut, false, 'the next UTC day tries again');
});

test('U-5b a signed-out stop ends as soon as one of your own messages is answered', async () => {
  let signedIn = false;
  const inner: ChatBackend = {
    name: 'fake',
    complete: async () => {
      if (!signedIn) throw new ChatAuthError('Claude Code is signed out');
      return 'hello';
    },
  };
  const { capped, inbox } = capRig(inner);
  await assert.rejects(() => capped.complete('p', { unattended: true }), ChatAuthError);
  assert.equal(inbox.list('open').length, 1);
  signedIn = true;
  assert.equal(await capped.complete('my message'), 'hello');
  assert.equal(capped.status().signedOut, false);
  assert.equal(inbox.list('open').length, 0, 'the card closed itself');
  assert.equal(await capped.complete('auto', { unattended: true }), 'hello');
});
