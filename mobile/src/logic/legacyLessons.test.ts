import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LegacyLesson } from '../types';
import { legacyLine, marketLabel, sortLegacy } from './legacyLessons';

const row = (over: Partial<LegacyLesson> = {}): LegacyLesson => ({
  id: 'legacy:a', createdAt: 1, weekStart: '2026-09-14T00:00:00.000Z', strategyName: 'EMA', market: { symbol: 'XAUUSD', timeframe: '5m' },
  verdict: 'fail', returnPct: -1.7, rootCause: 'SESSION_CLUSTER', summary: '5 of 6 losses came in the asia session.', change: null, displayOnly: false, ...over,
});

test('a lesson with a market names it, one without says so', () => {
  assert.equal(marketLabel(row()), 'XAUUSD 5m');
  assert.equal(marketLabel(row({ market: null })), 'No market recorded');
  assert.equal(legacyLine(row()), '2026-09-14 · XAUUSD 5m · return -1.7%');
  assert.equal(legacyLine(row({ weekStart: null, returnPct: null, market: null })), 'date unknown · No market recorded');
});

test('lessons with a market come first, newest first', () => {
  const sorted = sortLegacy([row({ id: 'x', displayOnly: true, createdAt: 9 }), row({ id: 'old', createdAt: 1 }), row({ id: 'new', createdAt: 5 })]);
  assert.deepEqual(sorted.map((l) => l.id), ['new', 'old', 'x']);
});
