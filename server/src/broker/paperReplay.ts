/**
 * Paper replay: the last few days of REAL candles played back, one bar at a time, through the real
 * BotRunner and a broker that behaves like MetaTrader (stop-distance rule, lot limits, a spread on
 * every bar). It checks the plumbing, not the edge: does the bot run without errors, never size a
 * lot above its cap, and never ask the broker for a stop move the broker would refuse?
 *
 * Nothing here is simulated price data. The candles are supplied by the caller (real MT5 history),
 * and the runner is given an in-memory log, settings and clock so a replay never touches the real
 * journal, the shared broker clock or the chart.
 */
import { warmupBars } from '../engine/indicators.js';
import { positionProfit } from '../engine/risk.js';
import { validateStrategy } from '../engine/rules.js';
import { TIMEFRAME_MS, type Candle, type Strategy, type SymbolSpec } from '../engine/types.js';
import { BotRunner, type RunnerEnv } from '../live/runner.js';
import type { LogEntry } from '../store.js';
import type { AccountInfo, Broker, BrokerPosition, OpenOrderRequest, PositionHistory, Quote } from './types.js';

const DAY = 86_400_000;

export interface ReplayTrade {
  side: 'long' | 'short';
  lots: number;
  openTime: number;
  closeTime: number;
  openPrice: number;
  closePrice: number;
  /** Net of commission. */
  profit: number;
  reason: 'sl' | 'tp' | 'bot';
}

export interface IllegalStopMove {
  /** Bar (broker time) the move was asked on. */
  time: number;
  side: 'long' | 'short';
  asked: number;
  /** How far the new stop is from the price it must stay clear of, in points. */
  distancePoints: number;
  minimumPoints: number;
}

/** A broker that plays back a fixed list of real candles. `advanceTo(i)` closes bar i. */
export class ReplayBroker implements Broker {
  readonly kind = 'paper' as const;
  readonly illegalStopMoves: IllegalStopMoves = [];
  readonly closedTrades: ReplayTrade[] = [];
  readonly openedLots: number[] = [];

  private connected = false;
  private idx: number;
  private balance: number;
  private positions: BrokerPosition[] = [];
  private nextId = 1;
  private history = new Map<string, PositionHistory>();

  constructor(
    private readonly candles: Candle[],
    private readonly spec: SymbolSpec,
    startClosed: number,
    initialBalance = 10_000,
  ) {
    this.idx = startClosed;
    this.balance = initialBalance;
  }

  get lastClosed(): number {
    return this.idx;
  }

  isConnected() { return this.connected; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async getSymbols() { return [this.spec.symbol]; }
  async getSymbolSpec(symbol: string): Promise<SymbolSpec> { return { ...this.spec, symbol }; }

  private spreadAt(i: number): number {
    const sp = this.candles[i]?.spread;
    return sp && sp > 0 ? sp : this.spec.spreadPoints;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const bar = this.candles[this.idx];
    const spread = this.spreadAt(this.idx);
    return { symbol, bid: bar.close, ask: Number((bar.close + spread * this.spec.point).toFixed(this.spec.digits)), spreadPoints: spread, time: bar.time };
  }

  /** Oldest first, ending with the bar that is "still forming" (the one after the last closed bar). */
  async getCandles(_symbol: string, _tf: string, limit: number): Promise<Candle[]> {
    const end = Math.min(this.idx + 2, this.candles.length);
    return this.candles.slice(Math.max(0, end - limit), end);
  }

  async getAccountInfo(): Promise<AccountInfo> {
    this.mark();
    const floating = this.positions.reduce((a, p) => a + p.profit, 0);
    return {
      broker: 'Replay', currency: 'USD', server: 'replay', balance: round2(this.balance), equity: round2(this.balance + floating),
      margin: 0, freeMargin: round2(this.balance + floating), leverage: 100, type: 'demo', name: 'Replay',
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    this.mark();
    return this.positions.map((p) => ({ ...p }));
  }

  /** The smallest distance (points) a stop may sit from the price: the current spread. */
  private minStopPoints(): number {
    return this.spreadAt(this.idx);
  }

  private checkStop(side: 'long' | 'short', sl: number | null): void {
    if (sl == null) return;
    const q = this.quoteNow();
    const ref = side === 'long' ? q.bid : q.ask;
    const distance = (side === 'long' ? ref - sl : sl - ref) / this.spec.point;
    const min = this.minStopPoints();
    if (distance < min) {
      this.illegalStopMoves.push({ time: this.candles[this.idx].time, side, asked: sl, distancePoints: Math.round(distance * 10) / 10, minimumPoints: min });
      throw new Error(`Invalid stops (10016): the stop ${sl} is ${distance.toFixed(1)} points from the price; the minimum is ${min}.`);
    }
  }

  private quoteNow() {
    const bar = this.candles[this.idx];
    const spread = this.spreadAt(this.idx);
    return { bid: bar.close, ask: bar.close + spread * this.spec.point };
  }

  async openPosition(req: OpenOrderRequest): Promise<{ positionId: string }> {
    const next = this.candles[this.idx + 1];
    if (!next) throw new Error('The replay has no next bar to fill on.');
    this.checkStop(req.side, req.stopLoss ?? null);
    const spread = this.spreadAt(this.idx + 1);
    const slip = this.spec.slippagePoints * this.spec.point;
    // Filled at the next bar's open, with the spread and slippage the backtester charges.
    const price = req.side === 'long' ? next.open + spread * this.spec.point + slip : next.open - slip;
    const id = `replay-${this.nextId++}`;
    this.openedLots.push(req.volume);
    const rounded = Number(price.toFixed(this.spec.digits));
    this.positions.push({
      id, symbol: req.symbol, side: req.side, volume: req.volume, openPrice: rounded, currentPrice: rounded,
      stopLoss: req.stopLoss ?? null, takeProfit: req.takeProfit ?? null, profit: 0, swap: 0,
      commission: round2(this.spec.commissionPerLot * req.volume), openTime: next.time, comment: req.comment,
    });
    return { positionId: id };
  }

  async modifyPosition(positionId: string, stopLoss: number | null, takeProfit: number | null): Promise<void> {
    const p = this.positions.find((x) => x.id === positionId);
    if (!p) throw new Error(`Unknown position ${positionId}`);
    if (stopLoss !== p.stopLoss) this.checkStop(p.side, stopLoss);
    p.stopLoss = stopLoss;
    p.takeProfit = takeProfit;
  }

  async closePosition(positionId: string): Promise<void> {
    const p = this.positions.find((x) => x.id === positionId);
    if (!p) throw new Error(`Unknown position ${positionId}`);
    const q = this.quoteNow();
    const slip = this.spec.slippagePoints * this.spec.point;
    this.settle(p, p.side === 'long' ? q.bid - slip : q.ask + slip, 'bot', this.candles[this.idx].time);
  }

  async getPositionHistory(positionId: string): Promise<PositionHistory | null> {
    return this.history.get(positionId) ?? null;
  }

  /**
   * Close bar `i`: positions are checked against that bar's range exactly as the backtester does
   * (stop first, then target, quoted on the side the position closes at).
   */
  advanceTo(i: number): void {
    this.idx = i;
    const bar = this.candles[i];
    const spread = this.spreadAt(i);
    const point = this.spec.point;
    const slip = this.spec.slippagePoints * point;
    for (const p of [...this.positions]) {
      const closeLow = p.side === 'long' ? bar.low : bar.low + spread * point;
      const closeHigh = p.side === 'long' ? bar.high : bar.high + spread * point;
      if (p.stopLoss != null && (p.side === 'long' ? closeLow <= p.stopLoss : closeHigh >= p.stopLoss)) {
        this.settle(p, p.side === 'long' ? p.stopLoss - slip : p.stopLoss + slip, 'sl', bar.time);
      } else if (p.takeProfit != null && (p.side === 'long' ? closeHigh >= p.takeProfit : closeLow <= p.takeProfit)) {
        this.settle(p, p.takeProfit, 'tp', bar.time);
      }
    }
  }

  private mark(): void {
    const q = this.quoteNow();
    for (const p of this.positions) {
      p.currentPrice = p.side === 'long' ? q.bid : q.ask;
      p.profit = round2(positionProfit(p.side, p.volume, p.openPrice, p.currentPrice, this.spec));
    }
  }

  private settle(p: BrokerPosition, price: number, reason: ReplayTrade['reason'], time: number): void {
    const gross = positionProfit(p.side, p.volume, p.openPrice, price, this.spec);
    const net = gross - p.commission;
    this.balance += net;
    this.positions = this.positions.filter((x) => x.id !== p.id);
    const exit = Number(price.toFixed(this.spec.digits));
    this.closedTrades.push({ side: p.side, lots: p.volume, openTime: p.openTime, closeTime: time, openPrice: p.openPrice, closePrice: exit, profit: round2(net), reason });
    this.history.set(p.id, {
      positionId: p.id, symbol: p.symbol, side: p.side, volume: p.volume, entryTime: p.openTime, entryPrice: p.openPrice,
      closed: true, closeTime: time, closePrice: exit, profit: round2(net), reason: reason === 'bot' ? 'bot' : reason,
    });
  }
}

type IllegalStopMoves = IllegalStopMove[];

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ReplayResult {
  passed: boolean;
  reasons: string[];
  trades: ReplayTrade[];
  /** Error-level log lines the bot wrote during the replay. */
  errors: string[];
  illegalStopMoves: IllegalStopMove[];
  /** Largest lot the bot asked for. */
  maxLotUsed: number;
  ticks: number;
  /** The candles the replay played (history the bot needs, then the replayed days). The backtest parity test uses the same ones. */
  candles: Candle[];
  /** Index in `candles` where the replayed days begin. */
  windowStart: number;
}

export interface ReplayOptions {
  days?: number;
  /** Test hook: put something between the runner and the replay broker (e.g. to make orders fail). */
  wrapBroker?: (inner: ReplayBroker) => Broker;
}

/** The replay's pass marks, as a pure function. */
export function judgeReplay(f: { illegalStopMoves: IllegalStopMove[]; maxLotUsed: number; maxLot: number; errors: string[] }): string[] {
  const reasons: string[] = [];
  if (f.illegalStopMoves.length) {
    const first = f.illegalStopMoves[0];
    const n = f.illegalStopMoves.length;
    reasons.push(
      `Stop move illegal: ${n} time${n === 1 ? '' : 's'} the bot asked for a stop ${first.distancePoints} points from the price, and the broker needs at least ${first.minimumPoints} (the spread). ` +
        'The break-even or trailing distance is inside the spread, so MetaTrader would reject it.',
    );
  }
  if (f.maxLotUsed > f.maxLot + 1e-9) reasons.push(`A lot of ${f.maxLotUsed} was sent; this strategy's cap is ${f.maxLot}.`);
  // A refused stop is already reported above; anything else the bot logged as an error is its own problem.
  const other = f.errors.filter((m) => !/^Invalid stops/.test(m));
  if (other.length) reasons.push(`The bot logged ${other.length} error${other.length === 1 ? '' : 's'}: ${other[0]}`);
  return reasons;
}

/** The runner's own history requirement, so the replay always starts with enough bars. */
function historyNeeded(strategy: Strategy): number {
  return Math.max(warmupBars(strategy.indicators) + 60, 260);
}

export async function runReplay(
  strategy: Strategy,
  data: { candles: Candle[]; spec: SymbolSpec; serverOffsetMs?: number },
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const days = options.days ?? 3;
  const step = TIMEFRAME_MS[strategy.timeframe];
  const offset = data.serverOffsetMs ?? 0;
  const empty = (reasons: string[]): ReplayResult => ({
    passed: false, reasons, trades: [], errors: [], illegalStopMoves: [], maxLotUsed: 0, ticks: 0, candles: [], windowStart: 0,
  });

  const problems = validateStrategy(strategy);
  if (problems.length) return empty(problems);

  const all = data.candles;
  const need = historyNeeded(strategy);
  if (all.length < need + 2) return empty([`Only ${all.length} real candles, too few to replay (need ${need + 2}).`]);
  const lastTime = all[all.length - 1].time;
  let windowStartAll = all.findIndex((c) => c.time >= lastTime - days * DAY);
  if (windowStartAll < need) windowStartAll = need;
  if (windowStartAll > all.length - 3) return empty(['The candles end too soon after the history the bot needs to replay anything.']);
  const candles = all.slice(windowStartAll - need);
  const windowStart = need;

  const log: LogEntry[] = [];
  const settingsMap = new Map<string, unknown>();
  const env: RunnerEnv = {
    logs: {
      add: (e) => { const entry = { ...e, id: log.length + 1 }; log.push(entry); return entry; },
      tradesBetween: (id, from, to) => log.filter((e) => e.strategyId === id && e.level === 'trade' && e.ts >= from && e.ts < to),
    },
    settings: {
      get: <T,>(k: string, fallback: T) => (settingsMap.has(k) ? (settingsMap.get(k) as T) : fallback),
      set: (k, v) => void settingsMap.set(k, v),
    },
    offset: () => offset,
    chart: false,
    timers: false,
  };

  const broker = new ReplayBroker(candles, data.spec, windowStart - 1);
  let clock = candles[windowStart].time - offset;
  const runner = new BotRunner({ ...strategy, showLevels: false, showOverlays: false }, options.wrapBroker ? options.wrapBroker(broker) : broker, false, () => clock, env);

  let ticks = 0;
  try {
    await runner.start();
    // Bar i has just closed; "now" is the open of the next bar, a few seconds in.
    for (let i = windowStart - 1; i <= candles.length - 2; i++) {
      broker.advanceTo(i);
      clock = candles[i + 1].time - offset + Math.min(4000, step / 2);
      await runner.tick();
      ticks++;
    }
    broker.advanceTo(candles.length - 1);
  } finally {
    runner.stop();
  }

  const errors = log.filter((e) => e.level === 'error').map((e) => e.message);
  const illegal = broker.illegalStopMoves;
  const maxLotUsed = broker.openedLots.length ? Math.max(...broker.openedLots) : 0;
  const reasons = judgeReplay({ illegalStopMoves: illegal, maxLotUsed, maxLot: strategy.risk.maxLot, errors });

  return { passed: reasons.length === 0, reasons, trades: broker.closedTrades, errors, illegalStopMoves: illegal, maxLotUsed, ticks, candles, windowStart };
}
