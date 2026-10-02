/**
 * Shared type definitions for the XAutoTrade strategy engine.
 * These same types drive the backtester and the live trader, so a strategy
 * that backtests one way behaves identically in live execution.
 */

export interface Candle {
  time: number; // epoch ms of bar OPEN
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread?: number; // in points, if the broker reported it
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export type IndicatorType =
  | 'sma'
  | 'ema'
  | 'wma'
  | 'rsi'
  | 'atr'
  | 'macd'
  | 'bbands'
  | 'stoch'
  | 'adx'
  | 'cci';

export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

export interface IndicatorSpec {
  /** Stable id referenced by conditions, e.g. "ema_fast". */
  id: string;
  type: IndicatorType;
  source?: PriceSource; // default 'close'; ignored by atr/adx/stoch/cci
  params: Record<string, number>;
}

/** An indicator produces one or more named output series. */
export type IndicatorOutput = Record<string, (number | null)[]>;

// ---------------------------------------------------------------------------
// Rule DSL
// ---------------------------------------------------------------------------

export type Operand =
  | { kind: 'indicator'; id: string; line?: string; shift?: number }
  | { kind: 'price'; field: PriceSource; shift?: number }
  | { kind: 'const'; value: number }
  | { kind: 'spread' }
  | { kind: 'hourUTC' };

export type ComparisonOp =
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'crossesAbove'
  | 'crossesBelow'
  | 'risingFor'
  | 'fallingFor';

export interface Condition {
  left: Operand;
  op: ComparisonOp;
  right: Operand;
}

export interface RuleGroup {
  logic: 'AND' | 'OR';
  conditions: Condition[];
}

// ---------------------------------------------------------------------------
// Risk / money management
// ---------------------------------------------------------------------------

export interface RiskConfig {
  /** How position size is decided. */
  lotMode: 'fixed' | 'percentRisk';
  fixedLot: number;
  /** Percent of balance risked per trade when lotMode = percentRisk. */
  riskPercent: number;
  minLot: number;
  maxLot: number;
  lotStep: number;

  slMode: 'points' | 'atr' | 'none';
  slPoints: number;
  slAtrMult: number;

  tpMode: 'points' | 'atr' | 'rr' | 'none';
  tpPoints: number;
  tpAtrMult: number;
  /** Reward:risk multiple when tpMode = 'rr'. */
  tpRR: number;

  /** Indicator id used for ATR-based stops. Must be an 'atr' indicator. */
  atrIndicatorId?: string;

  trailingEnabled: boolean;
  trailingStartPoints: number;
  trailingStepPoints: number;
  /** Move SL to entry once price advances this many points. 0 = off. */
  breakEvenPoints: number;

  /** Reject entries when the current spread exceeds this many points. */
  maxSpreadPoints: number;
  maxOpenPositions: number;
  /** Stop trading for the rest of the day after this much equity loss. */
  maxDailyLossPercent: number;
  maxDailyTrades: number;
  /** Minimum bars between two entries. Guards against overtrading. */
  cooldownBars: number;

  /** Trading windows in UTC. Empty = trade around the clock. */
  sessions: { startHour: number; endHour: number }[];
  /** Days of week allowed, 0 = Sunday. Empty = all days. */
  tradingDays: number[];

  closeOnOppositeSignal: boolean;
}

export const DEFAULT_RISK: RiskConfig = {
  lotMode: 'fixed',
  fixedLot: 0.01,
  riskPercent: 0.5,
  minLot: 0.01,
  maxLot: 5,
  lotStep: 0.01,
  slMode: 'points',
  slPoints: 100,
  slAtrMult: 1.5,
  tpMode: 'points',
  tpPoints: 150,
  tpAtrMult: 2,
  tpRR: 1.5,
  trailingEnabled: false,
  trailingStartPoints: 80,
  trailingStepPoints: 20,
  breakEvenPoints: 0,
  maxSpreadPoints: 25,
  maxOpenPositions: 1,
  maxDailyLossPercent: 3,
  maxDailyTrades: 20,
  cooldownBars: 1,
  sessions: [],
  tradingDays: [],
  closeOnOppositeSignal: true,
};

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export interface Strategy {
  id: string;
  name: string;
  symbol: string;
  timeframe: Timeframe;
  indicators: IndicatorSpec[];
  entryLong: RuleGroup;
  entryShort: RuleGroup;
  exitLong?: RuleGroup;
  exitShort?: RuleGroup;
  risk: RiskConfig;
  enabled?: boolean;
  /**
   * Draw this strategy's recent high/low on the MetaTrader chart while the bot
   * runs, refreshed each bar. Requires the XATLevels EA on a chart of the
   * symbol; without it the levels are written but nothing renders.
   */
  showLevels?: boolean;
  /** Lookback for those levels, in minutes. */
  levelsMinutes?: number;
  /**
   * Keep this strategy's indicators, rule checklist and open-trade lines drawn
   * on the MT5 chart while its bot runs (needs the XATLevels v2 EA).
   */
  showOverlays?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Instrument specification
// ---------------------------------------------------------------------------

export interface SymbolSpec {
  symbol: string;
  /** Price increment of one point, e.g. 0.00001 for 5-digit EURUSD. */
  point: number;
  digits: number;
  /** Account currency profit per 1.00 lot per 1.0 price move. */
  contractSize: number;
  /** Typical spread in points, used by the backtester. */
  spreadPoints: number;
  /** Round-turn commission per lot in account currency. */
  commissionPerLot: number;
  /** Simulated execution slippage in points. */
  slippagePoints: number;
  /** Value of one point per 1.00 lot in account currency. */
  pointValuePerLot: number;
  /**
   * True when the broker did not report enough contract detail to compute
   * pointValuePerLot exactly, so it was assumed. Position sizes and P&L for
   * such a symbol are estimates — the app surfaces this to the user rather
   * than quietly trading on a guess.
   */
  pointValueEstimated?: boolean;
  /** Human-readable name from the broker, e.g. "Gold vs US Dollar". */
  description?: string;
  minVolume?: number;
  maxVolume?: number;
  volumeStep?: number;
}

export const DEFAULT_SPEC: SymbolSpec = {
  symbol: 'EURUSD',
  point: 0.00001,
  digits: 5,
  contractSize: 100_000,
  spreadPoints: 12,
  commissionPerLot: 7,
  slippagePoints: 3,
  pointValuePerLot: 1, // 100000 * 0.00001 = 1.0 USD per point per lot
};

// ---------------------------------------------------------------------------
// Trades & results
// ---------------------------------------------------------------------------

export type Side = 'long' | 'short';

export interface BacktestTrade {
  id: number;
  side: Side;
  lots: number;
  openTime: number;
  openPrice: number;
  closeTime: number;
  closePrice: number;
  sl: number | null;
  tp: number | null;
  /** Why the position closed. */
  reason: 'sl' | 'tp' | 'signal' | 'opposite' | 'eod' | 'end';
  grossProfit: number;
  commission: number;
  netProfit: number;
  balanceAfter: number;
  maxFavourablePoints: number;
  maxAdversePoints: number;
  barsHeld: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  balance: number;
  drawdownPct: number;
}

export interface BacktestMetrics {
  initialBalance: number;
  finalBalance: number;
  netProfit: number;
  netProfitPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
  sharpe: number;
  totalCommission: number;
  longTrades: number;
  shortTrades: number;
  avgBarsHeld: number;
  barsProcessed: number;
  from: number;
  to: number;
}

export interface BacktestResult {
  strategyId: string;
  strategyName: string;
  symbol: string;
  timeframe: Timeframe;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equity: EquityPoint[];
  warnings: string[];
  /** Signals suppressed per risk gate: dailyLoss, dailyTrades, cooldown, spread, session. */
  gateBlocks?: Record<string, number>;
}
