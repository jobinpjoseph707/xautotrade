import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Strategy } from '../engine/types.js';
import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import { corsOriginAllowed, maskKey } from '../security.js';
import { fakeClock, ScriptedBroker, validStrategy } from '../testkit/index.js';
import { KillSwitch, type KV } from './killSwitch.js';
import { StallWatch, weekendClosed } from './stall.js';

const WED_10 = Date.UTC(2026, 9, 7, 10, 0, 0);

function kv(): KV {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string, f: T) => (m.has(k) ? (m.get(k) as T) : f), set: (k, v) => void m.set(k, v) };
}

function rig() {
  const clock = fakeClock(WED_10);
  const broker = new ScriptedBroker();
  const inbox = new Inbox(new MemoryInboxStore(), {}, clock.now);
  const paused: number[] = [];
  const ks = new KillSwitch({
    broker,
    pauseAll: () => { paused.push(clock.now()); return [validStrategy('XAUUSD', 'bot1')]; },
    inbox,
    store: kv(),
    clock: clock.now,
  });
  return { clock, broker, inbox, paused, ks };
}

/** A bot-opened position (comment "XAT:<id>") and one opened by hand (no comment). */
function twoPositions(broker: ScriptedBroker) {
  const bot = broker.addPosition({ comment: 'XAT:5b1fd6fe' });
  const hand = broker.addPosition({ comment: '' });
  return { bot, hand };
}

// S-1
test('S-1 at 3% below day-start equity every bot is paused and its positions are closed', async () => {
  const { broker, ks, inbox, paused } = rig();
  const { bot } = twoPositions(broker);
  assert.equal((await ks.check()).fired, false, 'the first look only records the start of the day');
  broker.account.equity = 9_700;
  const r = await ks.check();
  assert.equal(r.fired, true);
  assert.equal(paused.length, 1);
  assert.deepEqual(broker.calls, [`close:${bot.id}`]);
  const card = inbox.list()[0];
  assert.equal(card.kind, 'safety_action');
  assert.equal(card.severity, 'critical');
  assert.match(card.title, /down 3\.0%/);
});

// S-2
test('S-2 at 2.9% nothing happens', async () => {
  const { broker, ks, inbox, paused } = rig();
  twoPositions(broker);
  await ks.check();
  broker.account.equity = 9_710;
  assert.equal((await ks.check()).fired, false);
  assert.equal(paused.length, 0);
  assert.deepEqual(broker.calls, []);
  assert.equal(inbox.list().length, 0);
});

// S-3
test('S-3 positions you opened by hand in MT5 are not touched', async () => {
  const { broker, ks } = rig();
  const { hand } = twoPositions(broker);
  await ks.check();
  broker.account.equity = 9_000;
  await ks.check();
  assert.ok(!broker.calls.includes(`close:${hand.id}`));
  assert.ok(broker.positions.some((p) => p.id === hand.id), 'the manual position is still open');
});

// S-4
test('S-4 the kill switch fires once per day and writes one inbox item', async () => {
  const { broker, ks, inbox, paused, clock } = rig();
  twoPositions(broker);
  await ks.check();
  broker.account.equity = 9_600;
  await ks.check();
  await ks.check();
  broker.account.equity = 9_000;
  await ks.check();
  assert.equal(paused.length, 1);
  assert.equal(inbox.list().length, 1);
  assert.equal(inbox.list()[0].count, 1);
  assert.equal(ks.trippedToday(), true);
  assert.match(ks.startBlockedReason() ?? '', /00:00 UTC/);
  // The next UTC day starts clean and can fire again.
  clock.advance(24 * 3_600_000);
  assert.equal(ks.trippedToday(), false);
  assert.equal(ks.startBlockedReason(), null);
  broker.account.equity = 10_000;
  await ks.check(); // records the new day's start
  broker.account.equity = 9_600;
  assert.equal((await ks.check()).fired, true);
  assert.equal(paused.length, 2);
});

// S-5
test('S-5 the loss is measured on equity, so an open loss counts', async () => {
  const { broker, ks } = rig();
  await ks.check();
  broker.account.balance = 10_000; // nothing realised
  broker.account.equity = 9_700; // all of it floating
  assert.equal((await ks.check()).fired, true);
});

test('a position that cannot be closed is reported on the card, not hidden', async () => {
  const { broker, ks, inbox } = rig();
  const { bot } = twoPositions(broker);
  broker.closePosition = async () => { throw new Error('requote'); };
  await ks.check();
  broker.account.equity = 9_000;
  const r = await ks.check();
  assert.equal(r.failed.length, 1);
  assert.match(inbox.list()[0].body, new RegExp(`COULD NOT CLOSE.*${bot.id}.*requote`));
});

test('the cap can be changed', async () => {
  const clock = fakeClock(WED_10);
  const broker = new ScriptedBroker();
  const ks = new KillSwitch({ broker, pauseAll: () => [], inbox: new Inbox(new MemoryInboxStore()), store: kv(), clock: clock.now, capPct: () => 1 });
  await ks.check();
  broker.account.equity = 9_890;
  assert.equal((await ks.check()).fired, true);
});

// --- stall watch ----------------------------------------------------------------------------

function stallRig(over: { timeframe?: string; ageMin: number; open?: boolean | null; now?: number }) {
  const clock = fakeClock(over.now ?? WED_10);
  const inbox = new Inbox(new MemoryInboxStore(), {}, clock.now);
  const strategy = validStrategy('XAUUSD', 'bot1');
  let ageMin = over.ageMin;
  const watch = new StallWatch({
    snapshots: () => [{ strategyId: 'bot1', strategyName: 'Bot one', symbol: 'XAUUSD', timeframe: over.timeframe ?? '5m', status: 'running', startedAt: clock.now() - 6 * 3_600_000, lastBarTime: clock.now() - ageMin * 60_000 }],
    strategy: () => strategy as Strategy,
    marketOpen: async () => (over.open === undefined ? true : over.open),
    inbox,
    clock: clock.now,
  });
  return { watch, inbox, clock, setAge: (m: number) => void (ageMin = m) };
}

// S-9
test('S-9 no bar for 3 x the timeframe while the market is open raises a stall item', async () => {
  const ok = stallRig({ ageMin: 15 }); // exactly 3 bars of 5m: still healthy
  assert.deepEqual(await ok.watch.check(), []);
  const bad = stallRig({ ageMin: 16 });
  assert.deepEqual(await bad.watch.check(), ['bot1']);
  await bad.watch.check();
  const items = bad.inbox.list();
  assert.equal(items.length, 1, 'the same stall is one card');
  assert.equal(items[0].kind, 'stall');
  assert.equal(items[0].count, 2);
  assert.deepEqual(items[0].actions, ['restart', 'dismiss']);
  bad.setAge(2); // bars are flowing again
  await bad.watch.check();
  assert.equal(bad.inbox.list().length, 0, 'the card closes itself');
});

// S-10
test('S-10 a quiet weekend raises nothing', async () => {
  const saturday = Date.UTC(2026, 9, 10, 12, 0, 0);
  assert.equal(weekendClosed(saturday), true);
  const w = stallRig({ ageMin: 600, now: saturday, open: null }); // broker cannot say -> weekend rule
  assert.deepEqual(await w.watch.check(), []);
  assert.equal(weekendClosed(Date.UTC(2026, 9, 11, 21, 59)), true, 'Sunday before 22:00 UTC');
  assert.equal(weekendClosed(Date.UTC(2026, 9, 11, 22, 1)), false, 'Sunday evening: open again');
  assert.equal(weekendClosed(Date.UTC(2026, 9, 9, 21, 59)), false, 'Friday before 22:00 UTC');
  assert.equal(weekendClosed(Date.UTC(2026, 9, 9, 22, 1)), true);
});

test('a closed market on a weekday and the daily flat window raise nothing either', async () => {
  assert.deepEqual(await stallRig({ ageMin: 600, open: false }).watch.check(), []);
  const flatWindow = stallRig({ ageMin: 600, now: Date.UTC(2026, 9, 7, 22, 30) }); // after 21:45 UTC
  assert.deepEqual(await flatWindow.watch.check(), []);
  const justAfter = stallRig({ ageMin: 600, now: Date.UTC(2026, 9, 8, 0, 2) }); // one bar after the window ends
  assert.deepEqual(await justAfter.watch.check(), []);
});

// --- security basics ------------------------------------------------------------------------

test('CORS: this computer, the home network and Tailscale are allowed; other web sites are not', () => {
  for (const o of ['http://localhost:8081', 'http://127.0.0.1:8099', 'http://192.168.1.2:8081', 'http://10.0.0.5', 'http://172.20.1.1:3000', 'http://100.101.2.3:8081', 'https://laptop.tail1234.ts.net', undefined]) {
    assert.equal(corsOriginAllowed(o, []), true, String(o));
  }
  for (const o of ['https://evil.example.com', 'http://192.169.1.1', 'http://172.32.0.1', 'http://100.128.0.1', 'file://x', 'null']) {
    assert.equal(corsOriginAllowed(o, []), false, o);
  }
  assert.equal(corsOriginAllowed('https://mine.example.com', ['https://mine.example.com']), true);
});

test('the API key is masked when shown', () => {
  assert.equal(maskKey('348bc1189c0347d2ffc1a85d6ab26179'), '••••6179');
  assert.ok(!maskKey('348bc1189c0347d2ffc1a85d6ab26179').includes('348bc'));
});

// S-11
test('S-11 RUNBOOK.md and README.md contain no 32-character hex key', () => {
  for (const f of ['README.md', 'RUNBOOK.md']) {
    const text = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
    // The server makes keys with randomBytes(16).toString('hex'): 32 LOWERCASE hex characters.
    // (MetaTrader's terminal folder id in a file path is uppercase, and is not a secret.)
    const hits = text.match(/\b[0-9a-f]{32}\b/g) ?? [];
    assert.deepEqual(hits, [], `${f} must not contain an API key`);
  }
});
