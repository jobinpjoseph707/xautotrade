import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Strategy } from '../engine/types.js';
import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import { corsOriginAllowed, maskKey } from '../security.js';
import { fakeClock, ScriptedBroker, validStrategy } from '../testkit/index.js';
import { gateViolation } from '../learning/propose.js';
import { KillSwitch, type KV } from './killSwitch.js';
import {
  applySafetyMove,
  SafetyMoveRefused,
  TIGHTENING,
  undoSafetyMove,
  type RiskChange,
  type SafetyDeps,
  type SafetyMove,
  type TightenField,
} from './applySafetyMove.js';
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

// --- Safety moves (task 2.3) ---------------------------------------------------------------------

/** Limits with room on both sides, so every field in the table can move either way. */
function moveRig() {
  const clock = fakeClock(WED_10);
  const s: Strategy = validStrategy('XAUUSD', 'bot1');
  s.name = 'Bot one';
  s.risk = { ...s.risk, fixedLot: 0.1, riskPercent: 1, maxDailyTrades: 10, maxDailyLossPercent: 3, maxSpreadPoints: 50, cooldownBars: 2, minRewardRisk: 1.5, minLot: 0.01 };
  const db = new Map<string, Strategy>([[s.id, s]]);
  const saves: string[] = [];
  const traces: { event: string; strategyId: string; message: string; data: unknown }[] = [];
  const stopped: string[] = [];
  const started: string[] = [];
  const running = new Set<string>();
  const inbox = new Inbox(new MemoryInboxStore(), {}, clock.now);
  const deps: SafetyDeps = {
    strategies: { get: (id) => (db.has(id) ? structuredClone(db.get(id)!) : null), save: (x) => { db.set(x.id, structuredClone(x)); saves.push(x.id); return x; } },
    inbox,
    trace: (e) => void traces.push(e),
    stopBot: (id) => { stopped.push(id); running.delete(id); },
    isRunning: (id) => running.has(id),
    startBot: async (id) => { started.push(id); },
    clock: clock.now,
  };
  const move = (change: unknown, reason = 'Losing streak.'): SafetyMove => ({ kind: 'tighten', strategyId: 'bot1', change: change as RiskChange, reason });
  return { s, db, saves, traces, stopped, started, running, inbox, deps, move, risk: () => db.get('bot1')!.risk };
}

const TIGHTER: Record<TightenField, number[]> = {
  fixedLot: [0.05],
  riskPercent: [0.5],
  maxDailyTrades: [5],
  maxDailyLossPercent: [2],
  maxSpreadPoints: [30],
  cooldownBars: [4],
  minRewardRisk: [2],
};
const LOOSER: Record<TightenField, number[]> = {
  fixedLot: [0.2],
  riskPercent: [2],
  maxDailyTrades: [20, 0],
  maxDailyLossPercent: [6, 0],
  maxSpreadPoints: [80, 0],
  cooldownBars: [1, 0],
  minRewardRisk: [1],
};

// M-1
test('M-1 pausing a bot is accepted', () => {
  const r = moveRig();
  r.running.add('bot1');
  const res = applySafetyMove({ kind: 'pause', strategyId: 'bot1', reason: 'Spread is wild.' }, r.deps);
  assert.equal(res.applied, true);
  assert.deepEqual(r.stopped, ['bot1']);
  assert.equal(r.db.get('bot1')!.pausedBy, 'safety');
});

// M-2
test('M-2 each tightening in the table is accepted', () => {
  assert.deepEqual(Object.keys(TIGHTENING).sort(), Object.keys(TIGHTER).sort(), 'the test covers every field in the table');
  for (const field of Object.keys(TIGHTENING) as TightenField[]) {
    for (const value of TIGHTER[field]) {
      const r = moveRig();
      assert.equal(applySafetyMove(r.move({ [field]: value }), r.deps).applied, true, `${field} -> ${value}`);
      assert.equal(r.risk()[field], value);
      assert.equal(gateViolation(r.s.risk, r.risk()), null);
    }
  }
});

// M-3
test('M-3 each loosening in the table is refused', () => {
  for (const field of Object.keys(TIGHTENING) as TightenField[]) {
    for (const value of LOOSER[field]) {
      const r = moveRig();
      assert.throws(() => applySafetyMove(r.move({ [field]: value }), r.deps), SafetyMoveRefused, `${field} -> ${value}`);
      assert.deepEqual(r.saves, [], `${field} -> ${value} saved something`);
      assert.equal(r.risk()[field], r.s.risk[field]);
    }
  }
  // A forged move of another kind is refused too.
  const r = moveRig();
  assert.throws(() => applySafetyMove({ kind: 'loosen', strategyId: 'bot1', change: { fixedLot: 1 }, reason: 'x' } as unknown as SafetyMove, r.deps), /not a move the safety code may make/);
  assert.deepEqual(r.saves, []);
});

// M-4
test('M-4 a change that tightens one field and loosens another is refused whole', () => {
  const r = moveRig();
  assert.throws(() => applySafetyMove(r.move({ fixedLot: 0.05, maxDailyTrades: 20 }), r.deps), SafetyMoveRefused);
  assert.deepEqual(r.saves, [], 'nothing applied');
  assert.deepEqual(r.risk(), r.s.risk);
  assert.equal(r.inbox.list().length, 0);
  assert.equal(r.traces.length, 0);
});

// M-5
test('M-5 a field not in the table is refused', () => {
  for (const change of [{ slPoints: 100 }, { maxLot: 0.01 }, { maxOpenPositions: 1 }, { sessions: [] }, { fixedLot: 0.05, slPoints: 100 }, { __proto__: { fixedLot: 0.05 }, constructor: 1 }, {}, null, 5]) {
    const r = moveRig();
    assert.throws(() => applySafetyMove(r.move(change), r.deps), SafetyMoveRefused, JSON.stringify(change));
    assert.deepEqual(r.saves, []);
  }
  // Values that are not plain numbers are refused as well.
  for (const bad of ['0.05', Number.NaN, Infinity, null, -1, 0]) {
    const r = moveRig();
    assert.throws(() => applySafetyMove(r.move({ fixedLot: bad }), r.deps), SafetyMoveRefused, String(bad));
  }
  // Below the broker's minimum lot would stop the bot trading at all.
  const r = moveRig();
  assert.throws(() => applySafetyMove(r.move({ fixedLot: 0.005 }), r.deps), /below the minimum lot/);
});

// M-6
test('M-6 500 random changes: every one that is accepted is tighter', () => {
  let seed = 20260923;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fields = [...(Object.keys(TIGHTENING) as string[]), 'slPoints', 'maxLot', 'flatAtUTC'];
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 500; i++) {
    const r = moveRig();
    const before = structuredClone(r.s.risk);
    const change: Record<string, unknown> = {};
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const f = fields[Math.floor(rnd() * fields.length)];
      const was = Number((before as unknown as Record<string, unknown>)[f] ?? 100);
      const pick = rnd();
      change[f] = pick < 0.4 ? was * (0.3 + rnd() * 0.65) : pick < 0.8 ? was * (1.05 + rnd() * 2) : pick < 0.9 ? 0 : was;
    }
    try {
      applySafetyMove(r.move(change), r.deps);
    } catch (err) {
      assert.ok(err instanceof SafetyMoveRefused);
      assert.deepEqual(r.risk(), before, `seed step ${i}: a refused move changed the strategy`);
      refused++;
      continue;
    }
    accepted++;
    const after = r.risk();
    assert.equal(gateViolation(before, after), null, `step ${i}: ${JSON.stringify(change)}`);
    for (const key of Object.keys(change)) {
      const f = key as TightenField;
      assert.ok(Object.hasOwn(TIGHTENING, f), `step ${i}: accepted a field outside the table: ${key}`);
      const t = TIGHTENING[f];
      if (t.direction === 'down') {
        assert.ok(after[f] < before[f] || (t.zeroOff && before[f] <= 0 && after[f] > 0), `step ${i}: ${f} ${before[f]} -> ${after[f]}`);
        if (t.zeroOff) assert.ok(after[f] > 0, `step ${i}: ${f} was switched off`);
      } else {
        assert.ok(after[f] > before[f], `step ${i}: ${f} ${before[f]} -> ${after[f]}`);
      }
    }
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      if (!Object.hasOwn(change, key)) assert.deepEqual(after[key], before[key], `step ${i}: ${key} changed without being asked`);
    }
  }
  assert.ok(accepted > 20 && refused > 20, `the run must exercise both outcomes (accepted ${accepted}, refused ${refused})`);
});

// M-7
test('M-7 every safety move writes an inbox item and a trace', () => {
  const p = moveRig();
  p.running.add('bot1');
  applySafetyMove({ kind: 'pause', strategyId: 'bot1', reason: 'Spread is wild.' }, p.deps);
  const t = moveRig();
  applySafetyMove(t.move({ fixedLot: 0.05 }), t.deps);
  for (const r of [p, t]) {
    const cards = r.inbox.list();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'safety_action');
    assert.deepEqual(cards[0].actions.filter((a) => a === 'ok' || a === 'undo'), ['ok', 'undo']);
    assert.equal(r.traces.length, 1);
    assert.equal(r.traces[0].event, 'safety_move');
    assert.equal(r.traces[0].strategyId, 'bot1');
  }
  assert.match(t.traces[0].message, /lot size 0\.1 → 0\.05/);
  // A kill-switch card has no Undo: it has nothing to put back.
  const { ks, inbox } = rig();
  void ks;
  assert.deepEqual(inbox.raise({ kind: 'safety_action', title: 'x' }).item.actions, ['ok', 'restart']);
});

// M-8
test('M-8 only a short list of places may save a strategy, and a new one fails this test', () => {
  // file (relative to server/src) -> how many calls, and why it is allowed to save without a new request from you.
  const ALLOWED: Record<string, { calls: number; why: string }> = {
    'api/routes.ts': { calls: 2, why: 'you created or edited a strategy yourself' },
    'api/chat.ts': { calls: 1, why: 'the chat host that ChatService.approve saves through, after you approve' },
    'chat/actions.ts': { calls: 2, why: 'ChatService.approve: a proposal you approved' },
    'learning/evolve.ts': { calls: 1, why: 'Evolver.promote: a variant you promoted' },
    'safety/applySafetyMove.ts': { calls: 1, why: 'the safety moves: pause or tighten only (one call, in persist)' },
    'live/manager.ts': { calls: 3, why: 'only sets or clears the "paused" flag' },
    'api/testboard.ts': { calls: 1, why: 'the browser-test seed route; answers 404 unless the server was started with E2E_SEED=1' },
    'gates/engine.ts': { calls: 1, why: 'only changes the stage, after a pass and the Move button you pressed' },
    'scripts/cleanup.ts': { calls: 2, why: 'a script you run by hand' },
  };
  const root = fileURLToPath(new URL('..', import.meta.url));
  const found: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !full.includes(`${sep}testkit${sep}`)) {
        const calls = readFileSync(full, 'utf8')
          .split('\n')
          .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
          .filter((l) => /\.save\(/.test(l) && !/\bbacktests\.save\(/.test(l)).length; // any name: an alias cannot hide a caller (saving a backtest result is not a strategy)
        if (calls) found[relative(root, full).split(sep).join('/')] = calls;
      }
    }
  };
  walk(root);
  const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, v]) => [f, v.calls]));
  assert.deepEqual(found, expected, 'a strategy is saved from a place that is not on the list (or a listed place saves more than it should)');
});

// M-9
test('M-9 an approved proposal is still needed for everything else', () => {
  // The safety code cannot change anything a proposal would change.
  for (const change of [{ slPoints: 100 }, { tpPoints: 100 }, { maxLot: 0.01 }, { lotMode: 'fixed' }, { maxOpenPositions: 1 }]) {
    const r = moveRig();
    assert.throws(() => applySafetyMove(r.move(change), r.deps), SafetyMoveRefused);
    assert.deepEqual(r.saves, []);
  }
  // The existing test that proves "nothing is applied automatically" is still there, unchanged in meaning.
  const learning = readFileSync(new URL('../learning/learning.test.ts', import.meta.url), 'utf8');
  assert.match(learning, /nothing is applied automatically/);
});

// --- Undo ------------------------------------------------------------------------------------

test('Undo puts the old limits back, but only if nobody edited them since', async () => {
  const r = moveRig();
  applySafetyMove(r.move({ fixedLot: 0.05, cooldownBars: 4 }), r.deps);
  const card = r.inbox.list()[0];
  const res = await undoSafetyMove('bot1', card.data, r.deps);
  assert.equal(res.applied, true);
  assert.equal(r.risk().fixedLot, 0.1);
  assert.equal(r.risk().cooldownBars, 2);
  assert.equal(r.traces.at(-1)!.event, 'safety_move_undone');

  // Tighten again, then the owner edits the lot by hand: Undo must not overwrite that edit.
  applySafetyMove(r.move({ fixedLot: 0.05 }), r.deps);
  const card2 = r.inbox.list().find((c) => c.id !== card.id && c.status === 'open')!;
  r.db.get('bot1')!.risk.fixedLot = 0.07;
  const res2 = await undoSafetyMove('bot1', card2.data, r.deps);
  assert.equal(res2.applied, false);
  assert.equal(r.risk().fixedLot, 0.07);
});

test('Undo of a pause clears the pause and starts the bot only if it was running', async () => {
  const r = moveRig();
  r.running.add('bot1');
  applySafetyMove({ kind: 'pause', strategyId: 'bot1', reason: 'x' }, r.deps);
  const res = await undoSafetyMove('bot1', r.inbox.list()[0].data, r.deps);
  assert.equal(res.applied, true);
  assert.equal(r.db.get('bot1')!.pausedBy, undefined);
  assert.deepEqual(r.started, ['bot1']);

  const q = moveRig();
  applySafetyMove({ kind: 'pause', strategyId: 'bot1', reason: 'x' }, q.deps);
  await undoSafetyMove('bot1', q.inbox.list()[0].data, q.deps);
  assert.deepEqual(q.started, [], 'it was not running, so it is not started');
});

test('a paused bot is not paused again, and Undo with forged data is refused', async () => {
  const r = moveRig();
  applySafetyMove({ kind: 'pause', strategyId: 'bot1', reason: 'x' }, r.deps);
  assert.equal(applySafetyMove({ kind: 'pause', strategyId: 'bot1', reason: 'x' }, r.deps).applied, false);
  assert.equal(r.inbox.list().length, 1);
  await assert.rejects(() => undoSafetyMove('bot1', { move: 'tighten', strategyId: 'bot1', before: { slPoints: 1 }, after: { slPoints: 2 } }, r.deps), SafetyMoveRefused);
  await assert.rejects(() => undoSafetyMove('bot1', null, r.deps), SafetyMoveRefused);
});

test('the Undo button on the Inbox card calls the handler and closes the card', async () => {
  const r = moveRig();
  r.inbox.setHandlers({ undoSafetyMove: (id, data) => undoSafetyMove(id, data, r.deps) });
  applySafetyMove(r.move({ fixedLot: 0.05 }), r.deps);
  const card = r.inbox.list()[0];
  const closed = await r.inbox.act(card.id, 'undo');
  assert.equal(closed.status, 'done');
  assert.match(closed.outcome ?? '', /old limits back/);
  assert.equal(r.risk().fixedLot, 0.1);
  await assert.rejects(() => r.inbox.act(rig().inbox.raise({ kind: 'safety_action', title: 'plain' }).item.id, 'undo'), /not available|no longer exists/);
});
