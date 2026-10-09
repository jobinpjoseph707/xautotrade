import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Strategy } from '../engine/types.js';
import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import { settings, strategies } from '../store.js';
import { alwaysLong, fakeClock, flat, ScriptedBroker, until } from '../testkit/index.js';
import { BotManager, MAX_RESUME_GAP_MS } from './manager.js';

const WED_10 = Date.UTC(2026, 9, 7, 10, 0, 0);
const MIN = 60_000;

/** A strategy that never trades, so the tests only watch start/stop. */
function quiet(id: string): Strategy {
  const s = alwaysLong();
  s.id = id;
  s.name = `Bot ${id}`;
  s.entryLong = { logic: 'AND', conditions: [{ left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'const', value: 1e9 } }] };
  return s;
}

function rig() {
  const clock = fakeClock(WED_10);
  const broker = new ScriptedBroker();
  broker.candles = [...flat(300, 1.1), ...flat(1, 1.1, { start: Date.UTC(2026, 9, 7, 6, 0, 0) })];
  const inbox = new Inbox(new MemoryInboxStore(), {}, clock.now);
  const manager = new BotManager({ broker, clock: clock.now, inbox });
  return { clock, broker, inbox, manager };
}

const made: BotManager[] = [];
beforeEach(() => {
  for (const s of strategies.list()) {
    strategies.remove(s.id);
    settings.set(`bot:${s.id}:autostart`, false);
  }
  settings.set('heartbeat', null);
});
afterEach(() => {
  while (made.length) made.pop()!.stopAll();
});

function setup(autostart: Strategy[], gapMs: number | null) {
  const r = rig();
  made.push(r.manager);
  for (const s of autostart) {
    strategies.save(s);
    settings.set(`bot:${s.id}:autostart`, true);
  }
  settings.set('heartbeat', gapMs == null ? null : WED_10 - gapMs);
  return r;
}

const status = (m: BotManager, id: string) => m.snapshot(id)?.status ?? 'stopped';

// S-6
test('S-6 after a 29-minute outage bots resume', async () => {
  const { manager, inbox } = setup([quiet('a')], 29 * MIN);
  await manager.restoreAutostart();
  await until(() => status(manager, 'a') === 'running');
  assert.equal(inbox.list().length, 0);
  assert.equal(strategies.get('a')!.pausedBy, undefined);
});

// S-7
test('S-7 after a 31-minute outage bots stay paused and the inbox asks', async () => {
  const { manager, inbox } = setup([quiet('a'), quiet('b')], 31 * MIN);
  await manager.restoreAutostart();
  assert.equal(status(manager, 'a'), 'stopped');
  assert.equal(status(manager, 'b'), 'stopped');
  assert.equal(strategies.get('a')!.pausedBy, 'safety');
  const items = inbox.list();
  assert.equal(items.length, 2, 'one card per paused bot');
  assert.ok(items.every((i) => i.kind === 'safety_action' && i.severity === 'warn'));
  assert.match(items[0].title, /31-minute outage/);
  assert.equal(MAX_RESUME_GAP_MS, 30 * MIN);
  // Restart bot (the card's button) starts it and ends the safety pause.
  await manager.start('a');
  assert.equal(status(manager, 'a'), 'running');
  assert.equal(strategies.get('a')!.pausedBy, undefined);
});

// S-8
test('S-8 a bot paused by safety never resumes by itself, whatever the outage length', async () => {
  for (const gap of [null, 0, 2 * MIN, 29 * MIN, 31 * MIN, 600 * MIN]) {
    const { manager } = setup([{ ...quiet('a'), pausedBy: 'safety' }], gap);
    await manager.restoreAutostart();
    assert.equal(status(manager, 'a'), 'stopped', `gap ${gap}`);
    assert.equal(strategies.get('a')!.pausedBy, 'safety');
  }
});

test('with no heartbeat yet (first start) bots resume, and the heartbeat is written', async () => {
  const { manager } = setup([quiet('a')], null);
  await manager.restoreAutostart();
  await until(() => status(manager, 'a') === 'running');
  manager.heartbeat();
  assert.equal(settings.get<number | null>('heartbeat', null), WED_10);
});

test('the safety pause stops every running bot and turns autostart off', async () => {
  const { manager } = setup([quiet('a'), quiet('b')], 0);
  await manager.restoreAutostart();
  await until(() => status(manager, 'a') === 'running' && status(manager, 'b') === 'running');
  const paused = manager.pauseAllBySafety();
  assert.deepEqual(paused.map((s) => s.id).sort(), ['a', 'b']);
  assert.equal(status(manager, 'a'), 'stopped');
  assert.equal(strategies.get('b')!.pausedBy, 'safety');
  assert.equal(settings.get('bot:a:autostart', true), false);
  await manager.restoreAutostart();
  assert.equal(status(manager, 'a'), 'stopped', 'a restart does not bring them back');
});

test('a start guard can refuse a start and the bot stays stopped', async () => {
  const { manager } = setup([], null);
  strategies.save(quiet('a'));
  manager.setStartGuard(() => 'The daily loss cap stopped trading today.');
  await assert.rejects(() => manager.start('a'), /daily loss cap/);
  assert.equal(status(manager, 'a'), 'stopped');
  manager.setStartGuard(null);
  await manager.start('a');
  assert.equal(status(manager, 'a'), 'running');
});
