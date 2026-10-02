/**
 * Paper-trading broker.
 *
 * Runs the entire app — strategy builder, backtester, live runner, positions,
 * P&L — with no MetaApi account attached. It keeps one deterministic M1 series
 * per symbol and aggregates it up to whatever timeframe is asked for, extending
 * the series as wall-clock time advances so the bot really does tick forward.
 */

import { generateCandles } from '../engine/synthetic.js';
import { TIMEFRAME_MS, type Candle, type SymbolSpec, type Timeframe } from '../engine/types.js';
import type {
  AccountInfo,
  Broker,
  BrokerPosition,
  MarketStatus,
  OpenOrderRequest,
  Quote,
} from './types.js';

const MINUTE = 60_000;

const SYMBOL_SPECS: Record<string, Omit<SymbolSpec, 'symbol'> & { startPrice: number; volatility: number }> = {
  EURUSD: { point: 0.00001, digits: 5, contractSize: 100_000, spreadPoints: 12, commissionPerLot: 7, slippagePoints: 3, pointValuePerLot: 1, startPrice: 1.085, volatility: 0.00035 },
  GBPUSD: { point: 0.00001, digits: 5, contractSize: 100_000, spreadPoints: 16, commissionPerLot: 7, slippagePoints: 3, pointValuePerLot: 1, startPrice: 1.268, volatility: 0.00042 },
  USDJPY: { point: 0.001, digits: 3, contractSize: 100_000, spreadPoints: 14, commissionPerLot: 7, slippagePoints: 3, pointValuePerLot: 0.67, startPrice: 152.4, volatility: 0.00038 },
  XAUUSD: { point: 0.01, digits: 2, contractSize: 100, spreadPoints: 30, commissionPerLot: 0, slippagePoints: 8, pointValuePerLot: 1, startPrice: 2340, volatility: 0.0009 },
  BTCUSD: { point: 0.01, digits: 2, contractSize: 1, spreadPoints: 4000, commissionPerLot: 0, slippagePoints: 200, pointValuePerLot: 0.01, startPrice: 64000, volatility: 0.0025 },
};

interface PaperPosition extends BrokerPosition {
  spec: SymbolSpec;
}

export class PaperBroker implements Broker {
  readonly kind = 'paper' as const;

  private connected = false;
  private series = new Map<string, Candle[]>();
  private positions = new Map<string, PaperPosition>();
  private nextId = 1;
  private balance: number;
  private startBalance: number;
  private closedProfit = 0;

  constructor(initialBalance = 10_000) {
    this.balance = initialBalance;
    this.startBalance = initialBalance;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getSymbols(): Promise<string[]> {
    return Object.keys(SYMBOL_SPECS);
  }

  private cfg(symbol: string) {
    return SYMBOL_SPECS[symbol] ?? SYMBOL_SPECS.EURUSD;
  }

  /** Paper mode simulates every symbol, around the clock. */
  async getMarketStatus(symbol: string): Promise<MarketStatus> {
    const q = await this.getQuote(symbol);
    return {
      symbol, available: true, tradeMode: 'full', open: true, lastTickAt: Date.now(), bid: q.bid, ask: q.ask,
      spreadPoints: q.spreadPoints, description: 'Simulated (paper mode)', reason: null, checkedAt: Date.now(),
    };
  }

  async getSymbolSpec(symbol: string): Promise<SymbolSpec> {
    const c = this.cfg(symbol);
    return {
      symbol,
      point: c.point,
      digits: c.digits,
      contractSize: c.contractSize,
      spreadPoints: c.spreadPoints,
      commissionPerLot: c.commissionPerLot,
      slippagePoints: c.slippagePoints,
      pointValuePerLot: c.pointValuePerLot,
    };
  }

  /** The M1 base series for a symbol, extended up to the current minute. */
  private baseSeries(symbol: string): Candle[] {
    const cfg = this.cfg(symbol);
    const nowMinute = Math.floor(Date.now() / MINUTE) * MINUTE;
    let s = this.series.get(symbol);

    if (!s) {
      // ~14 days of M1 history is enough to warm up a 200-period indicator on H1.
      s = generateCandles({
        count: 20_000,
        timeframe: '1m',
        startPrice: cfg.startPrice,
        volatility: cfg.volatility,
        seed: hashSeed(symbol),
        endTime: nowMinute,
        spreadPoints: cfg.spreadPoints,
        digits: cfg.digits,
      });
      this.series.set(symbol, s);
      return s;
    }

    const last = s[s.length - 1];
    const missing = Math.floor((nowMinute - last.time) / MINUTE);
    if (missing > 0) {
      const extra = generateCandles({
        count: missing,
        timeframe: '1m',
        startPrice: last.close,
        volatility: cfg.volatility,
        // Seed off the timestamp so extensions are stable across calls.
        seed: hashSeed(symbol) + Math.floor(last.time / MINUTE),
        endTime: nowMinute,
        spreadPoints: cfg.spreadPoints,
        digits: cfg.digits,
      });
      s.push(...extra);
      if (s.length > 40_000) s.splice(0, s.length - 40_000);
    }
    return s;
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const base = this.baseSeries(symbol);
    const step = TIMEFRAME_MS[timeframe];
    if (step === MINUTE) return base.slice(-limit);

    // Aggregate M1 into the requested timeframe, bucketed on the epoch.
    const buckets = new Map<number, Candle>();
    const needed = limit * (step / MINUTE) + step / MINUTE;
    const slice = base.slice(-Math.min(base.length, Math.ceil(needed)));
    for (const c of slice) {
      const key = Math.floor(c.time / step) * step;
      const b = buckets.get(key);
      if (!b) {
        buckets.set(key, { ...c, time: key });
      } else {
        b.high = Math.max(b.high, c.high);
        b.low = Math.min(b.low, c.low);
        b.close = c.close;
        b.volume += c.volume;
      }
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time).slice(-limit);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const base = this.baseSeries(symbol);
    const cfg = this.cfg(symbol);
    const last = base[base.length - 1];
    const bid = last.close;
    const ask = Number((bid + cfg.spreadPoints * cfg.point).toFixed(cfg.digits));
    return { symbol, bid, ask, spreadPoints: cfg.spreadPoints, time: last.time };
  }

  /** Recompute floating P&L and apply stop/target hits. */
  private async mark(): Promise<void> {
    for (const [id, p] of [...this.positions]) {
      const q = await this.getQuote(p.symbol);
      const price = p.side === 'long' ? q.bid : q.ask;
      p.currentPrice = price;
      const diff = p.side === 'long' ? price - p.openPrice : p.openPrice - price;
      p.profit = Number(((diff / p.spec.point) * p.spec.pointValuePerLot * p.volume).toFixed(2));

      const slHit = p.stopLoss != null && (p.side === 'long' ? price <= p.stopLoss : price >= p.stopLoss);
      const tpHit = p.takeProfit != null && (p.side === 'long' ? price >= p.takeProfit : price <= p.takeProfit);
      if (slHit || tpHit) {
        this.settle(id);
      }
    }
  }

  private settle(id: string): void {
    const p = this.positions.get(id);
    if (!p) return;
    this.balance += p.profit - p.commission;
    this.closedProfit += p.profit - p.commission;
    this.positions.delete(id);
  }

  async getAccountInfo(): Promise<AccountInfo> {
    await this.mark();
    const floating = [...this.positions.values()].reduce((a, p) => a + p.profit, 0);
    return {
      broker: 'XAutoTrade Paper',
      currency: 'USD',
      server: 'paper-sim',
      balance: Number(this.balance.toFixed(2)),
      equity: Number((this.balance + floating).toFixed(2)),
      margin: 0,
      freeMargin: Number((this.balance + floating).toFixed(2)),
      leverage: 100,
      type: 'demo',
      name: 'Paper Account',
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    await this.mark();
    return [...this.positions.values()].map(({ spec, ...rest }) => rest);
  }

  async openPosition(req: OpenOrderRequest): Promise<{ positionId: string }> {
    const spec = await this.getSymbolSpec(req.symbol);
    const q = await this.getQuote(req.symbol);
    const slip = spec.slippagePoints * spec.point;
    const openPrice = req.side === 'long' ? q.ask + slip : q.bid - slip;
    // Unique across server restarts (like MT5 tickets), so the trade journal never merges two trades.
    const id = `paper-${Date.now().toString(36)}-${this.nextId++}`;

    this.positions.set(id, {
      id,
      symbol: req.symbol,
      side: req.side,
      volume: req.volume,
      openPrice: Number(openPrice.toFixed(spec.digits)),
      currentPrice: Number(openPrice.toFixed(spec.digits)),
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
      profit: 0,
      swap: 0,
      commission: Number((spec.commissionPerLot * req.volume).toFixed(2)),
      openTime: Date.now(),
      comment: req.comment,
      spec,
    });
    return { positionId: id };
  }

  async modifyPosition(positionId: string, stopLoss: number | null, takeProfit: number | null): Promise<void> {
    const p = this.positions.get(positionId);
    if (!p) throw new Error(`Unknown position ${positionId}`);
    p.stopLoss = stopLoss;
    p.takeProfit = takeProfit;
  }

  async closePosition(positionId: string): Promise<void> {
    await this.mark();
    if (!this.positions.has(positionId)) throw new Error(`Unknown position ${positionId}`);
    this.settle(positionId);
  }

  reset(balance = 10_000): void {
    this.positions.clear();
    this.balance = balance;
    this.startBalance = balance;
    this.closedProfit = 0;
  }

  stats() {
    return { startBalance: this.startBalance, closedProfit: this.closedProfit };
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 1_000_000);
}
