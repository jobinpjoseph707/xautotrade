import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOverlays, indicatorLabel, mqlColor, OVERLAY_COLORS } from './overlays.js';
import { serialise } from './levels.js';
import { emaPullbackScalp } from './presets.js';
import { evaluateGroup } from './rules.js';
import { computeIndicators } from './indicators.js';
import type { Candle } from './types.js';

function candles(n: number): Candle[] {
  const out: Candle[] = [];
  let p = 2400;
  const t0 = Date.UTC(2026, 8, 23, 6) + 3 * 3_600_000; // broker time (UTC+3)
  for (let k = 0; k < n; k++) {
    const drift = Math.sin(k / 9) * 1.2 + Math.cos(k / 23) * 0.8;
    const open = p;
    p = p + drift;
    out.push({ time: t0 + k * 300_000, open, high: Math.max(open, p) + 0.4, low: Math.min(open, p) - 0.4, close: p, volume: 1 });
  }
  return out;
}

test('mqlColor turns #RRGGBB into the EA\'s 0xBBGGRR decimal', () => {
  assert.equal(mqlColor('#3987E5'), String((0xe5 << 16) | (0x87 << 8) | 0x39));
  assert.equal(mqlColor('#FF0000'), '255');
});

test('overlays draw every price indicator as a ray-less polyline over the requested bars', () => {
  const s = emaPullbackScalp('XAUUSD');
  const c = candles(400);
  const r = buildOverlays(s, c, [], { bars: 100 });
  const priceInds = s.indicators.filter((i) => ['sma', 'ema', 'wma', 'bbands'].includes(i.type));
  assert.ok(priceInds.length >= 2);
  const segs = r.levels.filter((l) => l.kind === 'SEG');
  assert.equal(segs.length, priceInds.length * 100, 'one segment per bar per line');
  // Segment times are the candles' own (broker) times in seconds: the MT5 chart axis.
  const last = segs.find((l) => l.id.endsWith('_0'))!;
  assert.equal(last.time2, Math.floor(c[c.length - 1].time / 1000));
  assert.equal(r.series.length, priceInds.length);
  assert.equal(r.closes.length, 100);
  // Colours follow indicator order in the fixed categorical palette.
  assert.equal(r.series[0].color, OVERLAY_COLORS[s.indicators.findIndex((i) => i.id === priceInds[0].id)]);
});

test('the rule checklist matches what the engine actually evaluates', () => {
  const s = emaPullbackScalp('XAUUSD');
  const c = candles(400);
  const r = buildOverlays(s, c, []);
  const ctx = { candles: c, indicators: computeIndicators(c, s.indicators), spreadPoints: 0 };
  const long = r.rules.find((x) => x.side === 'Long entry')!;
  assert.equal(long.passed, evaluateGroup(s.entryLong, c.length - 1, ctx));
  assert.equal(long.conditions.length, s.entryLong.conditions.length);
  assert.ok(long.conditions.every((x) => typeof x.text === 'string' && x.text.length > 3));
  assert.ok(['LONG', 'SHORT', 'none'].includes(r.signal));
});

test('info panel: header + oscillator values + rules, ASCII only, one LABEL per row', () => {
  const s = emaPullbackScalp('XAUUSD');
  const r = buildOverlays(s, candles(400), []);
  const labels = r.levels.filter((l) => l.kind === 'LABEL');
  assert.match(labels[0].label ?? '', /^XAT {2}.*signal: (LONG|SHORT|none)$/);
  const rsi = s.indicators.find((i) => i.type === 'rsi');
  if (rsi) assert.ok(labels.some((l) => (l.label ?? '').startsWith(indicatorLabel(rsi))));
  assert.ok(labels.every((l) => /^[\x20-\x7E]*$/.test(l.label ?? '')));
  // Serialised rows never contain a stray comma inside the label field.
  const csv = serialise(r.levels);
  for (const line of csv.split('\n').filter((x) => x && !x.startsWith('#') && !x.startsWith('symbol,'))) assert.equal(line.split(',').length, 11);
});

test('open trades get entry / stop / target lines; options switch parts off', () => {
  const s = emaPullbackScalp('XAUUSD');
  const pos = [{ id: '42', symbol: 'XAUUSD', side: 'short' as const, volume: 0.01, openPrice: 2401, currentPrice: 2400, stopLoss: 2405, takeProfit: 2395, profit: 1, swap: 0, commission: 0, openTime: 0 }];
  const r = buildOverlays(s, candles(400), pos);
  const ids = r.levels.filter((l) => l.kind === 'HLINE').map((l) => l.id);
  assert.ok(ids.some((x) => x.endsWith('_42_in')) && ids.some((x) => x.endsWith('_42_sl')) && ids.some((x) => x.endsWith('_42_tp')));
  const bare = buildOverlays(s, candles(400), pos, { indicators: false, rules: false, trades: false });
  assert.equal(bare.levels.length, 0);
  const withRange = buildOverlays(s, candles(400), [], { indicators: false, rules: false, range: true });
  assert.equal(withRange.levels.filter((l) => l.kind === 'HLINE').length, 2);
});
