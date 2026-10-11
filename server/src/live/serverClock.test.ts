import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerClock } from './serverClock.js';

const H = 3_600_000;
const U = (s: string) => Date.parse(s);

// CK-1
test('CK-1 a price that has stopped never teaches the clock', () => {
  const c = new ServerClock(1_000);
  const raw = U('2026-10-09T23:59:55.224Z'); // broker stamp, never changes once the market shuts
  c.observe('USDJPY', raw, raw - 3 * H); // first sight: provisional +3h
  assert.equal(c.offset, 3 * H);
  assert.equal(c.confirmed, false);

  // Same quote half an hour later: the estimator would happily call this +2.5h.
  const later = raw - 3 * H + 30 * 60_000;
  assert.equal(c.observe('USDJPY', raw, later), null, 'provisional value is dropped, not replaced');
  assert.equal(c.confirmed, false);
});

// CK-2
test('CK-2 a price that moves confirms the clock', () => {
  const c = new ServerClock(1_000);
  const now = U('2026-10-09T12:00:00Z');
  c.observe('EURUSD', now + 3 * H, now);
  c.observe('EURUSD', now + 3 * H + 2_000, now + 2_000); // a new tick: the market is alive
  assert.equal(c.offset, 3 * H);
  assert.equal(c.confirmed, true);
});

// CK-3
test('CK-3 the real 9 October decay sequence leaves a confirmed clock untouched', () => {
  const c = new ServerClock(1_000);
  // Real values from the MetaQuotes-Demo account: the server runs at UTC+3, gold stopped at
  // 19:59:59.95 UTC and forex at 20:59:55.22 UTC, both stamped in broker time.
  const rawGold = U('2026-10-09T22:59:59.950Z');
  const rawFx = U('2026-10-09T23:59:55.224Z');
  const goldClose = rawGold - 3 * H; // 19:59:59.95 UTC, when gold actually stopped
  const fxClose = rawFx - 3 * H; //    20:59:55.22 UTC, when forex actually stopped

  // While gold was still alive, moving prices confirm +3h.
  c.observe('XAUUSD', rawGold - 60_000, goldClose - 60_000);
  c.observe('XAUUSD', rawGold, goldClose);
  assert.equal(c.confirmed, true);
  assert.equal(c.offset, 3 * H);

  // Then both prices freeze. Re-measured every five minutes for the next two hours, the old
  // estimator re-learned 2h, 1.5h, 1h, 0.5h and finally 0 as the clock advanced.
  for (let m = 1; m <= 120; m += 1) {
    const now = fxClose + m * 60_000;
    c.observe('XAUUSD', rawGold, now);
    c.observe('USDJPY', rawFx, now);
    assert.equal(c.offset, 3 * H, `offset moved ${m} minutes after the close`);
  }
  assert.equal(c.confirmed, true);
});

// CK-4
test('CK-4 one symbol freezing does not spoil a clock another symbol confirmed', () => {
  const c = new ServerClock(1_000);
  const now = U('2026-10-09T12:00:00Z');
  c.observe('XAUUSD', now + 3 * H, now); // provisional, from gold
  c.observe('EURUSD', now + 3 * H + 1_000, now + 1_000);
  c.observe('EURUSD', now + 3 * H + 5_000, now + 5_000); // forex moves: confirmed
  assert.equal(c.confirmed, true);

  c.observe('XAUUSD', now + 3 * H, now + 60_000); // gold is shut and frozen
  assert.equal(c.offset, 3 * H, 'a confirmed clock survives a frozen symbol');
});

// CK-5
test('CK-5 a nonsense quote is ignored and the clock is per broker, not per symbol', () => {
  const c = new ServerClock(1_000);
  const now = U('2026-10-09T12:00:00Z');
  c.observe('EURUSD', now + 3 * H, now);
  c.observe('EURUSD', now + 3 * H + 1_000, now + 1_000);
  assert.equal(c.offset, 3 * H);

  assert.equal(c.observe('EURUSD', 0, now + 2_000), 3 * H, 'zero timestamp changes nothing');
  assert.equal(c.observe('EURUSD', Number.NaN, now + 3_000), 3 * H, 'NaN changes nothing');
  // A second symbol reads the same broker clock without having to learn it again.
  c.observe('USDJPY', now + 3 * H + 4_000, now + 4_000);
  assert.equal(c.offset, 3 * H);

  c.reset();
  assert.equal(c.offset, null);
  assert.equal(c.confirmed, false);
});
