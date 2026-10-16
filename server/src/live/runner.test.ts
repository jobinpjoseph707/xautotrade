import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { BotRunner, positionTag } from './runner.js';
import { alwaysLong, flat, ScriptedBroker, until } from '../testkit/index.js';
import type { Strategy } from '../engine/types.js';

// First tests for the live runner. They pin today's behaviour so later changes show up.

const running: BotRunner[] = [];
afterEach(() => {
  while (running.length) running.pop()!.stop();
});

async function startBot(strategy: Strategy, broker: ScriptedBroker, allowLive = false): Promise<BotRunner> {
  const bot = new BotRunner(strategy, broker, allowLive);
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
  const bot = new BotRunner(needsCloseAbove2(), broker, false);
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
