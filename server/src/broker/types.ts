/**
 * Broker abstraction.
 *
 * The live runner talks only to this interface, so the MetaApi adapter and the
 * paper-trading adapter are interchangeable. That is what lets you develop and
 * demo the whole app with no broker account attached.
 */

import type { Candle, SymbolSpec, Timeframe } from '../engine/types.js';

export interface AccountInfo {
  broker: string;
  currency: string;
  server: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  /** 'demo' | 'real' — the live runner refuses real accounts unless allowed. */
  type: string;
  name: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  spreadPoints: number;
  time: number;
}

export interface BrokerPosition {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  profit: number;
  swap: number;
  commission: number;
  openTime: number;
  comment?: string;
}

/**
 * Can this symbol be traded on this account right now?
 *  - available: the broker lists the symbol at all (e.g. MetaQuotes-Demo has no BTCUSD)
 *  - tradeMode: what the broker allows (MT5 SYMBOL_TRADE_MODE)
 *  - open: prices are updating now (null = can't tell yet)
 */
export interface MarketStatus {
  symbol: string;
  available: boolean;
  tradeMode: 'full' | 'long_only' | 'short_only' | 'close_only' | 'disabled' | null;
  open: boolean | null;
  /** Last price update, real UTC ms (broker server-time offset removed). */
  lastTickAt: number | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  description: string | null;
  /** Plain-English explanation when the symbol can't be traded right now. */
  reason: string | null;
  checkedAt: number;
}

/** What the broker's deal history says happened to one position. Times are broker times (ms). */
export interface PositionHistory {
  positionId: string;
  symbol: string;
  side: 'long' | 'short';
  volume: number;
  entryTime: number;
  entryPrice: number;
  closed: boolean;
  closeTime: number | null;
  closePrice: number | null;
  /** Net realised result: profit + commission + swap + fee over every deal of the position. */
  profit: number;
  reason: 'tp' | 'sl' | 'stop_out' | 'bot' | 'manual' | 'other' | null;
}

export interface OpenOrderRequest {
  symbol: string;
  side: 'long' | 'short';
  volume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  comment?: string;
  clientId?: string;
}

export interface Broker {
  readonly kind: 'metaapi' | 'paper' | 'mt5mcp';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getAccountInfo(): Promise<AccountInfo>;
  getSymbols(): Promise<string[]>;
  getSymbolSpec(symbol: string): Promise<SymbolSpec>;
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, timeframe: Timeframe, limit: number, endTime?: Date): Promise<Candle[]>;
  getPositions(): Promise<BrokerPosition[]>;
  openPosition(req: OpenOrderRequest): Promise<{ positionId: string }>;
  modifyPosition(positionId: string, stopLoss: number | null, takeProfit: number | null): Promise<void>;
  closePosition(positionId: string): Promise<void>;
  /** Deal history for one position (optional: only brokers that expose it). */
  getPositionHistory?(positionId: string): Promise<PositionHistory | null>;
  /** Is the symbol offered / tradable / open right now (optional). */
  getMarketStatus?(symbol: string): Promise<MarketStatus>;
}
