/**
 * Vectorised technical indicators.
 *
 * Every function returns arrays the same length as the input candles, with
 * `null` in the warm-up region. That alignment is what lets the rule evaluator
 * index indicators and price by the same bar number without off-by-one bugs.
 */

import type { Candle, IndicatorOutput, IndicatorSpec, PriceSource } from './types.js';

export function sourceSeries(candles: Candle[], source: PriceSource = 'close'): number[] {
  switch (source) {
    case 'open':
      return candles.map((c) => c.open);
    case 'high':
      return candles.map((c) => c.high);
    case 'low':
      return candles.map((c) => c.low);
    case 'hl2':
      return candles.map((c) => (c.high + c.low) / 2);
    case 'hlc3':
      return candles.map((c) => (c.high + c.low + c.close) / 3);
    case 'ohlc4':
      return candles.map((c) => (c.open + c.high + c.low + c.close) / 4);
    case 'close':
    default:
      return candles.map((c) => c.close);
  }
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with an SMA so the series is deterministic regardless of history length.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function wma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - period + 1 + j] * (j + 1);
    out[i] = acc / denom;
  }
  return out;
}

/** Wilder's smoothing (RMA) — used by RSI, ATR and ADX. */
export function rma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const gains: number[] = new Array(n).fill(0);
  const losses: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  // Wilder seed on the first `period` deltas (indices 1..period).
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function trueRange(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
    } else {
      const pc = candles[i - 1].close;
      out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    }
  }
  return out;
}

export function atr(candles: Candle[], period: number): (number | null)[] {
  const tr = trueRange(candles);
  // Wilder ATR ignores the first TR (no previous close), so shift the window.
  const shifted = tr.slice(1);
  const smoothed = rma(shifted, period);
  const out: (number | null)[] = [null];
  for (const v of smoothed) out.push(v);
  return out.slice(0, candles.length);
}

export function macd(
  values: number[],
  fast: number,
  slow: number,
  signal: number,
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line: (number | null)[] = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null,
  );
  // Signal line is an EMA of the defined portion of the MACD line.
  const firstDefined = line.findIndex((v) => v != null);
  const sigOut: (number | null)[] = new Array(values.length).fill(null);
  const histOut: (number | null)[] = new Array(values.length).fill(null);
  if (firstDefined >= 0) {
    const dense = line.slice(firstDefined).map((v) => v as number);
    const sig = ema(dense, signal);
    for (let i = 0; i < sig.length; i++) {
      const idx = firstDefined + i;
      sigOut[idx] = sig[i];
      if (sig[i] != null && line[idx] != null) histOut[idx] = (line[idx] as number) - (sig[i] as number);
    }
  }
  return { macd: line, signal: sigOut, hist: histOut };
}

export function stdev(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const means = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    const m = means[i];
    if (m == null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - m) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

export function bbands(
  values: number[],
  period: number,
  mult: number,
): { middle: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const middle = sma(values, period);
  const sd = stdev(values, period);
  const upper = values.map((_, i) =>
    middle[i] != null && sd[i] != null ? (middle[i] as number) + mult * (sd[i] as number) : null,
  );
  const lower = values.map((_, i) =>
    middle[i] != null && sd[i] != null ? (middle[i] as number) - mult * (sd[i] as number) : null,
  );
  return { middle, upper, lower };
}

export function stochastic(
  candles: Candle[],
  kPeriod: number,
  dPeriod: number,
  slowing: number,
): { k: (number | null)[]; d: (number | null)[] } {
  const n = candles.length;
  const raw: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    raw[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const firstDefined = raw.findIndex((v) => v != null);
  const kOut: (number | null)[] = new Array(n).fill(null);
  const dOut: (number | null)[] = new Array(n).fill(null);
  if (firstDefined < 0) return { k: kOut, d: dOut };
  const dense = raw.slice(firstDefined).map((v) => v as number);
  const kSlow = slowing > 1 ? sma(dense, slowing) : dense.map((v) => v as number | null);
  const kDense: number[] = [];
  const kIdx: number[] = [];
  for (let i = 0; i < kSlow.length; i++) {
    const idx = firstDefined + i;
    kOut[idx] = kSlow[i];
    if (kSlow[i] != null) {
      kDense.push(kSlow[i] as number);
      kIdx.push(idx);
    }
  }
  const dDense = sma(kDense, dPeriod);
  for (let i = 0; i < dDense.length; i++) dOut[kIdx[i]] = dDense[i];
  return { k: kOut, d: dOut };
}

export function adx(
  candles: Candle[],
  period: number,
): { adx: (number | null)[]; plusDI: (number | null)[]; minusDI: (number | null)[] } {
  const n = candles.length;
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(candles);
  const trS = rma(tr.slice(1), period);
  const pS = rma(plusDM.slice(1), period);
  const mS = rma(minusDM.slice(1), period);

  const plusDI: (number | null)[] = new Array(n).fill(null);
  const minusDI: (number | null)[] = new Array(n).fill(null);
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < trS.length; i++) {
    const idx = i + 1;
    if (idx >= n) break;
    const t = trS[i];
    if (t == null || t === 0 || pS[i] == null || mS[i] == null) continue;
    const p = ((pS[i] as number) / t) * 100;
    const m = ((mS[i] as number) / t) * 100;
    plusDI[idx] = p;
    minusDI[idx] = m;
    dx[idx] = p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
  }
  const firstDx = dx.findIndex((v) => v != null);
  const adxOut: (number | null)[] = new Array(n).fill(null);
  if (firstDx >= 0) {
    const dense = dx.slice(firstDx).map((v) => (v == null ? 0 : v));
    const sm = rma(dense, period);
    for (let i = 0; i < sm.length; i++) adxOut[firstDx + i] = sm[i];
  }
  return { adx: adxOut, plusDI, minusDI };
}

export function cci(candles: Candle[], period: number): (number | null)[] {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const ma = sma(tp, period);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const m = ma[i];
    if (m == null) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m);
    dev /= period;
    out[i] = dev === 0 ? 0 : (tp[i] - m) / (0.015 * dev);
  }
  return out;
}

/**
 * Compute every indicator a strategy declares.
 * Returns a map: indicatorId -> { lineName -> series }.
 */
export function computeIndicators(
  candles: Candle[],
  specs: IndicatorSpec[],
): Record<string, IndicatorOutput> {
  const result: Record<string, IndicatorOutput> = {};
  for (const spec of specs) {
    const src = sourceSeries(candles, spec.source ?? 'close');
    const p = spec.params ?? {};
    switch (spec.type) {
      case 'sma':
        result[spec.id] = { value: sma(src, p.period ?? 14) };
        break;
      case 'ema':
        result[spec.id] = { value: ema(src, p.period ?? 14) };
        break;
      case 'wma':
        result[spec.id] = { value: wma(src, p.period ?? 14) };
        break;
      case 'rsi':
        result[spec.id] = { value: rsi(src, p.period ?? 14) };
        break;
      case 'atr':
        result[spec.id] = { value: atr(candles, p.period ?? 14) };
        break;
      case 'cci':
        result[spec.id] = { value: cci(candles, p.period ?? 20) };
        break;
      case 'macd': {
        const m = macd(src, p.fast ?? 12, p.slow ?? 26, p.signal ?? 9);
        result[spec.id] = { value: m.macd, signal: m.signal, hist: m.hist };
        break;
      }
      case 'bbands': {
        const b = bbands(src, p.period ?? 20, p.mult ?? 2);
        result[spec.id] = { value: b.middle, middle: b.middle, upper: b.upper, lower: b.lower };
        break;
      }
      case 'stoch': {
        const s = stochastic(candles, p.kPeriod ?? 14, p.dPeriod ?? 3, p.slowing ?? 3);
        result[spec.id] = { value: s.k, k: s.k, d: s.d };
        break;
      }
      case 'adx': {
        const a = adx(candles, p.period ?? 14);
        result[spec.id] = { value: a.adx, adx: a.adx, plusDI: a.plusDI, minusDI: a.minusDI };
        break;
      }
      default:
        throw new Error(`Unknown indicator type: ${(spec as IndicatorSpec).type}`);
    }
  }
  return result;
}

/** Bars of history each indicator needs before it emits a value. */
export function warmupBars(specs: IndicatorSpec[]): number {
  let max = 5;
  for (const s of specs) {
    const p = s.params ?? {};
    let need = 0;
    switch (s.type) {
      case 'macd':
        need = (p.slow ?? 26) + (p.signal ?? 9);
        break;
      case 'stoch':
        need = (p.kPeriod ?? 14) + (p.dPeriod ?? 3) + (p.slowing ?? 3);
        break;
      case 'adx':
        need = (p.period ?? 14) * 2 + 2;
        break;
      default:
        need = (p.period ?? 14) + 2;
    }
    if (need > max) max = need;
  }
  return max;
}

/** Descriptive metadata the mobile rule builder uses to render its dropdowns. */
export const INDICATOR_CATALOG = [
  { type: 'sma', label: 'Simple Moving Average', lines: ['value'], params: [{ key: 'period', label: 'Period', default: 20, min: 1, max: 500 }], usesSource: true },
  { type: 'ema', label: 'Exponential Moving Average', lines: ['value'], params: [{ key: 'period', label: 'Period', default: 21, min: 1, max: 500 }], usesSource: true },
  { type: 'wma', label: 'Weighted Moving Average', lines: ['value'], params: [{ key: 'period', label: 'Period', default: 20, min: 1, max: 500 }], usesSource: true },
  { type: 'rsi', label: 'RSI', lines: ['value'], params: [{ key: 'period', label: 'Period', default: 14, min: 2, max: 100 }], usesSource: true },
  { type: 'atr', label: 'ATR', lines: ['value'], params: [{ key: 'period', label: 'Period', default: 14, min: 1, max: 100 }], usesSource: false },
  { type: 'cci', label: 'CCI', lines: ['value'], params: [{ key: 'period', label: 'Period', default: 20, min: 2, max: 100 }], usesSource: false },
  { type: 'macd', label: 'MACD', lines: ['value', 'signal', 'hist'], params: [
      { key: 'fast', label: 'Fast', default: 12, min: 1, max: 100 },
      { key: 'slow', label: 'Slow', default: 26, min: 2, max: 200 },
      { key: 'signal', label: 'Signal', default: 9, min: 1, max: 100 },
    ], usesSource: true },
  { type: 'bbands', label: 'Bollinger Bands', lines: ['upper', 'middle', 'lower'], params: [
      { key: 'period', label: 'Period', default: 20, min: 2, max: 200 },
      { key: 'mult', label: 'Deviations', default: 2, min: 0.1, max: 5 },
    ], usesSource: true },
  { type: 'stoch', label: 'Stochastic', lines: ['k', 'd'], params: [
      { key: 'kPeriod', label: '%K Period', default: 14, min: 1, max: 100 },
      { key: 'dPeriod', label: '%D Period', default: 3, min: 1, max: 50 },
      { key: 'slowing', label: 'Slowing', default: 3, min: 1, max: 50 },
    ], usesSource: false },
  { type: 'adx', label: 'ADX / DMI', lines: ['adx', 'plusDI', 'minusDI'], params: [{ key: 'period', label: 'Period', default: 14, min: 2, max: 100 }], usesSource: false },
] as const;
