import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Broker, PositionHistory } from '../broker/types.js';
import type { LogEntry } from '../store.js';
import { ownCloses, positionIdOf, reconcileClosures, unmatchedEntries } from './reconcile.js';

const H = 3_600_000;
const e = (id: number, ts: number, event: string, data: unknown): LogEntry => ({ id, ts, strategyId: 's1', level: 'trade', event, message: event, data });

test('positionIdOf reads every shape the runner has written', () => {
  assert.equal(positionIdOf({ data: { positionId: '1' } }), '1');
  assert.equal(positionIdOf({ data: { id: 2 } }), '2');
  assert.equal(positionIdOf({ data: {} }), null);
});

test('unmatched = entries with no logged close that are not open now', () => {
  const list = [
    e(1, 1, 'entry', { positionId: 'a' }),
    e(2, 2, 'position_closed', { id: 'a', profit: 1 }),
    e(3, 3, 'entry', { positionId: 'b' }), // still open
    e(4, 4, 'entry', { positionId: 'c' }), // closed unseen
    e(5, 5, 'entry', { positionId: 'd' }),
    e(6, 6, 'exit', { id: 'd', profit: -1 }),
  ];
  assert.deepEqual(unmatchedEntries(list, new Set(['b'])).map(positionIdOf), ['c']);
});

test('reconcile books missed closes from broker history at the real (UTC) close time, once', async () => {
  const now = Date.UTC(2026, 8, 23, 12, 0);
  const rows: LogEntry[] = [
    e(1, now - 2 * H, 'entry', { positionId: '100' }),
    e(2, now - 1 * H, 'entry', { positionId: '200' }), // still open at the broker
    e(3, now - 30 * 60_000, 'entry', { positionId: '300' }), // no history yet
  ];
  const store = {
    tradesBetween: () => rows,
    add: (x: Omit<LogEntry, 'id'>) => { const r = { ...x, id: rows.length + 1 }; rows.push(r); return r; },
  };
  const hist: Record<string, PositionHistory> = {
    '100': { positionId: '100', symbol: 'XAUUSD', side: 'short', volume: 0.01, entryTime: now - 2 * H + 3 * H + 800, entryPrice: 4315.92,
      closed: true, closeTime: now - 90 * 60_000 + 3 * H, closePrice: 4314.42, profit: 1.5, reason: 'tp' },
  };
  const broker = { getPositionHistory: async (id: string) => hist[id] ?? null } as unknown as Broker;
  const added = await reconcileClosures('s1', broker, store, { since: 0, openIds: new Set(['200']), now });
  assert.equal(added.length, 1);
  assert.equal(added[0].event, 'position_closed');
  assert.equal((added[0].data as { profit: number }).profit, 1.5);
  assert.equal(added[0].ts, now - 90 * 60_000, 'broker time (UTC+3) converted back to real time');
  assert.match(added[0].message, /take-profit/);
  const again = await reconcileClosures('s1', broker, store, { since: 0, openIds: new Set(['200']), now });
  assert.equal(again.length, 0, 'never books the same close twice');
});

test('reconcile is a no-op on brokers without deal history', async () => {
  const added = await reconcileClosures('s1', {} as Broker, { tradesBetween: () => [e(1, 1, 'entry', { positionId: 'x' })], add: () => { throw new Error('no'); } }, { since: 0, openIds: new Set() });
  assert.deepEqual(added, []);
});

test('ownCloses drops other bots\' positions and duplicate closes (old logging bug, real rows)', () => {
  const rows = [
    e(1, 1, 'position_closed', { id: '10635092427', comment: 'XAT:5b1fd6fe', symbol: 'XAUUSD', profit: 0.69 }),
    e(2, 2, 'position_closed', { id: '10635167806', comment: 'XAT:oouli9cz', symbol: 'EURUSD', profit: 0.01 }),
    e(3, 3, 'position_closed', { id: '10633832393', comment: 'XAT:58ja0dnv', symbol: 'GBPUSD', profit: -0.54 }),
    e(4, 4, 'position_closed', { id: '10633832393', comment: 'XAT:58ja0dnv', symbol: 'GBPUSD', profit: -0.36 }),
    e(5, 5, 'position_closed', { positionId: '10637270848', profit: 1.5, source: 'broker_history' }),
    e(6, 6, 'position_closed', { id: '10637270848', comment: 'XAT:5b1fd6fe', profit: 1.4 }),
    e(7, 7, 'entry', { positionId: '1' }),
  ];
  const own = ownCloses(rows, 'XAT:5b1fd6fe').map((r) => r.id);
  assert.deepEqual(own, [1, 5], 'foreign rows gone; duplicate keeps the broker-history row');
});
