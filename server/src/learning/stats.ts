/**
 * The few statistics scoring needs, written out so they can be checked by hand:
 *  - a Beta posterior for a win rate (uniform prior, so wins + 1 and losses + 1),
 *  - a bootstrap interval for an average, with a random source you pass in so a result can be repeated.
 */

/** A small seeded random source (mulberry32): the same seed gives the same numbers. */
export function seededRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Beta ------------------------------------------------------------------------------------------

function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

/** The Beta(a, b) cumulative distribution at x (regularised incomplete beta). */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betaContinuedFraction(a, b, x)) / a : 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** The x where the Beta(a, b) cumulative distribution reaches p, by bisection. */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface BetaSummary {
  /** (wins + 1) / (trades + 2). */
  mean: number;
  lo: number;
  hi: number;
}

/** What is known about a win rate after `wins` and `losses`, starting from "no idea" (uniform). `level` is the width of the interval. */
export function betaSummary(wins: number, losses: number, level = 0.9): BetaSummary {
  const a = wins + 1;
  const b = losses + 1;
  const tail = (1 - level) / 2;
  return { mean: a / (a + b), lo: betaQuantile(tail, a, b), hi: betaQuantile(1 - tail, a, b) };
}

// --- Bootstrap ---------------------------------------------------------------------------------------

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Straight-line interpolation between the two nearest sorted values. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const i = Math.floor(pos);
  const frac = pos - i;
  return i + 1 < sorted.length ? sorted[i] + frac * (sorted[i + 1] - sorted[i]) : sorted[i];
}

/** `iterations` resampled averages of `values` (drawing with replacement), sorted. */
export function bootstrapMeans(values: number[], iterations: number, rng: () => number): number[] {
  const out: number[] = [];
  const n = values.length;
  for (let k = 0; k < iterations; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.min(n - 1, Math.floor(rng() * n))];
    out.push(s / n);
  }
  return out.sort((x, y) => x - y);
}

export interface Interval {
  lo: number;
  hi: number;
}

export function bootstrapInterval(values: number[], rng: () => number, iterations = 2000, level = 0.9): Interval {
  const means = bootstrapMeans(values, iterations, rng);
  const tail = (1 - level) / 2;
  return { lo: quantile(means, tail), hi: quantile(means, 1 - tail) };
}

/** Interval for (average of `after`) minus (average of `before`), resampling each side on its own. */
export function bootstrapDifference(after: number[], before: number[], rng: () => number, iterations = 2000, level = 0.9): Interval {
  const diffs: number[] = [];
  const draw = (v: number[]): number => {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[Math.min(v.length - 1, Math.floor(rng() * v.length))];
    return s / v.length;
  };
  for (let k = 0; k < iterations; k++) {
    const a = draw(after);
    diffs.push(a - draw(before));
  }
  diffs.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return { lo: quantile(diffs, tail), hi: quantile(diffs, 1 - tail) };
}
