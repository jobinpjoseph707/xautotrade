/** Mirrors the server's engine types. Keep in sync with server/src/engine/types.ts. */

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

export type IndicatorType =
  | 'sma' | 'ema' | 'wma' | 'rsi' | 'atr' | 'macd' | 'bbands' | 'stoch' | 'adx' | 'cci';

export interface IndicatorSpec {
  id: string;
  type: IndicatorType;
  source?: PriceSource;
  params: Record<string, number>;
}

export type Operand =
  | { kind: 'indicator'; id: string; line?: string; shift?: number }
  | { kind: 'price'; field: PriceSource; shift?: number }
  | { kind: 'const'; value: number }
  | { kind: 'spread' }
  | { kind: 'hourUTC' };

export type ComparisonOp =
  | 'gt' | 'lt' | 'gte' | 'lte' | 'crossesAbove' | 'crossesBelow' | 'risingFor' | 'fallingFor';

export interface Condition {
  left: Operand;
  op: ComparisonOp;
  right: Operand;
}

export interface RuleGroup {
  logic: 'AND' | 'OR';
  conditions: Condition[];
}

export interface RiskConfig {
  lotMode: 'fixed' | 'percentRisk';
  fixedLot: number;
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
  tpRR: number;
  atrIndicatorId?: string;
  trailingEnabled: boolean;
  trailingStartPoints: number;
  trailingStepPoints: number;
  breakEvenPoints: number;
  maxSpreadPoints: number;
  maxOpenPositions: number;
  maxDailyLossPercent: number;
  maxDailyTrades: number;
  cooldownBars: number;
  sessions: { startHour: number; endHour: number }[];
  tradingDays: number[];
  closeOnOppositeSignal: boolean;
  minRewardRisk: number;
  maxSpreadToStopRatio: number;
  flatAtUTC: string;
  flatBeforeWeekend: boolean;
}

export type GateStage = 'backtest' | 'paper' | 'demo' | 'live';

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
  /** Draw this strategy's recent high/low on the MT5 chart while it runs. */
  showLevels?: boolean;
  /** Keep indicators, rule checklist and trades drawn on the MT5 chart while the bot runs. */
  showOverlays?: boolean;
  /** Lookback for those levels, in minutes. */
  levelsMinutes?: number;
  createdAt?: number;
  updatedAt?: number;
  isTest?: boolean;
  gate?: GateStage;
  tier?: number;
  pausedBy?: 'owner' | 'safety';
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

export interface BacktestTrade {
  id: number;
  side: 'long' | 'short';
  lots: number;
  openTime: number;
  openPrice: number;
  closeTime: number;
  closePrice: number;
  sl: number | null;
  tp: number | null;
  reason: string;
  netProfit: number;
  balanceAfter: number;
  barsHeld: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  balance: number;
  drawdownPct: number;
}

export interface BacktestResult {
  id?: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  timeframe: Timeframe;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equity: EquityPoint[];
  warnings: string[];
  candles?: number;
  elapsedMs?: number;
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

export interface SymbolSpec {
  symbol: string;
  point: number;
  digits: number;
  contractSize: number;
  spreadPoints: number;
  commissionPerLot: number;
  slippagePoints: number;
  pointValuePerLot: number;
  /** True when the broker didn't report enough detail to compute this exactly. */
  pointValueEstimated?: boolean;
  description?: string;
  minVolume?: number;
  maxVolume?: number;
  volumeStep?: number;
  quote?: { bid: number; ask: number; spreadPoints: number; time: number } | null;
}

export interface LevelsRangeResult {
  symbol: string;
  minutes: number;
  timeframe: string;
  barsRequested: number;
  barsUsed: number;
  resistance: number;
  support: number;
  spanSeconds: number;
  file: string;
  note: string;
}

export interface LevelsStatus {
  directory: string;
  file: string;
  exists: boolean;
  levelCount: number;
  raw: string;
  note: string;
}

export interface AccountInfo {
  broker: string;
  currency: string;
  server: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  type: string;
  name: string;
  mode: 'paper' | 'metaapi' | 'mt5mcp';
  liveTradingAllowed: boolean;
}

export interface BotSnapshot {
  strategyId: string;
  strategyName: string;
  symbol: string;
  timeframe: string;
  status: 'stopped' | 'starting' | 'running' | 'error';
  startedAt: number | null;
  lastTickAt: number | null;
  /** Open time of the last closed bar, real UTC (server already removed the broker's time-zone offset). */
  lastBarTime: number | null;
  serverOffsetMinutes?: number;
  /** Floating P&L of this bot's open positions (refreshed every few seconds). */
  floatingProfit?: number;
  nextTickAt: number | null;
  lastSignal: string | null;
  blockedReason: string | null;
  tradesToday: number;
  dayStartEquity: number | null;
  realisedToday: number;
  openPositions: BrokerPosition[];
  error: string | null;
  paper: boolean;
}

export interface LogEntry {
  id?: number;
  ts: number;
  strategyId: string | null;
  level: 'info' | 'warn' | 'error' | 'trade';
  event: string;
  message: string;
  data?: unknown;
}

export interface IndicatorCatalogEntry {
  type: IndicatorType;
  label: string;
  lines: readonly string[];
  params: readonly { key: string; label: string; default: number; min: number; max: number }[];
  usesSource: boolean;
}

export interface Catalog {
  indicators: IndicatorCatalogEntry[];
  operators: { value: ComparisonOp; label: string }[];
  priceFields: PriceSource[];
  timeframes: Timeframe[];
  presets: { key: string; label: string; description: string; warning?: string }[];
  defaultRisk: RiskConfig;
}

// ---------------------------------------------------------------------------
// Chat agents
// ---------------------------------------------------------------------------

export interface ChatAgent {
  id: string;
  name: string;
  tagline: string;
  model?: string;
}

export interface MetricsLite {
  bars: number;
  trades: number;
  netProfitPct: number;
  profitFactor: number;
  winRatePct: number;
  maxDrawdownPct: number;
}

export interface WindowResult {
  from: number;
  to: number;
  before: MetricsLite | null;
  after: MetricsLite | null;
}

export interface Validation {
  verdict: 'pass' | 'fail' | 'insufficient' | 'skipped' | 'error';
  reasons: string[];
  inSample?: WindowResult;
  outOfSample?: WindowResult;
}

export interface CriticVerdict {
  verdict: 'support' | 'caution' | 'oppose';
  points: string[];
  source: string;
}

export interface ChatProposal {
  id: string;
  agent: string;
  summary: string;
  reason?: string;
  warnings: string[];
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  resultMessage?: string;
  model?: string;
  validation?: Validation;
  critic?: CriticVerdict;
}

export interface ChatResult {
  agent: string;
  agentName: string;
  model?: string;
  reply: string;
  proposals: ChatProposal[];
  rejected: string[];
}

// ---------------------------------------------------------------------------
// Learning: outcome memory, notebooks, scoreboard, auto-evolve
// ---------------------------------------------------------------------------

export type Score = 'pending' | 'helped' | 'hurt' | 'inconclusive' | 'n/a';

export interface ChangeRecord {
  id: string;
  createdAt: number;
  source: 'chat' | 'evolve';
  agent: string;
  model: string;
  actionType: string;
  strategyId: string | null;
  summary: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected' | 'failed' | 'blocked';
  decidedAt?: number;
  validation?: Validation;
  critic?: CriticVerdict;
  score: Score;
  scoreReasons: string[];
}

export interface ScoreRow {
  key: string;
  agent: string;
  model: string | null;
  proposed: number;
  heldBack: number;
  approved: number;
  rejected: number;
  helped: number;
  hurt: number;
  inconclusive: number;
  pending: number;
  hitRate: number | null;
}

export interface Scoreboard {
  byAgent: ScoreRow[];
  byModel: ScoreRow[];
  critic: { opposedThenHurt: number; opposedThenHelped: number; supportedThenHelped: number; supportedThenHurt: number };
  trend: { recent: number | null; previous: number | null };
}

export interface Lesson {
  key: string;
  agent: string | null;
  text: string;
  direction: 'helped' | 'hurt';
}

export interface Notebook {
  agent: string;
  name: string;
  lessons: Lesson[];
  shared: Lesson[];
  notes: string[];
}

export interface EvolveSettings {
  enabled: boolean;
  strategyIds: string[];
  intervalHours: number;
  testDays: number;
  lastRunAt: number | null;
}

export interface EvolveCandidate {
  id: string;
  createdAt: number;
  parentId: string;
  parentName: string;
  summary: string;
  reason?: string;
  model: string;
  validation: Validation;
  status: 'testing' | 'winner' | 'loser' | 'inconclusive' | 'promoted' | 'dismissed';
  forward?: WindowResult;
  verdictReasons: string[];
}

/** GET /strategies/:id/trades — header numbers computed from the same rows as the list. */
export interface StrategyTrades {
  from: number;
  to: number;
  opened: number;
  closed: number;
  wins: number;
  losses: number;
  realised: number;
  openPositions: BrokerPosition[];
  floating: number;
  brokerOk: boolean;
  events: LogEntry[];
}

/** GET /markets — can each strategy's symbol be traded on this account right now? */
export interface MarketStatus {
  symbol: string;
  available: boolean;
  tradeMode: 'full' | 'long_only' | 'short_only' | 'close_only' | 'disabled' | null;
  open: boolean | null;
  lastTickAt: number | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  description: string | null;
  reason: string | null;
  checkedAt: number;
}

/** POST /levels/strategy/:id — what a strategy looks at, for the preview and the MT5 chart. */
export interface OverlayPreview {
  times: number[];
  closes: number[];
  series: { id: string; label: string; color: string; points: (number | null)[] }[];
  panel: { id: string; label: string; value: string; color: string }[];
  rules: { side: string; logic: 'AND' | 'OR'; passed: boolean; conditions: { text: string; ok: boolean }[] }[];
  signal: 'LONG' | 'SHORT' | 'none';
  lastBarTime: number | null;
  objectCount: number;
  published: { file: string; count: number } | null;
  live: boolean;
  note: string;
}

// ---------------------------------------------------------------------------
// Trade journal
// ---------------------------------------------------------------------------

export type ExitReason = 'tp' | 'sl' | 'stop_out' | 'exit_rule' | 'opposite' | 'panic' | 'manual' | 'bot' | 'unknown';

export interface JournalTrade {
  positionId: string;
  strategyId: string | null;
  strategyName: string;
  symbol: string;
  side: 'long' | 'short' | null;
  volume: number | null;
  status: 'open' | 'closed' | 'unrecorded';
  outcome: 'win' | 'loss' | 'breakeven' | 'open' | 'unknown';
  openTime: number | null;
  closeTime: number | null;
  durationMs: number | null;
  openPrice: number | null;
  closePrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  plannedRR: number | null;
  profit: number | null;
  commission: number | null;
  swap: number | null;
  exitReason: ExitReason | null;
  spreadPoints: number | null;
  source: 'broker' | 'log';
}

export interface JournalResponse {
  from: number;
  to: number;
  trades: JournalTrade[];
  strategies: { id: string; name: string; symbol: string }[];
  pendingDetails: number;
  brokerOk: boolean;
  generatedAt: number;
}

// Placeholders for the Phase 1-2 endpoints; each is narrowed by its own task.
export type InboxKind = 'proposal' | 'gate_result' | 'error' | 'stall' | 'losing_streak' | 'safety_action' | 'claude_unavailable' | 'digest';
export type InboxAction = 'approve' | 'reject' | 'restart' | 'dismiss' | 'ok' | 'undo' | 'stage' | 'keep';
export type InboxItem = {
  id: string;
  kind: InboxKind;
  status: 'open' | 'done' | 'dismissed';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  strategyId?: string;
  ref?: string;
  count: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  outcome?: string;
  actions: InboxAction[];
};
export type TestboardEntry = { strategyId: string; gate: GateStage };
export type TierSummary = { tier: number; strategyIds: string[] };
