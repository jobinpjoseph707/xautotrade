import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BrokerPosition } from '../types';
import { dashboardTotals, tagOf } from './totals';

const pos = (id: string, strategyId: string, profit: number): BrokerPosition => ({
  id, symbol: 'XAUUSD', side: 'long', volume: 0.01, openPrice: 1, currentPrice: 1, stopLoss: null, takeProfit: null,
  profit, swap: 0, commission: 0, openTime: 0, comment: tagOf(strategyId),
});

const strategies = [{ id: 'str_real0001' }, { id: 'str_test0001', isTest: true }];
const rows = [
  { strategy: strategies[0], realised: 10, trades: 3 },
  { strategy: strategies[1], realised: -50, trades: 40 },
];
const positions = [pos('1', 'str_real0001', 4), pos('2', 'str_test0001', -9)];

test('dashboard totals leave out test strategies', () => {
  const t = dashboardTotals(rows, positions, strategies);
  assert.deepEqual(t, { realised: 10, trades: 3, floating: 4, openCount: 1 });
});

test('with no test strategies every row counts', () => {
  const plain = [{ id: 'str_real0001' }, { id: 'str_test0001' }];
  const t = dashboardTotals([{ ...rows[0], strategy: plain[0] }, { ...rows[1], strategy: plain[1] }], positions, plain);
  assert.deepEqual(t, { realised: -40, trades: 43, floating: -5, openCount: 2 });
});

test('the order tag is the last 8 letters and digits of the id', () => {
  assert.equal(tagOf('str_5b1fd6fe'), 'XAT:5b1fd6fe');
});
