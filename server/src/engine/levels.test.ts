/**
 * Tests for the chart-level publisher consumed by XATLevels.mq5.
 *
 * The CSV contract matters as much as the maths here: the EA splits rows
 * naively on ',', so a stray comma in a label silently shifts every column
 * and the line lands at the wrong price.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseBars,
  rangeOf,
  levelsFromRange,
  barsForMinutes,
  serialise,
  type Bar,
} from './levels.js';

const t = test;

t('unwraps FastMCP { result: [...] }', () => {
  const raw = { result: [{ time: '2026-08-20T09:00:00', open: 1, high: 3, low: 0.5, close: 2 }] };
  const bars = normaliseBars(raw);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].high, 3);
});

t('accepts a bare array too', () => {
  const raw = [{ time: '2026-08-20T09:00:00', open: 1, high: 3, low: 0.5, close: 2 }];
  assert.equal(normaliseBars(raw).length, 1);
});

t('parses ISO-8601 timestamps to epoch seconds', () => {
  const bars = normaliseBars([
    { time: '2026-08-20T09:05:00Z', open: 1, high: 1, low: 1, close: 1 },
  ]);
  assert.equal(bars[0].time, Math.floor(Date.parse('2026-08-20T09:05:00Z') / 1000));
  assert.ok(Number.isFinite(bars[0].time), 'must not be NaN');
});

t('still accepts numeric epoch seconds', () => {
  const bars = normaliseBars([{ time: 1755680700, open: 1, high: 1, low: 1, close: 1 }]);
  assert.equal(bars[0].time, 1755680700);
});

t('throws loudly on an unparseable time (does not silently NaN)', () => {
  assert.throws(() =>
    normaliseBars([{ time: 'not-a-date', open: 1, high: 1, low: 1, close: 1 }])
  );
});

t('throws on a non-finite OHLC value', () => {
  assert.throws(() =>
    normaliseBars([{ time: 1755680700, open: 1, high: 'x' as unknown as number, low: 1, close: 1 }])
  );
});


const mk = (time: number, high: number, low: number): Bar => ({
  time, open: (high + low) / 2, high, low, close: (high + low) / 2,
});

t('picks highest high and lowest low', () => {
  const bars = [mk(100, 3410.5, 3405.0), mk(400, 3418.2, 3408.1), mk(700, 3412.0, 3401.7)];
  const r = rangeOf(bars);
  assert.equal(r.high, 3418.2);
  assert.equal(r.low, 3401.7);
  assert.equal(r.barCount, 3);
  assert.equal(r.fromTime, 100);
  assert.equal(r.toTime, 700);
});

t('single bar is its own range', () => {
  const r = rangeOf([mk(100, 5, 1)]);
  assert.equal(r.high, 5);
  assert.equal(r.low, 1);
});

t('empty input throws rather than returning Infinity', () => {
  assert.throws(() => rangeOf([]));
});


t('30 minutes on M5 is 6 bars', () => assert.equal(barsForMinutes(30, 5), 6));
t('30 minutes on M1 is 30 bars', () => assert.equal(barsForMinutes(30, 1), 30));
t('rounds up on a partial fit', () => assert.equal(barsForMinutes(30, 15), 2));
t('never returns zero', () => assert.equal(barsForMinutes(1, 60), 1));


t('emits one resistance and one support line', () => {
  const bars = [mk(100, 3418.2, 3405.0), mk(400, 3415.0, 3401.7)];
  const ls = levelsFromRange('XAUUSD', bars, { idPrefix: 'm30' });
  assert.equal(ls.length, 2);
  assert.equal(ls[0].id, 'm30_res');
  assert.equal(ls[0].price1, 3418.2);
  assert.equal(ls[1].id, 'm30_sup');
  assert.equal(ls[1].price1, 3401.7);
  assert.ok(ls.every(l => l.kind === 'HLINE' && l.symbol === 'XAUUSD'));
});

t('stable ids mean a refresh updates rather than accumulates', () => {
  const a = levelsFromRange('XAUUSD', [mk(100, 10, 5)], { idPrefix: 'm30' });
  const b = levelsFromRange('XAUUSD', [mk(400, 12, 4)], { idPrefix: 'm30' });
  assert.deepEqual(a.map(x => x.id), b.map(x => x.id));
});


t('has header and one row per level', () => {
  const csv = serialise(levelsFromRange('XAUUSD', [mk(100, 3418.2, 3401.7)], { idPrefix: 'm30' }));
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].startsWith('#'));
  assert.equal(lines[1], 'symbol,kind,id,price1,time1,price2,time2,color,width,style,label');
  assert.equal(lines.length, 4);
});

t('column count matches the header on every row', () => {
  const csv = serialise(levelsFromRange('XAUUSD', [mk(100, 3418.2, 3401.7)]));
  const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('#'));
  const cols = lines[0].split(',').length;
  for (const l of lines.slice(1)) assert.equal(l.split(',').length, cols, `row: ${l}`);
});

t('strips commas from labels so rows cannot break the EA parser', () => {
  const csv = serialise([
    { symbol: 'XAUUSD', kind: 'HLINE', id: 'x', price1: 1, label: 'a,b\nc' },
  ]);
  const row = csv.trim().split('\n').filter(l => !l.startsWith('#'))[1];
  assert.equal(row.split(',').length, 11);
});

t('empty level list still produces a valid header-only file', () => {
  const csv = serialise([]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2);
});


// ---------------------------------------------------------------------------
// Multi-source publishing
// ---------------------------------------------------------------------------

/**
 * There is one file and the EA renders all of it, so every writer shares it.
 * Without a registry the second writer silently erases the first — a bot on
 * GBPUSD would wipe the lines of a bot on XAUUSD, and nothing would say so.
 */
test('two sources both survive in the published file', async () => {
  const { publishFromSource, readPublished, clearSource } = await import('./levels.js');

  await publishFromSource('bot:a', [
    { symbol: 'GBPUSD', kind: 'HLINE', id: 'a_res', price1: 1.36 },
    { symbol: 'GBPUSD', kind: 'HLINE', id: 'a_sup', price1: 1.35 },
  ]);
  await publishFromSource('bot:b', [
    { symbol: 'XAUUSD', kind: 'HLINE', id: 'b_res', price1: 4500 },
  ]);

  const raw = await readPublished();
  assert.match(raw, /a_res/, 'first source must survive the second publish');
  assert.match(raw, /a_sup/);
  assert.match(raw, /b_res/, 'second source must be present too');

  await clearSource('bot:a');
  await clearSource('bot:b');
});

test('clearing one source leaves the others drawn', async () => {
  const { publishFromSource, readPublished, clearSource } = await import('./levels.js');

  await publishFromSource('manual', [{ symbol: 'GBPUSD', kind: 'HLINE', id: 'manual_x', price1: 1.36 }]);
  await publishFromSource('bot:keep', [{ symbol: 'XAUUSD', kind: 'HLINE', id: 'keep_x', price1: 4500 }]);

  await clearSource('manual');

  const raw = await readPublished();
  assert.doesNotMatch(raw, /manual_x/, 'cleared source must be gone');
  assert.match(raw, /keep_x/, 'the other source must remain');

  await clearSource('bot:keep');
});

test('re-publishing a source replaces its levels rather than stacking them', async () => {
  const { publishFromSource, readPublished, clearSource } = await import('./levels.js');

  await publishFromSource('bot:x', [{ symbol: 'GBPUSD', kind: 'HLINE', id: 'x_res', price1: 1.36 }]);
  await publishFromSource('bot:x', [{ symbol: 'GBPUSD', kind: 'HLINE', id: 'x_res', price1: 1.37 }]);

  const rows = (await readPublished())
    .split('\n')
    .filter((l) => l.includes('x_res'));
  assert.equal(rows.length, 1, 'a refresh must move the line, not add a second one');
  assert.match(rows[0], /1\.37/, 'and it must hold the new price');

  await clearSource('bot:x');
});
