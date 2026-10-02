import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dailyStatsFromLogs, estimateServerOffset, utcDayKey, utcDayStart } from './daily.js';

const H = 3_600_000;

test('server offset: UTC+3 broker detected from a fresh quote, rounded to 30 min', () => {
  const now = Date.UTC(2026, 8, 23, 12, 36, 10);
  assert.equal(estimateServerOffset(now + 3 * H + 4_000, now, 0), 3 * H);
  assert.equal(estimateServerOffset(now + 5.5 * H - 20_000, now, 0), 5.5 * H, 'half-hour zones');
  assert.equal(estimateServerOffset(now - 2_000, now, 0), 0, 'UTC broker / paper');
});

test('server offset: stale or absurd quotes keep the previous estimate', () => {
  const now = Date.UTC(2026, 8, 23, 12, 36, 10);
  // Market closed: last tick from Friday evening.
  assert.equal(estimateServerOffset(now - 40 * H - 17 * 60_000, now, 3 * H), 3 * H);
  assert.equal(estimateServerOffset(now + 3 * H + 13 * 60_000, now, 3 * H), 3 * H, '13 min off an hour boundary = stale');
  assert.equal(estimateServerOffset(0, now, 3 * H), 3 * H);
  assert.equal(estimateServerOffset(Number.NaN, now, 3 * H), 3 * H);
});

test('daily stats rebuilt from the trade log after a restart', () => {
  const s = dailyStatsFromLogs([
    { event: 'entry', data: { lots: 0.01 } },
    { event: 'entry', data: { lots: 0.01 } },
    { event: 'position_closed', data: { profit: -3.5 } },
    { event: 'exit', data: { profit: 10 } },
    { event: 'trail', data: { profit: 99 } },
  ]);
  assert.deepEqual(s, { tradesToday: 2, realisedToday: 6.5 });
});

test('UTC day helpers', () => {
  const t = Date.UTC(2026, 8, 23, 23, 59);
  assert.equal(utcDayStart(t), Date.UTC(2026, 8, 23));
  assert.equal(utcDayKey(t), '2026-8-23');
});

test('daily stats ignore closes of other bots\' positions', () => {
  const s = dailyStatsFromLogs([
    { event: 'entry', data: { positionId: 'a' } },
    { event: 'position_closed', data: { id: 'a', comment: 'XAT:mine1234', profit: 2 } },
    { event: 'position_closed', data: { id: 'z', comment: 'XAT:other999', profit: 50 } },
  ], 'XAT:mine1234');
  assert.deepEqual(s, { tradesToday: 1, realisedToday: 2 });
});
