import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { BotRunner, positionTag } from './runner.js';
import { alwaysLong, fakeClock, flat, ScriptedBroker, until } from '../testkit/index.js';
import type { Strategy } from '../engine/types.js';

// First tests for the live runner. They pin today's behaviour so later changes show up.

const running: BotRunner[] = [];
afterEach(() => {
  while (running.length) running.pop()!.stop();
});

// A Wednesday at 10:00 UTC: outside the end-of-day and weekend flat windows, whatever the real date is.
const clock = () => fakeClock(Date.UTC(2026, 9, 7, 10, 0, 0)).now;

async function startBot(strategy: Strategy, broker: ScriptedBroker, allowLive = false): Promise<BotRunner> {
  const bot = new BotRunner(strategy, broker, allowLive, clock());
  running.push(bot);
  await bot.start();
  await until(() => bot.snapshot().lastTickAt != null);
  return bot;
}

function brokerWith(closedPrice: number, formingPrice = closedPrice): ScriptedBroker {
  const b = new ScriptedBroker();
  b.bid = closedPrice;
  // 300 closed bars, then one forming bar (the runner drops the last candle).
  b.candles = [...flat(300, closedPrice), ...flat(1, formingPrice, { start: Date.UTC(2026, 9, 7, 6, 0, 0) })];
  return b;
}

// Rule used here: close > 2. Closed bars at 3 satisfy it; bars at 1 do not.
const needsCloseAbove2 = (): Strategy => {
  const s = alwaysLong();
  s.entryLong = { logic: 'AND', conditions: [{ left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'const', value: 2 } }] };
  return s;
};

test('the runner opens a position when the closed bar gives a signal', async () => {
  const broker = brokerWith(3);
  await startBot(needsCloseAbove2(), broker);
  assert.equal(broker.positions.length, 1);
  assert.equal(broker.positions[0].side, 'long');
  assert.deepEqual(broker.calls, ['open:long:0.1']);
});

test('the runner never acts on a bar that is still forming', async () => {
  // Closed bars sit at 1 (rule false); only the forming bar is at 3 (rule would be true).
  const broker = brokerWith(1, 3);
  await startBot(needsCloseAbove2(), broker);
  assert.equal(broker.positions.length, 0, 'a signal on the forming bar must be ignored');
  assert.deepEqual(broker.calls, []);
});

test('the runner refuses a non-demo account when live trading is not allowed', async () => {
  const broker = brokerWith(3);
  broker.account.type = 'real';
  const bot = new BotRunner(needsCloseAbove2(), broker, false, clock());
  running.push(bot);
  await assert.rejects(() => bot.start(), /Refusing to trade a live account/);
  assert.equal(bot.getStatus(), 'error');
  assert.deepEqual(broker.calls, []);
});

test('with live trading allowed, the runner accepts a non-demo account', async () => {
  const broker = brokerWith(1);
  broker.account.type = 'real';
  const bot = await startBot(needsCloseAbove2(), broker, true);
  assert.equal(bot.getStatus(), 'running');
});

test('orders are tagged XAT:<id> so only this bot can find its own positions', async () => {
  const broker = brokerWith(3);
  const s = needsCloseAbove2();
  await startBot(s, broker);
  assert.equal(broker.positions[0].comment, positionTag(s.id));
  assert.match(positionTag(s.id), /^XAT:/);
});

test('stop() leaves open positions open', async () => {
  const broker = brokerWith(3);
  const bot = await startBot(needsCloseAbove2(), broker);
  assert.equal(broker.positions.length, 1);
  bot.stop();
  assert.equal(bot.getStatus(), 'stopped');
  assert.equal(broker.positions.length, 1);
  assert.ok(!broker.calls.some((c) => c.startsWith('close:')));
});

test('closeAll() closes only the positions this bot opened', async () => {
  const broker = brokerWith(3);
  const manual = broker.addPosition({ comment: undefined }); // opened by hand in MT5
  const otherBot = broker.addPosition({ comment: 'XAT:zzzzzzzz' }); // another strategy's
  const bot = await startBot(needsCloseAbove2(), broker);
  const mine = broker.positions.filter((p) => p.comment === positionTag('str_always'));
  assert.equal(mine.length, 1);
  const closed = await bot.closeAll();
  assert.equal(closed, 1);
  const left = broker.positions.map((p) => p.id).sort();
  assert.deepEqual(left, [manual.id, otherBot.id].sort());
});

// --- task 1.2: spread-to-stop and the flat window -----------------------------

test('R-12 the live runner places no order when spread is above 15% of the stop', async () => {
  const wide = brokerWith(3);
  wide.spreadPoints = 35;
  const s = needsCloseAbove2();
  s.risk = { ...s.risk, slPoints: 150, tpPoints: 225 }; // 35 / 150 = 23% > 15%
  const bot = await startBot(s, wide);
  assert.deepEqual(wide.calls, [], 'no order');
  assert.match(bot.snapshot().blockedReason ?? '', /Spread 35 is more than 15%/);

  const ok = brokerWith(3);
  ok.spreadPoints = 35;
  const s2 = needsCloseAbove2();
  s2.risk = { ...s2.risk, slPoints: 240, tpPoints: 360 }; // 35 / 240 = 14.6%
  await startBot(s2, ok);
  assert.deepEqual(ok.calls, ['open:long:0.1']);
});

test('the live runner places no order when the stop distance cannot be worked out', async () => {
  const broker = brokerWith(3);
  const s = needsCloseAbove2();
  s.risk = { ...s.risk, slMode: 'atr', slAtrMult: 1, tpMode: 'rr', tpRR: 1.5, atrIndicatorId: 'not_there' };
  const bot = await startBot(s, broker);
  assert.deepEqual(broker.calls, []);
  assert.match(bot.snapshot().blockedReason ?? '', /No stop distance/);
});

test('R-16 the live runner goes flat at the same times as the backtest', async () => {
  const s = needsCloseAbove2();
  // Wednesday 21:50 UTC is inside the flat window: the bot's own position is closed, nothing opens.
  const evening = brokerWith(3);
  evening.addPosition({ comment: positionTag(s.id), symbol: 'EURUSD', stopLoss: 1, takeProfit: 9 });
  const bot = new BotRunner(s, evening, false, fakeClock(Date.UTC(2026, 9, 7, 21, 50, 0)).now);
  running.push(bot);
  await bot.start();
  await until(() => bot.snapshot().lastTickAt != null);
  assert.ok(evening.calls.some((c) => c.startsWith('close:')), 'position closed');
  assert.ok(!evening.calls.some((c) => c.startsWith('open:')), 'nothing opened');
  assert.equal(evening.positions.length, 0);
  assert.match(bot.snapshot().blockedReason ?? '', /Flat window/);

  // 21:44 is not flat: the same position stays and the bot does not close it.
  const before = brokerWith(3);
  before.addPosition({ comment: positionTag(s.id), symbol: 'EURUSD', stopLoss: 1, takeProfit: 9 });
  const bot2 = new BotRunner(s, before, false, fakeClock(Date.UTC(2026, 9, 7, 21, 44, 0)).now);
  running.push(bot2);
  await bot2.start();
  await until(() => bot2.snapshot().lastTickAt != null);
  assert.ok(!before.calls.some((c) => c.startsWith('close:')));
  assert.equal(before.positions.length, 1);
});

test('enforceFlat closes a position between bars, so a slow timeframe still goes flat on time', async () => {
  const s = needsCloseAbove2();
  const t = fakeClock(Date.UTC(2026, 9, 7, 21, 40, 0));
  const broker = brokerWith(1); // rule false: the bot never opens by itself
  const bot = new BotRunner(s, broker, false, t.now);
  running.push(bot);
  await bot.start();
  await until(() => bot.snapshot().lastTickAt != null);
  const pos = broker.addPosition({ comment: positionTag(s.id), symbol: 'EURUSD' });
  await bot.enforceFlat(await broker.getPositions());
  assert.equal(broker.positions.length, 1, '21:40 is not flat');
  t.set(Date.UTC(2026, 9, 7, 21, 46, 0));
  await bot.enforceFlat(await broker.getPositions());
  assert.deepEqual(broker.calls.filter((c) => c.startsWith('close')), [`close:${pos.id}`]);
});
