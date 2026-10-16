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
  /** Backtest of the strategy as it is next to the proposed one (what-if proposals). */
  whatIf?: { before: BacktestSummary; after: BacktestSummary };
}

export type BacktestSummary = {
  strategyId: string;
  trades?: number;
  netProfitPct?: number;
  winRatePct?: number;
  profitFactor?: number;
  maxDrawdownPct?: number;
  error?: string;
};

export type ChatButton = 'tune' | 'diagnose' | 'tighten' | 'critique';

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

/** One lesson in an agent's ledger: what a kind of change did, in exactly one market. */
export interface Lesson {
  text: string;
  trusted: boolean;
  verdict: 'helped' | 'hurt';
  agree: number;
  against: number;
  unclear: number;
  setting: string;
  change: string;
  market: string;
  lastAt: number;
}

export interface Notebook {
  agent: string;
  name: string;
  /** What the user wrote. */
  notes: string[];
  lessons: Lesson[];
  /** Settings where trusted lessons disagree in one market, so the agent leaves them alone there. */
  holds: { setting: string; market: string }[];
  /** Scored changes that do not count yet (under 30 demo trades, or several things changed at once). */
  ignored: number;
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
/** One list of every kind of Inbox card, so the Help text can be checked against it. Mirrors the server's INBOX_KINDS. */
export const INBOX_KINDS = ['proposal', 'gate_result', 'error', 'stall', 'losing_streak', 'safety_action', 'claude_unavailable', 'agent_unavailable', 'digest'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
/** Testboard verdicts. Mirrors the server's GateVerdict; Help is tested against this list. */
export const TESTBOARD_VERDICTS = ['pass', 'fail', 'not_enough_evidence'] as const;
export type TestboardVerdict = (typeof TESTBOARD_VERDICTS)[number];
export type InboxAction = 'approve' | 'reject' | 'restart' | 'dismiss' | 'ok' | 'undo' | 'stage' | 'keep';
export type InboxItem = {
  id: string;
  kind: InboxKind;
  status: 'open' | 'done' | 'dismissed';
  severity: 'info' | 'warn' | 'critical';
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
export type TestboardEntry = {
  strategyId: string;
  name: string;
  symbol: string;
  gate: GateStage;
  stage: GateStage;
  /** The most recent test of the stage it is in. */
  latest: { verdict: TestboardVerdict; passed: boolean; reasons: string[]; at: number; attemptNo?: number; requiredProfitFactor?: number } | null;
  /** Demo stage only. */
  progress: { trades: number; tradesNeeded: number; days: number; daysNeeded: number } | null;
  /** A pass is waiting for you to tap Move to next stage in the Inbox. */
  waiting: boolean;
};
export type TierSummary = {
  tier: number;
  name: string;
  /** Open risk to the stop this tier may have, % of equity. */
  capPct: number;
  /** Open risk to the stop right now, % of equity. Null when the broker could not be asked. */
  openRiskPct: number | null;
  strategies: { id: string; name: string; provisional: boolean }[];
};

// --- Lessons from the old weekly rotation (read only) ----------------------------

export type LegacyLesson = {
  id: string;
  createdAt: number;
  weekStart: string | null;
  strategyName: string | null;
  market: { symbol: string; timeframe: string } | null;
  verdict: string | null;
  returnPct: number | null;
  rootCause: string | null;
  summary: string;
  change: string | null;
  /** True when the old record named no market: shown, never used. */
  displayOnly: boolean;
};

// --- Token usage (Settings) ---------------------------------------------------

export type UsageGroup = { calls: number; totalTokens: number; costUsd: number };
export type ChatUsage = {
  period: 'today' | '7d' | '30d' | 'all';
  calls: number;
  totalTokens: number;
  costUsd: number;
  byDay: (UsageGroup & { day: string; agents: ({ agent: string } & UsageGroup)[] })[];
  byAgent: ({ agent: string } & UsageGroup)[];
  /** Calls the app made by itself today, against the daily cap. */
  unattended: { day: string; used: number; cap: number; signedOut: boolean };
};

// --- YouTube import ----------------------------------------------------------

export interface YoutubeGap {
  severity: 'blocking' | 'assumed';
  code: string;
  message: string;
  evidence?: string;
}

export interface YoutubeGate {
  passed: boolean;
  reasons: string[];
  trades: number;
  maxDrawdownPct: number;
  profitFactor: number;
  /** Real MT5 candles the strategy was tested on. */
  bars: number;
}

export interface YoutubeResult {
  status: 'candidate' | 'needs_review';
  candidateId: string | null;
  videoId: string;
  strategy: Strategy | null;
  gaps: YoutubeGap[];
  notes: string[];
  gate: YoutubeGate | null;
}

export interface YoutubeAgentResult {
  videoId: string;
  /** What the Strategist said: the rules it quoted, what it assumed, what it ignored. */
  reply: string;
  proposals: ChatProposal[];
  /** Strategies the safety rules refused, with the reason. */
  rejected: string[];
  transcriptChars: number;
  /** The transcript was longer than the Strategist reads, so the end was cut. */
  truncated: boolean;
}
