/**
 * Tests the MT5-via-MCP adapter against a fake MCP server that returns
 * MetaTrader5-shaped payloads (see mt5mcp.fake.mjs).
 *
 * This cannot prove the real community bridge uses these exact tool names —
 * only a live Windows box can. What it does prove is that the stdio spawn
 * path works, and that every conversion the adapter performs (seconds→ms,
 * tick value→point value, MT5 type codes→long/short, retcode checking,
 * TRADE_ACTION selection) is correct. Those are the parts that would
 * otherwise fail silently and produce wrong orders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Mt5McpBroker, positionHistoryFromDeals } from './mt5mcp.js';

const FAKE = fileURLToPath(new URL('./mt5mcp.fake.mjs', import.meta.url));

function makeBroker() {
  return new Mt5McpBroker({
    transport: 'stdio',
    command: process.execPath, // node
    args: [FAKE],
    deviationPoints: 20,
  });
}

test('connects over stdio by spawning the bridge as a child process', async () => {
  const broker = makeBroker();
  await broker.connect();
  assert.equal(broker.isConnected(), true);
  await broker.disconnect();
});

test('reads the symbol list', async () => {
  const broker = makeBroker();
  await broker.connect();
  const symbols = await broker.getSymbols();
  assert.ok(symbols.includes('EURUSD'), `expected EURUSD in ${JSON.stringify(symbols)}`);
  await broker.disconnect();
});

test('derives point value per lot from MT5 tick size and tick value', async () => {
  const broker = makeBroker();
  await broker.connect();
  const spec = await broker.getSymbolSpec('TICKUSD');
  assert.equal(spec.digits, 5);
  assert.equal(spec.point, 0.00001);
  // tick_value 1 at tick_size == point means 1 currency unit per point per lot.
  assert.equal(spec.pointValuePerLot, 1);
  assert.equal(spec.contractSize, 100000);
  await broker.disconnect();
});

test('derives gold point value correctly even though the broker reports nulls', async () => {
  // MetaQuotes-Demo returns tick_value / tick_size / contract_size as null for
  // XAUUSD. Point value must still come out at 1.0 (100oz contract × $0.01
  // point), and must never be NaN — a NaN here silently mis-sizes every trade.
  const broker = makeBroker();
  await broker.connect();

  const gold = await broker.getSymbolSpec('XAUUSD');
  assert.equal(gold.digits, 2);
  assert.equal(gold.point, 0.01);
  assert.equal(gold.spreadPoints, 20, 'real demo gold spread');
  assert.ok(Number.isFinite(gold.pointValuePerLot), 'point value must not be NaN');
  assert.equal(gold.pointValuePerLot, 1, '100oz × $0.01 = $1 per point per lot');

  await broker.disconnect();
});

test('derives point value from contract size when tick data is missing', async () => {
  const broker = makeBroker();
  await broker.connect();
  const spec = await broker.getSymbolSpec('GBPUSD');
  // 100000 × 0.00001 = 1
  assert.equal(spec.pointValuePerLot, 1);
  assert.equal(spec.contractSize, 100000);
  await broker.disconnect();
});

test('reads tick_size / tick_value under the names the bridge actually uses', async () => {
  // The adapter originally looked for trade_tick_value / trade_tick_size, which
  // this bridge never emits — so it always fell through to the fallback.
  const broker = makeBroker();
  await broker.connect();
  const spec = await broker.getSymbolSpec('TICKUSD');
  assert.equal(spec.pointValuePerLot, 1);
  assert.equal(spec.contractSize, 100000, 'contract_size must be read, not defaulted');
  await broker.disconnect();
});

test('percent-risk sizing on gold risks the intended amount', async () => {
  // End-to-end sanity: 0.5% of 100k = $500. With a 600-point stop on gold at
  // $1/point/lot, that is 0.83 lots. Getting point value wrong here is how you
  // accidentally trade 100x your intended size.
  const { computeLots } = await import('../engine/risk.js');
  const { DEFAULT_RISK } = await import('../engine/types.js');

  const broker = makeBroker();
  await broker.connect();
  const gold = await broker.getSymbolSpec('XAUUSD');
  await broker.disconnect();

  const risk = { ...DEFAULT_RISK, lotMode: 'percentRisk' as const, riskPercent: 0.5, maxLot: 100 };
  const lots = computeLots(risk, 100_000, 600, { ...gold, commissionPerLot: 0 });
  const lossAtStop = 600 * gold.pointValuePerLot * lots;

  assert.ok(
    Math.abs(lossAtStop - 500) < 10,
    `expected roughly $500 at risk, got $${lossAtStop} with ${lots} lots`,
  );
});

test('parses the bridge ISO-8601 timestamps into epoch milliseconds', async () => {
  // The real bridge emits "2026-08-17T00:05:00Z", not epoch seconds. Doing
  // Number(...) * 1000 on that yields NaN, which silently produced candles
  // with invalid dates and an empty backtest.
  const broker = makeBroker();
  await broker.connect();

  const quote = await broker.getQuote('EURUSD');
  assert.equal(quote.time, 1786910000 * 1000, 'quote time must be parsed ms');
  assert.ok(Number.isFinite(quote.time), 'quote time must never be NaN');

  const candles = await broker.getCandles('EURUSD', '5m', 5);
  assert.equal(candles[0].time, 1786900000 * 1000, 'candle time must be parsed ms');
  for (const c of candles) {
    assert.ok(Number.isFinite(c.time), `candle time must never be NaN, got ${c.time}`);
    assert.ok(c.time > 1_000_000_000_000, 'candle time must be milliseconds, not seconds');
  }
  await broker.disconnect();
});

test('unwraps the {result: [...]} envelope FastMCP puts around list returns', async () => {
  // A tool returning a LIST is wrapped, because MCP structured output must be
  // an object at the top level. Failing to unwrap it returned zero candles and
  // produced "the broker returned only 0 candles" on a perfectly healthy feed.
  const broker = makeBroker();
  await broker.connect();

  const candles = await broker.getCandles('EURUSD', '5m', 5);
  assert.equal(candles.length, 5, 'wrapped list must still yield candles');

  const symbols = await broker.getSymbols();
  assert.ok(Array.isArray(symbols) && symbols.length > 0, 'wrapped symbol list must unwrap');
  await broker.disconnect();
});

test('real EURUSD also reports null tick data and falls back safely', async () => {
  // Confirmed from live logs: this broker returns nulls for EURUSD as well as
  // gold, so the fallback is the normal path here, not an edge case.
  const broker = makeBroker();
  await broker.connect();
  const spec = await broker.getSymbolSpec('EURUSD');
  assert.equal(spec.pointValuePerLot, 1);
  assert.equal(spec.pointValueEstimated, true, 'must be flagged as an estimate');
  await broker.disconnect();
});

test('computes spread in points from bid/ask', async () => {
  const broker = makeBroker();
  await broker.connect();
  await broker.getSymbolSpec('EURUSD'); // populate the point cache
  const quote = await broker.getQuote('EURUSD');
  // (1.15716 - 1.15704) / 0.00001 = 12
  assert.equal(quote.spreadPoints, 12);
  await broker.disconnect();
});

test('returns candles sorted oldest-first with sane OHLC', async () => {
  const broker = makeBroker();
  await broker.connect();
  const candles = await broker.getCandles('EURUSD', '5m', 8);
  assert.equal(candles.length, 8);
  for (let i = 1; i < candles.length; i++) {
    assert.ok(candles[i].time > candles[i - 1].time, 'candles must be ascending in time');
  }
  for (const c of candles) {
    assert.ok(c.high >= c.low, 'high must be >= low');
    assert.ok(typeof c.volume === 'number');
  }
  await broker.disconnect();
});

test('detects a demo account from trade_mode so the live-trading guard works', async () => {
  const broker = makeBroker();
  await broker.connect();
  const info = await broker.getAccountInfo();
  assert.equal(info.type, 'demo', 'trade_mode 0 must be reported as demo');
  assert.equal(info.currency, 'USD');
  assert.equal(info.balance, 10000);
  assert.equal(info.freeMargin, 9925.5, 'margin_free must map to freeMargin');
  await broker.disconnect();
});

test('opens a long position with the correct MT5 action, type, and stops', async () => {
  const broker = makeBroker();
  await broker.connect();

  const { positionId } = await broker.openPosition({
    symbol: 'EURUSD',
    side: 'long',
    volume: 0.1,
    stopLoss: 1.15,
    takeProfit: 1.16,
    comment: 'XAT:test',
  });
  assert.ok(positionId, 'must return a position id');

  const positions = await broker.getPositions();
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.side, 'long', 'MT5 type 0 must map to long');
  assert.equal(p.volume, 0.1);
  assert.equal(p.stopLoss, 1.15);
  assert.equal(p.takeProfit, 1.16);
  assert.equal(p.openTime, 1786910000 * 1000, 'position time must be ms');
  await broker.disconnect();
});

test('opens a short position mapped to MT5 sell type', async () => {
  const broker = makeBroker();
  await broker.connect();
  await broker.openPosition({ symbol: 'EURUSD', side: 'short', volume: 0.2 });
  const positions = await broker.getPositions();
  assert.equal(positions[0].side, 'short', 'MT5 type 1 must map to short');
  await broker.disconnect();
});

test('a long fills at ask and a short fills at bid', async () => {
  const broker = makeBroker();
  await broker.connect();

  await broker.openPosition({ symbol: 'EURUSD', side: 'long', volume: 0.1 });
  let positions = await broker.getPositions();
  assert.equal(positions[0].openPrice, 1.15716, 'buy must fill at ask');
  await broker.closePosition(positions[0].id);

  await broker.openPosition({ symbol: 'EURUSD', side: 'short', volume: 0.1 });
  positions = await broker.getPositions();
  assert.equal(positions[0].openPrice, 1.15704, 'sell must fill at bid');
  await broker.disconnect();
});

test('modifying a position updates its stop and target', async () => {
  const broker = makeBroker();
  await broker.connect();
  const { positionId } = await broker.openPosition({ symbol: 'EURUSD', side: 'long', volume: 0.1 });

  await broker.modifyPosition(positionId, 1.1, 1.2);
  const positions = await broker.getPositions();
  assert.equal(positions[0].stopLoss, 1.1);
  assert.equal(positions[0].takeProfit, 1.2);
  await broker.disconnect();
});

test('closing a position removes it', async () => {
  const broker = makeBroker();
  await broker.connect();
  const { positionId } = await broker.openPosition({ symbol: 'EURUSD', side: 'long', volume: 0.1 });
  assert.equal((await broker.getPositions()).length, 1);

  await broker.closePosition(positionId);
  assert.equal((await broker.getPositions()).length, 0);
  await broker.disconnect();
});

test('position history: open, then closed, with profit net of commission', async () => {
  const broker = makeBroker();
  await broker.connect();
  const { positionId } = await broker.openPosition({ symbol: 'EURUSD', side: 'short', volume: 0.1 });
  const open = await broker.getPositionHistory(positionId);
  assert.equal(open?.closed, false);
  assert.equal(open?.side, 'short');
  await broker.closePosition(positionId);
  const done = await broker.getPositionHistory(positionId);
  assert.equal(done?.closed, true);
  assert.equal(done?.reason, 'bot');
  assert.equal(done?.profit, -0.07, 'commission on the entry deal is part of the realised result');
  assert.equal(await broker.getPositionHistory('424242'), null);
  await broker.disconnect();
});

test('market status: not offered, open (with UTC+3 server clock), closed, close-only', async () => {
  const broker = makeBroker();
  await broker.connect();
  const btc = await broker.getMarketStatus('BTCUSD');
  assert.equal(btc.available, false);
  assert.match(btc.reason ?? '', /not offered by your broker/);

  const live = await broker.getMarketStatus('LIVEUSD');
  assert.equal(live.available, true);
  assert.equal(live.tradeMode, 'full');
  assert.equal(live.open, true);
  assert.ok(live.lastTickAt! <= Date.now() && Date.now() - live.lastTickAt! < 60_000, 'server-time tick converted to real time');

  const closed = await broker.getMarketStatus('CLOSEDUSD');
  assert.equal(closed.available, true);
  assert.equal(closed.open, false, 'zero bid/ask = closed');
  assert.match(closed.reason ?? '', /market is closed/);

  const co = await broker.getMarketStatus('CLOSEONLYUSD');
  assert.equal(co.tradeMode, 'close_only');
  assert.match(co.reason ?? '', /close-only/);
  await broker.disconnect();
});

test('a closed market whose last tick looks fresh is not reported as open, and does not teach a wrong clock', async () => {
  const broker = makeBroker();
  broker.frozenAfterMs = 300;
  await broker.connect();
  // First sight: the frozen tick happens to sit exactly on a UTC+3 boundary, so it looks 1 s old.
  const first = await broker.getMarketStatus('FROZENUSD');
  assert.notEqual(first.open, false, 'nothing contradicts it yet');
  await new Promise((r) => setTimeout(r, 450));
  // Second sight: the price has not moved, so it is a stopped price, not a live one.
  const second = await broker.getMarketStatus('FROZENUSD');
  assert.equal(second.open, false, 'a price that stopped moving is closed');
  assert.equal(second.lastTickAt, null, 'the clock learned from a stopped price is forgotten');
  // A genuinely live symbol is still recognised afterwards.
  const live = await broker.getMarketStatus('LIVEUSD');
  assert.equal(live.open, true);
  await broker.disconnect();
});

test('position history parses the exact deal shape the real bridge returned (TP hit)', () => {
  // Copied from history_deals_get(position=10637270848) on the live MetaQuotes-Demo account.
  const h = positionHistoryFromDeals('10637270848', [
    { ticket: 10367050239, order: 10637270848, time: 1790170504, time_msc: 1790170504310, type: 1, entry: 0, magic: 20260816, position_id: 10637270848, reason: 3, volume: 0.01, price: 4315.92, commission: 0, swap: 0, profit: 0, fee: 0, symbol: 'XAUUSD', comment: 'XAT:5b1fd6fe' },
    { ticket: 10367235552, order: 10637447249, time: 1790171258, time_msc: 1790171258140, type: 0, entry: 1, magic: 20260816, position_id: 10637270848, reason: 5, volume: 0.01, price: 4314.42, commission: 0, swap: 0, profit: 1.5, fee: 0, symbol: 'XAUUSD', comment: '[tp 4314.42]' },
  ]);
  assert.deepEqual(h, {
    positionId: '10637270848', symbol: 'XAUUSD', side: 'short', volume: 0.01,
    entryTime: 1790170504310, entryPrice: 4315.92, closed: true, closeTime: 1790171258140, closePrice: 4314.42,
    profit: 1.5, reason: 'tp',
  });
});

test('closing an unknown position fails loudly rather than silently', async () => {
  const broker = makeBroker();
  await broker.connect();
  await assert.rejects(() => broker.closePosition('999999'), /not found/i);
  await broker.disconnect();
});

/**
 * Regression guard for the real bug this adapter shipped with: it called
 * `account_info` when the bridge actually exposes `get_account_info`. The fake
 * server's tool list is a verbatim copy of a real server's, so exercising every
 * Broker method against it proves no call site references a tool that does not
 * exist. Any future rename breaks this test rather than a live trade.
 */
test('every broker method only calls tools the real bridge actually exposes', async () => {
  const broker = makeBroker();
  await broker.connect();

  // Touch every code path that issues a tool call.
  await broker.getSymbols();
  await broker.getSymbolSpec('EURUSD');
  await broker.getQuote('EURUSD');
  await broker.getCandles('EURUSD', '5m', 3);
  await broker.getAccountInfo();
  await broker.getPositions();

  const { positionId } = await broker.openPosition({ symbol: 'EURUSD', side: 'long', volume: 0.1 });
  await broker.modifyPosition(positionId, 1.1, 1.2);
  await broker.closePosition(positionId);

  await broker.disconnect();
});

test('initialize is skipped when no terminal path is set, since it requires one', async () => {
  // The real bridge rejects initialize({}) with "Missing required argument: path",
  // and the fake mirrors that. Connecting must still succeed, because an
  // already-running terminal does not need initialising.
  const broker = makeBroker();
  await broker.connect();
  const info = await broker.getAccountInfo();
  assert.equal(info.balance, 10000, 'account data must be readable without initialize');
  await broker.disconnect();
});

/**
 * The most dangerous real-world failure seen so far: MetaQuotes-Demo returned
 * `retcode: 0` with a real deal ticket and comment "Done" — the order FILLED —
 * but the bridge raised because it doesn't recognise 0 as success. Believing
 * that error would leave a live position the bot thinks it never opened: it
 * would keep no record, keep no stop management, and could stack more orders.
 */
test('an order that fills but reports an error is recognised as filled', async () => {
  const broker = makeBroker();
  await broker.connect();

  const { positionId } = await broker.openPosition({
    symbol: 'FLAKYUSD',
    side: 'short',
    volume: 0.01,
    stopLoss: 4418.18,
    takeProfit: 4415.68,
    comment: 'XAT:test',
  });

  assert.ok(positionId, 'must return the ticket of the position that really opened');
  const positions = await broker.getPositions();
  assert.equal(positions.length, 1, 'exactly one position, not zero and not two');
  assert.equal(positions[0].id, positionId, 'returned id must match the real position');
  assert.equal(positions[0].side, 'short');

  await broker.disconnect();
});

test('a close that succeeds but reports an error is recognised as closed', async () => {
  const broker = makeBroker();
  await broker.connect();

  const { positionId } = await broker.openPosition({ symbol: 'FLAKYUSD', side: 'long', volume: 0.01 });
  assert.equal((await broker.getPositions()).length, 1);

  // Must not throw — the position really is gone.
  await broker.closePosition(positionId);
  assert.equal((await broker.getPositions()).length, 0, 'position must be gone');

  await broker.disconnect();
});

test('a genuinely failed order still throws — the recovery must not mask real failures', async () => {
  const broker = makeBroker();
  await broker.connect();
  // Broker rejects with retcode 10015 and opens nothing, so the
  // verify-against-broker recovery must not rescue it.
  await assert.rejects(
    () => broker.openPosition({ symbol: 'REJECTUSD', side: 'long', volume: 0.01 }),
    (err: Error) => {
      assert.match(err.message, /10015|rejected/i, `unhelpful error: ${err.message}`);
      return true;
    },
  );
  assert.equal((await broker.getPositions()).length, 0, 'nothing should have opened');
  await broker.disconnect();
});

test('a failing spawn produces an actionable error, not a raw stack trace', async () => {
  const broker = new Mt5McpBroker({
    transport: 'stdio',
    command: 'definitely-not-a-real-command-xyz',
    args: [],
  });
  await assert.rejects(
    () => broker.connect(),
    (err: Error) => {
      assert.match(err.message, /Could not start the MT5 bridge/);
      assert.match(err.message, /PATH/, 'should tell the user what to check');
      return true;
    },
  );
});

/**
 * A closed market is a daily event — gold stops quoting for roughly an hour
 * every day, and everything stops all weekend. Treating that as a hard error
 * made a normal break look like a broken bot and buried real errors in noise.
 */
test('a zero bid/ask is reported as market-closed, not a generic failure', async () => {
  const { MarketClosedError } = await import('./mt5mcp.js');
  const broker = makeBroker();
  await broker.connect();

  await assert.rejects(
    () => broker.openPosition({ symbol: 'CLOSEDUSD', side: 'long', volume: 0.01 }),
    (err: Error) => {
      assert.ok(err instanceof MarketClosedError, `expected MarketClosedError, got ${err.name}`);
      assert.match(err.message, /not quoting|closed|daily break/i);
      return true;
    },
  );
  assert.equal((await broker.getPositions()).length, 0, 'nothing may open with no price');
  await broker.disconnect();
});

test('retcode 10021 becomes a market-closed error with a readable explanation', async () => {
  const { MarketClosedError } = await import('./mt5mcp.js');
  const broker = makeBroker();
  await broker.connect();

  await assert.rejects(
    () => broker.openPosition({ symbol: 'PRICEOFFUSD', side: 'long', volume: 0.01 }),
    (err: Error) => {
      assert.ok(err instanceof MarketClosedError, `expected MarketClosedError, got ${err.name}`);
      // Must explain, not just echo the number.
      assert.match(err.message, /not quoting|maintenance break|market is closed/i);
      return true;
    },
  );
  await broker.disconnect();
});

test('a rejection that is NOT about prices stays a normal error', async () => {
  const { MarketClosedError } = await import('./mt5mcp.js');
  const broker = makeBroker();
  await broker.connect();
  await assert.rejects(
    () => broker.openPosition({ symbol: 'REJECTUSD', side: 'long', volume: 0.01 }),
    (err: Error) => {
      assert.ok(!(err instanceof MarketClosedError), 'must not be misfiled as market-closed');
      assert.match(err.message, /Invalid price|10015|rejected/i);
      return true;
    },
  );
  await broker.disconnect();
});

/**
 * Filling mode is per-SYMBOL, not per-account: this broker took IOC on gold
 * and rejected it on GBPUSD with retcode 10030. Making the user discover that
 * by hand and edit a config file is a bad answer — the symbol's own mask says
 * what it allows, so the adapter reads it and adapts.
 */
test('an IOC rejection is retried with a filling mode the symbol allows', async () => {
  const broker = makeBroker();
  await broker.connect();

  // filling_mode 1 = FOK only. IOC is tried first and rejected; FOK must win.
  const { positionId } = await broker.openPosition({
    symbol: 'FOKONLYUSD',
    side: 'long',
    volume: 0.01,
    comment: 'XAT:test',
  });

  assert.ok(positionId, 'must succeed by falling back to a supported mode');
  const positions = await broker.getPositions();
  assert.equal(positions.length, 1, 'exactly one position — the retry must not double-fill');
  await broker.disconnect();
});

test('the working filling mode is remembered, so the retry happens once', async () => {
  const broker = makeBroker();
  await broker.connect();

  const first = await broker.openPosition({ symbol: 'FOKONLYUSD', side: 'long', volume: 0.01 });
  await broker.closePosition(first.positionId);
  const second = await broker.openPosition({ symbol: 'FOKONLYUSD', side: 'long', volume: 0.01 });

  assert.ok(second.positionId, 'second order must also succeed');
  assert.equal((await broker.getPositions()).length, 1, 'no stray positions from retries');
  await broker.disconnect();
});

test('a non-filling failure is NOT retried across modes', async () => {
  // Retrying "no prices" three times would just make a closed market three
  // times as noisy in the log.
  const { MarketClosedError } = await import('./mt5mcp.js');
  const broker = makeBroker();
  await broker.connect();
  await assert.rejects(
    () => broker.openPosition({ symbol: 'PRICEOFFUSD', side: 'long', volume: 0.01 }),
    (err: Error) => err instanceof MarketClosedError,
  );
  await broker.disconnect();
});

/**
 * The bridge labels MetaTrader's SERVER time as UTC, and this broker runs
 * UTC+3 — so fresh candles carry timestamps up to three hours in the future.
 *
 * Any code that decides "has this bar finished?" by comparing to the wall
 * clock therefore throws away every recent bar. That produced "no completed
 * bars for GBPUSD" on a healthy feed, and in the live runner it would have
 * silently evaluated signals on a bar hours old — a far worse outcome, because
 * it fails quietly.
 */
test('candle timestamps can be ahead of real UTC, and that must not break anything', async () => {
  const broker = makeBroker();
  await broker.connect();

  const candles = await broker.getCandles('RECENTUSD', '5m', 7);
  assert.equal(candles.length, 7, 'all bars must survive parsing');

  const newest = candles[candles.length - 1].time;
  assert.ok(
    newest > Date.now(),
    'fixture must reproduce the skew: newest bar should look like it is in the future',
  );

  for (let i = 1; i < candles.length; i++) {
    assert.ok(candles[i].time > candles[i - 1].time, 'bars must still be ordered oldest-first');
  }
  await broker.disconnect();
});

test('dropping the forming bar by position survives the server-time skew', async () => {
  // This is the shape the levels route and the live runner both rely on:
  // "the last bar is the forming one" is true regardless of timezone, whereas
  // "the bar has finished if its end time has passed" is not.
  const broker = makeBroker();
  await broker.connect();
  const candles = await broker.getCandles('RECENTUSD', '5m', 7);

  const byPosition = candles.slice(0, -1);
  assert.equal(byPosition.length, 6, 'positional drop always leaves N-1 bars');

  const byClock = candles.filter((c) => c.time + 5 * 60_000 <= Date.now());
  assert.equal(byClock.length, 0, 'the old clock-based test discarded everything — the bug');

  await broker.disconnect();
});
