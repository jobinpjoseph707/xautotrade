/**
 * Failure -> lesson handoff. Everything here is rule-based and deterministic:
 * statistics come straight from the trade log, findings from fixed thresholds.
 */
import type { BacktestTrade, Side, Strategy } from '../engine/types.js';
import type { ActiveAgent, AgentRecord, SuccessCriteria, WeekOutcome } from './types.js';

export type SessionName = 'asia' | 'london' | 'newyork' | 'offhours';

/** UTC hour windows [start, end). */
export const SESSION_HOURS: Record<SessionName, [number, number]> = {
  asia: [0, 7],
  london: [7, 13],
  newyork: [13, 21],
  offhours: [21, 24],
};

export function sessionOf(timeMs: number): SessionName {
  const h = new Date(timeMs).getUTCHours();
  for (const [name, [a, b]] of Object.entries(SESSION_HOURS) as [SessionName, [number, number]][]) {
    if (h >= a && h < b) return name;
  }
  return 'offhours';
}

export interface LessonTrade {
  id: number;
  direction: Side;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: BacktestTrade['reason'];
  netProfit: number;
  result: 'win' | 'loss';
  session: SessionName;
  weekday: number; // UTC, 0 = Sunday
}

export interface Bucket {
  trades: number;
  losses: number;
  netProfit: number;
}

export interface LessonStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWin: number;
  avgLoss: number; // positive magnitude
  /** avgLoss / avgWin; null when there are no wins or no losses. */
  lossToWinRatio: number | null;
  profitFactor: number | null;
  expectancy: number;
  maxConsecutiveLosses: number;
  bySession: Record<string, Bucket>;
  byWeekday: Record<string, Bucket>;
  exitReasons: Record<string, number>;
  drawdown: {
    maxPct: number;
    /** Where in the week (0..1, by equity-curve time) the deepest trough fell. */
    troughWeekFraction: number | null;
  };
}

export type FindingCode =
  | 'SESSION_CLUSTER'
  | 'WEEKDAY_CLUSTER'
  | 'SPREAD_GATE'
  | 'DAILY_LOSS_GATE'
  | 'ASYMMETRIC_LOSSES'
  | 'DRAWDOWN_BREACH'
  | 'LOW_WIN_RATE'
  | 'RETURN_SHORTFALL';

export interface Finding {
  code: FindingCode;
  /** Actionable findings can drive a config change; the rest are informational. */
  actionable: boolean;
  message: string;
  data: Record<string, number | string>;
}

export interface Lesson {
  lessonId: string;
  agentId: string;
  generation: number;
  weekStart: string;
  weekEnd: string;
  strategy: Strategy;
  verdict: AgentRecord['verdict'];
  returnPct: number;
  criteria: SuccessCriteria;
  trades: LessonTrade[];
  /** Risk gates that suppressed signals this week, with counts. */
  gatesTripped: Record<string, number>;
  stats: LessonStats;
  findings: Finding[];
  /** Code of the highest-priority actionable finding, or null. */
  rootCause: FindingCode | null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const r2 = (n: number) => Math.round(n * 100) / 100;

function addTo(map: Record<string, Bucket>, key: string, t: LessonTrade): void {
  const b = (map[key] ??= { trades: 0, losses: 0, netProfit: 0 });
  b.trades += 1;
  if (t.result === 'loss') b.losses += 1;
  b.netProfit = r2(b.netProfit + t.netProfit);
}

export function toLessonTrades(trades: BacktestTrade[]): LessonTrade[] {
  return trades.map((t) => ({
    id: t.id,
    direction: t.side,
    entryTime: t.openTime,
    entryPrice: t.openPrice,
    exitTime: t.closeTime,
    exitPrice: t.closePrice,
    exitReason: t.reason,
    netProfit: t.netProfit,
    result: t.netProfit > 0 ? 'win' : 'loss',
    session: sessionOf(t.openTime),
    weekday: new Date(t.openTime).getUTCDay(),
  }));
}

export function computeStats(
  trades: LessonTrade[],
  equityCurve: WeekOutcome['equityCurve'],
  startingBalance: number,
): LessonStats {
  const wins = trades.filter((t) => t.result === 'win');
  const losses = trades.filter((t) => t.result === 'loss');
  const grossWin = wins.reduce((a, t) => a + t.netProfit, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netProfit, 0));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  let consec = 0;
  let maxConsec = 0;
  for (const t of trades) {
    consec = t.result === 'loss' ? consec + 1 : 0;
    if (consec > maxConsec) maxConsec = consec;
  }

  const bySession: Record<string, Bucket> = {};
  const byWeekday: Record<string, Bucket> = {};
  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    addTo(bySession, t.session, t);
    addTo(byWeekday, DAY_NAMES[t.weekday], t);
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  }

  // Drawdown on equity, with the time of the deepest trough.
  let peak = startingBalance;
  let maxPct = 0;
  let troughTime: number | null = null;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (dd > maxPct) {
      maxPct = dd;
      troughTime = p.time;
    }
  }
  let troughWeekFraction: number | null = null;
  if (troughTime != null && equityCurve.length > 1) {
    const t0 = equityCurve[0].time;
    const t1 = equityCurve[equityCurve.length - 1].time;
    troughWeekFraction = t1 > t0 ? r2((troughTime - t0) / (t1 - t0)) : 0;
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? r2((wins.length / trades.length) * 100) : 0,
    avgWin: r2(avgWin),
    avgLoss: r2(avgLoss),
    lossToWinRatio: avgWin > 0 && avgLoss > 0 ? r2(avgLoss / avgWin) : null,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    expectancy: trades.length ? r2((grossWin - grossLoss) / trades.length) : 0,
    maxConsecutiveLosses: maxConsec,
    bySession,
    byWeekday,
    exitReasons,
    drawdown: { maxPct: r2(maxPct), troughWeekFraction },
  };
}

/** Thresholds are constants so the rules are explainable and testable. */
export const THRESHOLDS = {
  clusterMinLosses: 3,
  clusterLossShare: 0.6,
  asymmetricRatio: 1.5,
  lowWinRatePct: 40,
  spreadGateBlocks: 5,
  dailyLossGateBlocks: 1,
};

function clusterFinding(
  kind: 'SESSION_CLUSTER' | 'WEEKDAY_CLUSTER',
  buckets: Record<string, Bucket>,
  stats: LessonStats,
): Finding | null {
  if (stats.losses < THRESHOLDS.clusterMinLosses) return null;
  const overallLossRate = stats.losses / stats.trades;
  let worst: [string, Bucket] | null = null;
  for (const e of Object.entries(buckets)) {
    if (!worst || e[1].losses > worst[1].losses || (e[1].losses === worst[1].losses && e[1].netProfit < worst[1].netProfit)) worst = e;
  }
  if (!worst) return null;
  const [name, b] = worst;
  const share = b.losses / stats.losses;
  if (b.losses < THRESHOLDS.clusterMinLosses || share < THRESHOLDS.clusterLossShare) return null;
  if (b.losses / b.trades <= overallLossRate) return null;
  const label = kind === 'SESSION_CLUSTER' ? 'session' : 'weekday';
  return {
    code: kind,
    actionable: true,
    message: `${b.losses} of ${stats.losses} losses came in the ${name} ${label} (net ${b.netProfit}).`,
    data: { bucket: name, losses: b.losses, totalLosses: stats.losses, netProfit: b.netProfit },
  };
}

export function buildFindings(
  stats: LessonStats,
  gates: Record<string, number>,
  record: Pick<AgentRecord, 'returnPct' | 'maxDrawdownPct' | 'criteria'>,
): Finding[] {
  const out: Finding[] = [];
  const push = (f: Finding | null) => f && out.push(f);

  push(clusterFinding('SESSION_CLUSTER', stats.bySession, stats));
  push(clusterFinding('WEEKDAY_CLUSTER', stats.byWeekday, stats));

  if ((gates.spread ?? 0) >= THRESHOLDS.spreadGateBlocks) {
    out.push({
      code: 'SPREAD_GATE',
      actionable: true,
      message: `The spread gate suppressed ${gates.spread} signals; spreads regularly sit near the limit, so trades that squeak under it still pay a near-limit spread.`,
      data: { blocked: gates.spread },
    });
  }
  if ((gates.dailyLoss ?? 0) >= THRESHOLDS.dailyLossGateBlocks) {
    out.push({
      code: 'DAILY_LOSS_GATE',
      actionable: true,
      message: `The daily loss cap tripped and suppressed ${gates.dailyLoss} signals; position size is too large for the account's daily loss budget.`,
      data: { blocked: gates.dailyLoss },
    });
  }
  if (stats.lossToWinRatio != null && stats.lossToWinRatio >= THRESHOLDS.asymmetricRatio) {
    out.push({
      code: 'ASYMMETRIC_LOSSES',
      actionable: true,
      message: `Average loss exceeded average win by ${stats.lossToWinRatio}x (${stats.avgLoss} vs ${stats.avgWin}).`,
      data: { ratio: stats.lossToWinRatio, avgLoss: stats.avgLoss, avgWin: stats.avgWin },
    });
  }
  if (record.maxDrawdownPct >= record.criteria.maxDrawdownPct) {
    const f = stats.drawdown.troughWeekFraction;
    out.push({
      code: 'DRAWDOWN_BREACH',
      actionable: true,
      message: `Max equity drawdown ${r2(record.maxDrawdownPct)}% breached the ${record.criteria.maxDrawdownPct}% limit${f != null ? ` (trough ${Math.round(f * 100)}% of the way through the week)` : ''}.`,
      data: { maxPct: r2(record.maxDrawdownPct), limit: record.criteria.maxDrawdownPct },
    });
  }
  if (stats.trades > 0 && stats.winRatePct < THRESHOLDS.lowWinRatePct) {
    out.push({
      code: 'LOW_WIN_RATE',
      actionable: false,
      message: `Win rate was ${stats.winRatePct}% (${stats.wins} of ${stats.trades}).`,
      data: { winRatePct: stats.winRatePct },
    });
  }
  if (record.returnPct < record.criteria.minReturnPct) {
    out.push({
      code: 'RETURN_SHORTFALL',
      actionable: false,
      message: `Return ${r2(record.returnPct)}% was below the required ${record.criteria.minReturnPct}%.`,
      data: { returnPct: r2(record.returnPct) },
    });
  }
  return out;
}

/** Order matters: earlier codes are treated as the more specific root cause. */
export const PRIORITY: FindingCode[] = [
  'SESSION_CLUSTER',
  'WEEKDAY_CLUSTER',
  'SPREAD_GATE',
  'DAILY_LOSS_GATE',
  'ASYMMETRIC_LOSSES',
  'DRAWDOWN_BREACH',
];

export function buildLesson(agent: ActiveAgent, record: AgentRecord, outcome: WeekOutcome): Lesson {
  const trades = toLessonTrades(outcome.trades ?? []);
  const stats = computeStats(trades, outcome.equityCurve, outcome.startingBalance);
  const gates = Object.fromEntries(Object.entries(outcome.gateBlocks ?? {}).filter(([, n]) => n > 0));
  const findings = buildFindings(stats, gates, record);
  const rootCause = PRIORITY.find((c) => findings.some((f) => f.code === c && f.actionable)) ?? null;
  return {
    lessonId: `${record.agentId}:${record.weekStart}`,
    agentId: record.agentId,
    generation: record.generation,
    weekStart: record.weekStart,
    weekEnd: record.weekEnd,
    strategy: structuredClone(agent.strategy),
    verdict: record.verdict,
    returnPct: r2(record.returnPct),
    criteria: { ...record.criteria },
    trades,
    gatesTripped: gates,
    stats,
    findings,
    rootCause,
  };
}
