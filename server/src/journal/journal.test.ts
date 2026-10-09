import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BrokerPosition, PositionHistory } from '../broker/types.js';
import type { LogEntry } from '../store.js';
import { buildJournal } from './journal.js';

const tagOf = (id: string) => `XAT:${id.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
const HFT = 'str_5b1fd6fe';
const GQ = 'str_fg8207hm';
let n = 0;
const log = (ts: number, strategyId: string, event: string, message: string, data: unknown): LogEntry => ({ id: ++n, ts, strategyId, level: 'trade', event, message, data });

// Shapes copied from the live log on 2026-09-23.
const rows: LogEntry[] = [
  log(1000, HFT, 'entry', 'Opened SHORT 0.01 XAUUSD @ ~4315.92 (SL 4317.17, TP 4314.42)', { positionId: '10637270848', lots: 0.01, sl: 4317.17, tp: 4314.42, spreadPoints: 38 }),
  log(2000, HFT, 'position_closed', 'SHORT 0.01 XAUUSD closed at 4314.42 (take-profit) for 1.50', { positionId: '10637270848', profit: 1.5, closePrice: 4314.42, reason: 'tp', source: 'broker_history' }),
  log(3000, HFT, 'entry', 'Opened LONG 0.01 XAUUSD @ ~4316.52 (SL 4315.38, TP 4317.89)', { positionId: '2', lots: 0.01, sl: 4315.38, tp: 4317.89 }),
  log(3600, HFT, 'exit', 'Closed LONG 0.01 XAUUSD on opposite signal (P&L -0.49)', { id: '2', symbol: 'XAUUSD', side: 'long', volume: 0.01, openPrice: 4316.52, currentPrice: 4316.03, profit: -0.49, comment: 'XAT:5b1fd6fe' }),
  // Old bug: another bot's position booked under HFT — must be ignored.
  log(3700, HFT, 'position_closed', 'SHORT 0.01 EURUSD closed at ~1.1 for 0.01', { id: '99', symbol: 'EURUSD', side: 'short', volume: 0.01, profit: 0.01, comment: 'XAT:oouli9cz' }),
  log(4000, HFT, 'entry', 'Opened SHORT 0.01 XAUUSD @ ~4314.63 (SL 4315.74, TP 4313.3)', { positionId: '3', lots: 0.01, sl: 4315.74, tp: 4313.3 }),
  log(5000, GQ, 'entry', 'Opened LONG 0.01 EURUSD @ ~1.14 (SL 1.139, TP 1.141)', { positionId: '4', side: 'long', symbol: 'EURUSD', entryPrice: 1.14, lots: 0.01, sl: 1.139, tp: 1.141 }),
  log(6000, GQ, 'entry', 'Opened LONG 0.01 EURUSD @ ~1.141 (SL 1.14, TP 1.142)', { positionId: '5', lots: 0.01, sl: 1.14, tp: 1.142 }),
  log(6500, GQ, 'panic_close', 'Force-closed LONG 0.01 EURUSD (P&L -0.03)', { id: '5', profit: -0.03, symbol: 'EURUSD', side: 'long', volume: 0.01, openPrice: 1.141, currentPrice: 1.1407 }),
];
const hist: PositionHistory = { positionId: '3', symbol: 'XAUUSD', side: 'short', volume: 0.01, entryTime: 0, entryPrice: 4314.6, closed: true, closeTime: 0, closePrice: 4315.74, profit: -1.2, reason: 'sl' };
const openPos: BrokerPosition = { id: '4', symbol: 'EURUSD', side: 'long', volume: 0.01, openPrice: 1.14002, currentPrice: 1.1405, stopLoss: 1.139, takeProfit: 1.141, profit: 0.48, swap: 0, commission: 0, openTime: 0, comment: 'XAT:fg8207hm' };

const journal = () =>
  buildJournal({
    logs: rows,
    strategyNames: new Map([[HFT, 'M1 HFT EMA Scalp'], [GQ, 'M1 Gold Quick Scalp']]),
    histories: new Map([['3', hist]]),
    openPositions: [openPos],
    tagOf,
  });

test('one row per position, newest first, foreign closes ignored', () => {
  const j = journal();
  assert.deepEqual(j.map((t) => t.positionId), ['5', '4', '3', '2', '10637270848']);
});

test('take-profit trade: prices, times, duration, planned R:R, win', () => {
  const t = journal().find((x) => x.positionId === '10637270848')!;
  assert.equal(t.strategyName, 'M1 HFT EMA Scalp');
  assert.equal(t.side, 'short');
  assert.equal(t.symbol, 'XAUUSD');
  assert.equal(t.openPrice, 4315.92);
  assert.equal(t.closePrice, 4314.42);
  assert.equal(t.exitReason, 'tp');
  assert.equal(t.outcome, 'win');
  assert.equal(t.durationMs, 1000);
  assert.equal(t.plannedRR, 1.2);
});

test('bot exit on opposite signal, stop-loss from MT5 history, panic close', () => {
  const j = journal();
  const opp = j.find((x) => x.positionId === '2')!;
  assert.equal(opp.exitReason, 'opposite');
  assert.equal(opp.outcome, 'loss');
  const sl = j.find((x) => x.positionId === '3')!;
  assert.equal(sl.exitReason, 'sl');
  assert.equal(sl.profit, -1.2, 'MT5 history wins over the log');
  assert.equal(sl.openPrice, 4314.6);
  assert.equal(sl.source, 'broker');
  const panic = j.find((x) => x.positionId === '5')!;
  assert.equal(panic.exitReason, 'panic');
});

test('open trade shows floating P&L and live price', () => {
  const t = journal().find((x) => x.positionId === '4')!;
  assert.equal(t.status, 'open');
  assert.equal(t.outcome, 'open');
  assert.equal(t.profit, 0.48);
  assert.equal(t.currentPrice, 1.1405);
  assert.equal(t.closeTime, null);
});

test('an entry with no close, no history and not open is flagged, not counted as a win or loss', () => {
  const j = buildJournal({ logs: [rows[5]], strategyNames: new Map(), histories: new Map(), openPositions: [], tagOf });
  assert.equal(j[0].status, 'unrecorded');
  assert.equal(j[0].outcome, 'unknown');
});

// C-6
test('journal totals leave out test strategies', () => {
  const all = journal();
  const withoutGq = buildJournal({
    logs: rows,
    strategyNames: new Map([[HFT, 'M1 HFT EMA Scalp'], [GQ, 'M1 Gold Quick Scalp']]),
    histories: new Map([['3', hist]]),
    openPositions: [openPos],
    tagOf,
    excludeStrategyIds: new Set([GQ]),
  });
  assert.ok(all.some((t) => t.strategyId === GQ), 'fixture has trades from the test strategy');
  assert.ok(withoutGq.length < all.length);
  assert.ok(withoutGq.every((t) => t.strategyId !== GQ), 'none of its trades (open or closed) remain');
  const net = (ts: { profit: number | null }[]) => ts.reduce((a, t) => a + (t.profit ?? 0), 0);
  const gqNet = net(all.filter((t) => t.strategyId === GQ));
  assert.ok(Math.abs(net(withoutGq) - (net(all) - gqNet)) < 1e-9, 'the total moves by exactly the test strategy result');
  // An empty exclusion set changes nothing.
  assert.equal(buildJournal({ logs: rows, strategyNames: new Map([[HFT, 'x'], [GQ, 'y']]), histories: new Map([['3', hist]]), openPositions: [openPos], tagOf, excludeStrategyIds: new Set() }).length, all.length);
});
