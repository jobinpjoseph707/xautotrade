/**
 * Broker-backed wrappers around the pure validation/scoring functions.
 * Reads candles only; never places or modifies orders.
 */
import type { Candle, Strategy, SymbolSpec, Timeframe } from '../engine/types.js';
import { DEFAULT_LAB, marketSnapshot, measureWindow, validateOnCandles, type LabOptions } from './validate.js';
import type { MarketSnapshot, Validation, WindowResult } from './types.js';

export interface MarketData {
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getSymbolSpec(symbol: string): Promise<SymbolSpec>;
}

export interface LabConfig extends LabOptions {
  /** Bars fetched for validation: in-sample (the agent's window) + the older unseen window. */
  validationBars: number;
  /** Bars fetched when measuring forward results. */
  forwardBars: number;
}

export const DEFAULT_LAB_CONFIG: LabConfig = {
  ...DEFAULT_LAB,
  validationBars: Number(process.env.LEARN_VALIDATION_BARS ?? 3000),
  forwardBars: Number(process.env.LEARN_FORWARD_BARS ?? 5000),
  minTrades: Number(process.env.LEARN_MIN_TRADES ?? DEFAULT_LAB.minTrades),
};

export class Lab {
  /** One candle fetch per symbol/timeframe per few minutes; the MT5 bridge is slow and serial. */
  private cache = new Map<string, { at: number; candles: Candle[] }>();

  constructor(
    private readonly data: MarketData,
    private readonly cfg: LabConfig = DEFAULT_LAB_CONFIG,
    private readonly beforeFetch: () => Promise<void> = async () => undefined,
  ) {}

  private async candles(symbol: string, tf: Timeframe, limit: number): Promise<Candle[]> {
    const key = `${symbol}|${tf}|${limit}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.candles;
    await this.beforeFetch();
    const candles = await this.data.getCandles(symbol, tf, limit);
    this.cache.set(key, { at: Date.now(), candles });
    return candles;
  }

  async validate(before: Strategy | null, after: Strategy, safetyChange: boolean): Promise<{ validation: Validation; market?: MarketSnapshot }> {
    const candles = await this.candles(after.symbol, after.timeframe, this.cfg.validationBars);
    const spec = await this.data.getSymbolSpec(after.symbol);
    const validation = validateOnCandles({ before, after, candles, spec, safetyChange, opts: this.cfg });
    const recent = candles.slice(-this.cfg.inSampleBars);
    return { validation, market: recent.length > 1 ? marketSnapshot(after, recent) : undefined };
  }

  /** Before/after on bars formed after `since`. Null when nothing has formed yet. */
  async forward(before: Strategy | null, after: Strategy | null, since: number): Promise<WindowResult | null> {
    const ref = after ?? before;
    if (!ref) return null;
    const candles = await this.candles(ref.symbol, ref.timeframe, this.cfg.forwardBars);
    const spec = await this.data.getSymbolSpec(ref.symbol);
    // A before config on another instrument can't be measured on these bars.
    const b = before && before.symbol === ref.symbol && before.timeframe === ref.timeframe ? before : null;
    return measureWindow(b, after, candles, spec, since, this.cfg);
  }

  get minTrades(): number {
    return this.cfg.minTrades;
  }
}
