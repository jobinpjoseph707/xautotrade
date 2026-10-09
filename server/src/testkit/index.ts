/**
 * Shared test helpers (not a test file). Everything a test needs to build a
 * strategy, a host, a fake model, a clock, candles and a scriptable broker
 * without a terminal, a network or the real time of day.
 */
import type {
  AccountInfo,
  Broker,
  BrokerPosition,
  OpenOrderRequest,
  Quote,
} from '../broker/types.js';
import { fastScalpTest } from '../engine/presets.js';
import { DEFAULT_SPEC, TIMEFRAME_MS, type Candle, type Strategy, type SymbolSpec, type Timeframe } from '../engine/types.js';
import type { ChatBackend } from '../chat/backend.js';
import type { ChangeRecord } from '../learning/types.js';

// --- strategies ------------------------------------------------------------

/** A strategy every current and planned rule accepts: stop 200 points, target 300 (1.5:1). */
export function validStrategy(symbol = 'XAUUSD', id = 'str_valid'): Strategy {
  const s = fastScalpTest(symbol);
  s.id = id;
  s.name = 'Valid strategy';
  s.isTest = false;
  s.risk = {
    ...s.risk,
    slMode: 'points',
    slPoints: 200,
    tpMode: 'points',
    tpPoints: 300,
    fixedLot: 0.05,
    maxDailyLossPercent: 3,
    maxSpreadPoints: 0,
    sessions: [],
  };
  return s;
}

/** A strategy whose long rule is always true and whose short rule is never true. */
export function alwaysLong(over: Partial<Strategy> = {}): Strategy {
  const s = validStrategy('EURUSD', 'str_always');
  s.timeframe = '1m';
  s.indicators = [];
  s.entryLong = { logic: 'AND', conditions: [{ left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'const', value: 0 } }] };
  s.entryShort = { logic: 'AND', conditions: [{ left: { kind: 'price', field: 'close' }, op: 'lt', right: { kind: 'const', value: 0 } }] };
  s.exitLong = undefined;
  s.exitShort = undefined;
  s.risk = {
    ...s.risk,
    lotMode: 'fixed',
    fixedLot: 0.1,
    slMode: 'points',
    slPoints: 200,
    tpMode: 'points',
    tpPoints: 300,
    maxSpreadPoints: 0,
    maxOpenPositions: 1,
    cooldownBars: 0,
    maxDailyTrades: 0,
    closeOnOppositeSignal: false,
  };
  return { ...s, ...over };
}

// --- chat host / backend ---------------------------------------------------

export function makeHost(initial: Strategy[] = []) {
  const db = new Map(initial.map((s) => [s.id, s]));
  const calls: string[] = [];
  const host = {
    list: () => [...db.values()],
    get: (id: string) => db.get(id) ?? null,
    save: (s: Strategy) => { db.set(s.id, s); calls.push(`save:${s.id}`); return s; },
    remove: (id: string) => { db.delete(id); calls.push(`remove:${id}`); },
    reload: (s: Strategy) => { calls.push(`reload:${s.id}`); },
    start: async (id: string) => { calls.push(`start:${id}`); },
    stop: (id: string) => { calls.push(`stop:${id}`); },
  };
  return { host, db, calls };
}

/** A fake model: always answers `reply`, or whatever `reply(prompt)` returns. Records every prompt. */
export function fakeBackend(reply: string | ((prompt: string) => string) = ''): ChatBackend & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'fake',
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return typeof reply === 'function' ? reply(prompt) : reply;
    },
  } as ChatBackend & { prompts: string[] };
}

export function record(over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    id: Math.random().toString(36).slice(2), createdAt: 1, source: 'chat', agent: 'optimizer', model: 'fake/default',
    actionType: 'update_strategy', strategyId: 'str_a', symbol: 'XAUUSD', timeframe: '1m', summary: 's',
    signatures: ['risk.slPoints:down'], before: null, after: null, warnings: [], status: 'approved', score: 'hurt',
    scoreReasons: [], ...over,
  } as ChangeRecord;
}

// --- clock -----------------------------------------------------------------

export function fakeClock(start = Date.UTC(2026, 9, 7, 10, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    set: (ms: number) => { t = ms; },
    advance: (ms: number) => { t += ms; return t; },
  };
}

// --- candles ---------------------------------------------------------------

interface BuildOpts { start?: number; timeframe?: Timeframe; spread?: number }

/** `count` candles whose close moves `step` per bar, oldest first. */
export function trend(count: number, from: number, step: number, o: BuildOpts = {}): Candle[] {
  const tf = TIMEFRAME_MS[o.timeframe ?? '1m'];
  const start = o.start ?? Date.UTC(2026, 9, 7, 0, 0, 0);
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const open = from + step * i;
    const close = open + step;
    out.push({
      time: start + i * tf,
      open,
      close,
      high: Math.max(open, close) + Math.abs(step) * 0.2,
      low: Math.min(open, close) - Math.abs(step) * 0.2,
      volume: 100,
      ...(o.spread != null ? { spread: o.spread } : {}),
    });
  }
  return out;
}

export const flat = (count: number, price: number, o: BuildOpts = {}): Candle[] => trend(count, price, 0, o);

export const withSpread = (candles: Candle[], spread: number): Candle[] => candles.map((c) => ({ ...c, spread }));

// --- scriptable broker -----------------------------------------------------

/** A broker a test can steer: candles, quote, equity and positions are plain fields. */
export class ScriptedBroker implements Broker {
  readonly kind = 'paper' as const;
  connected = false;
  candles: Candle[] = [];
  spec: SymbolSpec = { ...DEFAULT_SPEC };
  bid = 1.1;
  spreadPoints = 12;
  quoteTime = Date.now();
  account: AccountInfo = {
    broker: 'Scripted', currency: 'USD', server: 'scripted', balance: 10_000, equity: 10_000,
    margin: 0, freeMargin: 10_000, leverage: 100, type: 'demo', name: 'Scripted',
  };
  positions: BrokerPosition[] = [];
  /** Every state-changing call, in order, e.g. "open:long:0.1", "close:p1", "modify:p1". */
  calls: string[] = [];
  private nextId = 1;

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  async getAccountInfo() { return { ...this.account }; }
  async getSymbols() { return [this.spec.symbol]; }
  async getSymbolSpec(symbol: string) { return { ...this.spec, symbol }; }
  async getQuote(symbol: string): Promise<Quote> {
    const ask = Number((this.bid + this.spreadPoints * this.spec.point).toFixed(this.spec.digits));
    return { symbol, bid: this.bid, ask, spreadPoints: this.spreadPoints, time: this.quoteTime };
  }
  async getCandles(_symbol: string, _tf: Timeframe, limit: number) { return this.candles.slice(-limit); }
  async getPositions() { return this.positions.map((p) => ({ ...p })); }
  async openPosition(req: OpenOrderRequest) {
    const id = `p${this.nextId++}`;
    const q = await this.getQuote(req.symbol);
    const price = req.side === 'long' ? q.ask : q.bid;
    this.calls.push(`open:${req.side}:${req.volume}`);
    this.positions.push({
      id, symbol: req.symbol, side: req.side, volume: req.volume, openPrice: price, currentPrice: price,
      stopLoss: req.stopLoss ?? null, takeProfit: req.takeProfit ?? null, profit: 0, swap: 0, commission: 0,
      openTime: Date.now(), comment: req.comment,
    });
    return { positionId: id };
  }
  async modifyPosition(id: string, sl: number | null, tp: number | null) {
    this.calls.push(`modify:${id}`);
    const p = this.positions.find((x) => x.id === id);
    if (p) { p.stopLoss = sl; p.takeProfit = tp; }
  }
  async closePosition(id: string) {
    this.calls.push(`close:${id}`);
    this.positions = this.positions.filter((p) => p.id !== id);
  }

  /** Put a position on the book directly (e.g. one opened by hand in MT5). */
  addPosition(over: Partial<BrokerPosition> = {}): BrokerPosition {
    const p: BrokerPosition = {
      id: `p${this.nextId++}`, symbol: this.spec.symbol, side: 'long', volume: 0.1, openPrice: 1.1, currentPrice: 1.1,
      stopLoss: null, takeProfit: null, profit: 0, swap: 0, commission: 0, openTime: Date.now(), ...over,
    };
    this.positions.push(p);
    return p;
  }
}

/** Waits for async work started with `void` (the runner's first tick). */
export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until(): condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
