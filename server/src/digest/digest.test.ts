import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import { fakeBackend, fakeClock } from '../testkit/index.js';
import type { ChatBackend } from '../chat/backend.js';
import { acceptExtra, buildDigestText, type DigestInput } from './digest.js';
import { DigestService } from './service.js';

const DAY = 86_400_000;
// Sunday 11 Oct 2026, 19:00 UTC.
const SUNDAY = Date.UTC(2026, 9, 11, 19, 0, 0);
const TO = Date.UTC(2026, 9, 12);

const INPUT: DigestInput = {
  from: TO - 7 * DAY,
  to: TO,
  strategies: [
    { name: 'Alpha', isTest: false, stage: 'demo', trades: 9, netProfit: 30, wins: 6 },
    { name: 'Beta', isTest: false, stage: 'paper', trades: 5, netProfit: -12.5, wins: 2 },
    { name: 'Idle', isTest: false, stage: 'backtest', trades: 0, netProfit: 0, wins: 0 },
    { name: 'Scratch test', isTest: true, stage: 'backtest', trades: 40, netProfit: 999, wins: 40 },
  ],
  proposalsApproved: 2,
  proposalsRejected: 1,
  tests: { passed: 1, failed: 1, notEnough: 1 },
  safetyEvents: 0,
  claude: { calls: 12, costUsd: 0.836 },
  openInbox: 3,
};

// U-6
test('U-6 the digest text is built from the numbers', () => {
  assert.equal(
    buildDigestText(INPUT),
    [
      'Week 5 Oct – 11 Oct (UTC)',
      '',
      'Trading: 14 closed trades, net +17.50.',
      '- Alpha (demo): 9 trades, net +30.00, 6 won',
      '- Beta (paper): 5 trades, net -12.50, 2 won',
      'Decisions: 2 proposals approved, 1 rejected.',
      'Tests: 3 run (1 passed, 1 failed, 1 not enough evidence).',
      'Safety: 0 safety cards raised.',
      'Claude: 12 calls, $0.84.',
      'Waiting for you: 3 items in the Inbox.',
    ].join('\n'),
  );
  const quiet = buildDigestText({ ...INPUT, strategies: [], proposalsApproved: 1, tests: { passed: 0, failed: 0, notEnough: 0 }, safetyEvents: 1, claude: { calls: 1, costUsd: 0 }, openInbox: 0 });
  assert.match(quiet, /Trading: no closed trades\./);
  assert.match(quiet, /1 proposal approved/);
  assert.match(quiet, /Tests: none run\./);
  assert.match(quiet, /Safety: 1 safety card raised\./);
  assert.match(quiet, /Claude: 1 call,/);
  assert.match(quiet, /Waiting for you: nothing\./);
});

function rig(backend?: ChatBackend, input: DigestInput = INPUT) {
  const clock = fakeClock(SUNDAY);
  const kv = new Map<string, unknown>();
  const inbox = new Inbox(new MemoryInboxStore(), {}, clock.now);
  const svc = new DigestService({
    gather: () => input,
    backend,
    inbox,
    store: { get: <T>(k: string, f: T) => (kv.has(k) ? (kv.get(k) as T) : f), set: (k, v) => void kv.set(k, v) },
    clock: clock.now,
  });
  return { clock, inbox, svc };
}

// U-7
test('U-7 if the model call fails, the digest still arrives from the template', async () => {
  const failing: ChatBackend = { name: 'fake', complete: async () => { throw new Error('Claude is not signed in'); } };
  const { svc, inbox } = rig(failing);
  const item = await svc.run();
  assert.ok(item);
  assert.equal(item!.kind, 'digest');
  assert.equal(item!.body, buildDigestText(INPUT), 'exactly the template');
  assert.equal(inbox.list().length, 1);
  assert.match(item!.title, /Weekly summary: 5 Oct – 11 Oct/);
});

test('the model adds two plain sentences only when they use no number the summary lacks', async () => {
  const good = fakeBackend('Alpha did best this week. Two proposals were approved.');
  const { svc } = rig(good);
  const item = await svc.run();
  assert.match(item!.body, /\n\nIn plain words: Alpha did best this week\. Two proposals were approved\.$/);
  assert.equal(good.prompts.length, 1);
  assert.match(good.prompts[0], /Alpha \(demo\)/, 'the model is shown the finished text');

  assert.equal(acceptExtra('Profit was 77 this week.', buildDigestText(INPUT)), null, 'an invented number is dropped');
  assert.equal(acceptExtra('   ', 'x'), null);
  assert.equal(acceptExtra('x'.repeat(501), 'x'), null);
  const { svc: svc2 } = rig(fakeBackend('You made 77 dollars.'));
  assert.equal((await svc2.run())!.body, buildDigestText(INPUT));
});

// U-8
test('U-8 the digest leaves out test strategies', async () => {
  const text = buildDigestText(INPUT);
  assert.ok(!/Scratch/.test(text));
  assert.ok(!/999/.test(text) && !/\b40 trades\b/.test(text), 'their trades are not in the totals either');
  assert.match(text, /14 closed trades/);
  const { svc } = rig(undefined);
  assert.ok(!/Scratch/.test((await svc.run())!.body));
});

test('it is sent once, on Sunday evening (UTC), and not on other days', async () => {
  const { svc, clock, inbox } = rig();
  clock.set(Date.UTC(2026, 9, 11, 17, 59)); // Sunday, too early
  assert.equal(await svc.run(), null);
  clock.set(Date.UTC(2026, 9, 10, 19)); // Saturday
  assert.equal(await svc.run(), null);
  clock.set(SUNDAY);
  assert.ok(await svc.run());
  assert.equal(await svc.run(), null, 'not twice the same Sunday');
  clock.set(SUNDAY + 3_600_000);
  assert.equal(svc.isDue(), false);
  assert.equal(inbox.list().length, 1);
  clock.set(SUNDAY + 7 * DAY);
  assert.equal(svc.isDue(), true, 'due again next Sunday');
});
