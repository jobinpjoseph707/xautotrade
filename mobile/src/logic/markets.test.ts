import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MarketStatus } from '../types';
import { DUBAI_NOTE, sortMarkets, summaryLine, tradingNow, USUAL_HOURS, WATCHLIST } from './markets';

const st = (symbol: string, o: Partial<MarketStatus> = {}): MarketStatus => ({
  symbol, available: true, tradeMode: 'full', open: true, lastTickAt: 1, bid: 1, ask: 1.1, spreadPoints: 20,
  description: null, reason: null, checkedAt: 1, ...o,
});

// MK-1
test('MK-1 only a market with an open price feed and full trading counts as open', () => {
  assert.equal(tradingNow(st('A')), 'open');
  assert.equal(tradingNow(st('A', { open: false })), 'closed');
  assert.equal(tradingNow(st('A', { open: null })), 'closed', 'unknown is never reported as open');
  assert.equal(tradingNow(st('A', { available: false })), 'unavailable');
  assert.equal(tradingNow(st('A', { tradeMode: 'disabled' })), 'unavailable');
  assert.equal(tradingNow(st('A', { tradeMode: 'close_only' })), 'unavailable');
  assert.equal(tradingNow(st('A', { tradeMode: 'long_only' })), 'open');
});

// MK-2
test('MK-2 markets are sorted into three groups; unanswered symbols are not on this account', () => {
  const r = sortMarkets([st('XAUUSD'), st('EURUSD', { open: false, reason: 'Weekend.' }), st('BTCUSD', { available: false, reason: 'Not offered.' })]);
  assert.deepEqual(r.open.map((x) => x.symbol), ['XAUUSD']);
  assert.deepEqual(r.closed.map((x) => x.symbol), ['EURUSD']);
  assert.equal(r.closed[0].note, 'Weekend.');
  assert.ok(r.unavailable.some((x) => x.symbol === 'BTCUSD'));
  assert.ok(r.unavailable.some((x) => x.symbol === 'US30'), 'no answer = not on this account');
  assert.equal(r.open.length + r.closed.length + r.unavailable.length, WATCHLIST.length);
});

// MK-3
test('MK-3 open markets are listed cheapest spread first, unknown spreads last', () => {
  const r = sortMarkets([st('XAUUSD', { spreadPoints: 30 }), st('EURUSD', { spreadPoints: 8 }), st('GBPUSD', { spreadPoints: null }), st('USDJPY', { spreadPoints: 12 })]);
  assert.deepEqual(r.open.map((x) => x.symbol), ['EURUSD', 'USDJPY', 'XAUUSD', 'GBPUSD']);
});

// MK-4
test('MK-4 the summary says how many are open, and says so plainly when none are', () => {
  assert.match(summaryLine(sortMarkets([st('XAUUSD'), st('EURUSD')])), /^2 of \d+ watched markets are open/);
  assert.match(summaryLine(sortMarkets([])), /^None of \d+ watched markets is open/);
});

// MK-5
test('MK-5 watchlist symbols are unique, every group has usual hours, and no profit is promised', () => {
  assert.equal(new Set(WATCHLIST.map((w) => w.symbol)).size, WATCHLIST.length);
  for (const g of new Set(WATCHLIST.map((w) => w.group))) assert.ok(USUAL_HOURS.some((h) => h.group === g), `no hours for ${g}`);
  for (const t of [...USUAL_HOURS.map((h) => h.text), DUBAI_NOTE]) assert.ok(!/guarantee|will profit|risk-free|sure thing/i.test(t), t);
  assert.match(DUBAI_NOTE, /UTC\+4/);
});
