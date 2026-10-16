import { test } from 'node:test';
import assert from 'node:assert/strict';

import { betaCdf, betaQuantile, betaSummary, bootstrapDifference, bootstrapInterval, bootstrapMeans, mean, quantile, seededRng } from './stats.js';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

// L-16
test('L-16 the statistics match values worked out by hand', () => {
  // No trades: Beta(1,1) is flat. Mean 0.5, the middle 90% runs from 0.05 to 0.95.
  const none = betaSummary(0, 0);
  close(none.mean, 0.5);
  close(none.lo, 0.05);
  close(none.hi, 0.95);

  // 1 win, 0 losses: Beta(2,1) has cdf x^2, so the quantiles are sqrt(p). Mean 2/3.
  const one = betaSummary(1, 0);
  close(one.mean, 2 / 3);
  close(one.lo, Math.sqrt(0.05)); // 0.223607
  close(one.hi, Math.sqrt(0.95)); // 0.974679

  // 0 wins, 1 loss: Beta(1,2) has cdf 1-(1-x)^2, so the quantile is 1-sqrt(1-p). Mean 1/3.
  const lost = betaSummary(0, 1);
  close(lost.mean, 1 / 3);
  close(lost.lo, 1 - Math.sqrt(0.95)); // 0.025321
  close(lost.hi, 1 - Math.sqrt(0.05)); // 0.776393

  // 17 wins, 13 losses = 30 trades: mean 18/32 = 0.5625; and the cdf at the mean is a proper probability.
  const thirty = betaSummary(17, 13);
  close(thirty.mean, 0.5625);
  close(betaCdf(thirty.lo, 18, 14), 0.05);
  close(betaCdf(thirty.hi, 18, 14), 0.95);
  assert.ok(thirty.lo < 0.5625 && 0.5625 < thirty.hi);
  close(betaQuantile(0.5, 2, 2), 0.5); // Beta(2,2) is symmetric
  close(betaCdf(0.5, 3, 3), 0.5);

  // Bootstrap by hand. Values [2, 4], four resamples of two draws each. The random source below gives
  // 0, 0 | 0.99, 0.99 | 0, 0.99 | 0.99, 0  -> picks (2,2) (4,4) (2,4) (4,2) -> means 2, 4, 3, 3.
  const seq = [0, 0, 0.99, 0.99, 0, 0.99, 0.99, 0];
  let i = 0;
  const scripted = () => seq[i++ % seq.length];
  assert.deepEqual(bootstrapMeans([2, 4], 4, scripted), [2, 3, 3, 4]);
  // Straight-line quantiles of [2,3,3,4]: q=0.25 is at position 0.75 -> 2.75; q=0.75 is at position 2.25 -> 3.25.
  close(quantile([2, 3, 3, 4], 0.25), 2.75);
  close(quantile([2, 3, 3, 4], 0.75), 3.25);
  i = 0;
  const iv = bootstrapInterval([2, 4], scripted, 4, 0.5);
  close(iv.lo, 2.75);
  close(iv.hi, 3.25);
  close(mean([2, 4]), 3);

  // Difference: after [10,10] vs before [0,0] is exactly 10 whatever is drawn.
  const d = bootstrapDifference([10, 10], [0, 0], seededRng(1), 50);
  assert.deepEqual([d.lo, d.hi], [10, 10]);

  // Same seed, same answer; different seed may differ.
  const a = bootstrapInterval([1, -2, 3, 5, -1, 4], seededRng(42), 500);
  const b = bootstrapInterval([1, -2, 3, 5, -1, 4], seededRng(42), 500);
  assert.deepEqual(a, b);
  const r = seededRng(7);
  const draws = Array.from({ length: 1000 }, r);
  assert.ok(draws.every((x) => x >= 0 && x < 1));
});
