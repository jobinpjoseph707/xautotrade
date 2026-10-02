/**
 * Deterministic synthetic candle generator.
 *
 * Used by the unit tests and by the server's demo mode, so the app is fully
 * explorable before a MetaApi token is plugged in. The series alternates
 * trending and ranging regimes so that both trend-following and mean-reversion
 * strategies get something realistic to chew on.
 */

import type { Candle, Timeframe } from './types.js';
import { TIMEFRAME_MS } from './types.js';

/** Small, fast, seedable PRNG (mulberry32) — reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  count: number;
  timeframe?: Timeframe;
  startPrice?: number;
  /** Per-bar volatility as a fraction of price. */
  volatility?: number;
  seed?: number;
  endTime?: number;
  spreadPoints?: number;
  digits?: number;
}

export function generateCandles(opts: SyntheticOptions): Candle[] {
  const {
    count,
    timeframe = '5m',
    startPrice = 1.085,
    volatility = 0.0006,
    seed = 42,
    spreadPoints = 12,
    digits = 5,
  } = opts;

  const step = TIMEFRAME_MS[timeframe];
  const endTime = opts.endTime ?? Date.now() - (Date.now() % step);
  const rnd = mulberry32(seed);
  const candles: Candle[] = [];

  let price = startPrice;
  let drift = 0;
  let regimeLeft = 0;
  const round = (v: number) => Number(v.toFixed(digits));

  for (let i = 0; i < count; i++) {
    if (regimeLeft <= 0) {
      // New regime: roughly half trending, half ranging.
      regimeLeft = 40 + Math.floor(rnd() * 160);
      const trending = rnd() < 0.5;
      drift = trending ? (rnd() - 0.5) * volatility * 0.8 : 0;
    }
    regimeLeft -= 1;

    const open = price;
    // Box-Muller for a normal shock, so tails behave like real returns.
    const u1 = Math.max(rnd(), 1e-9);
    const u2 = rnd();
    const shock = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const ret = drift + shock * volatility;
    const close = open * (1 + ret);

    const wick = Math.abs(shock) * volatility * open * 0.7 + open * volatility * 0.15;
    const high = Math.max(open, close) + wick * rnd();
    const low = Math.min(open, close) - wick * rnd();

    candles.push({
      time: endTime - (count - 1 - i) * step,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(200 + rnd() * 1800),
      spread: spreadPoints,
    });
    price = close;
  }
  return candles;
}
