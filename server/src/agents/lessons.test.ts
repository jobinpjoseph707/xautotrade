import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLesson, computeStats, toLessonTrades } from './lessons.js';
import { gateViolation, proposeNextConfig } from './propose.js';
import { LessonStore } from './lessonStore.js';
import { closeOutWeek, startFirstAgent } from './rotation.js';
import { MemoryAgentStore } from './store.js';
import { emaPullbackScalp } from '../engine/presets.js';
import type { BacktestTrade } from '../engine/types.js';
import type { ActiveAgent, AgentRecord, SuccessCriteria, WeekOutcome } from './types.js';

const criteria: SuccessCriteria = { minReturnPct: 2, maxDrawdownPct: 5 };
const MON = Date.UTC(2026, 8, 14); // Monday 2026-09-14 00:00 UTC
const H = 3_600_000;

function bt(id: number, day: number, hour: number, net: number, reason: BacktestTrade['reason']): BacktestTrade {
  const t = MON + day * 24 * H + hour * H;
  return {
    id, side: 'long', lots: 0.1, openTime: t, openPrice: 2000, closeTime: t + H, closePrice: 2001,
    sl: null, tp: null, reason, grossProfit: net, commission: 0, netProfit: net, balanceAfter: 0,
    maxFavourablePoints: 0, maxAdversePoints: 0, barsHeld: 12,
  };
}

// Hand-checked fixture (see comments for the arithmetic).
const FIXTURE: BacktestTrade[] = [
  bt(1, 0, 8, 30, 'tp'), // Mon london  W
  bt(2, 0, 9, 20, 'tp'), // Mon london  W
  bt(3, 1, 2, -50, 'sl'), // Tue asia    L
  bt(4, 1, 3, -40, 'sl'), // Tue asia    L
  bt(5, 2, 4, -60, 'sl'), // Wed asia    L
  bt(6, 2, 14, 25, 'tp'), // Wed newyork W
  bt(7, 3, 5, -45, 'sl'), // Thu asia    L
  bt(8, 3, 15, -30, 'sl'), // Thu newyork L
  bt(9, 4, 6, -55, 'sl'), // Fri asia    L
  bt(10, 4, 10, 35, 'tp'), // Fri london  W
];
// wins: 30,20,25,35 = 110 -> avgWin 27.5, 4 of 10 => 40%
// losses: 50,40,60,45,30,55 = 280 -> avgLoss 46.67, ratio 46.67/27.5 = 1.70
// profit factor 110/280 = 0.39; expectancy (110-280)/10 = -17
// asia: 5 trades, 5 losses, net -250; london 3 trades 0 losses +85; newyork 2 trades 1 loss -5
// max consecutive losses: 3 (trades 3-5, and 7-9)

/** Preset with the session/day/spread limits opened up, so each test controls them. */
function openStrategy() {
  const s = emaPullbackScalp('XAUUSD');
  s.risk = { ...s.risk, sessions: [], tradingDays: [], maxSpreadPoints: 25 };
  return s;
}

function agentAndRecord(strategy = openStrategy()): { agent: ActiveAgent; record: AgentRecord } {
  const agent: ActiveAgent = {
    agentId: 'agent-x', generation: 1, parentAgentId: null,
    weekStart: new Date(MON).toISOString(), weekEnd: new Date(MON + 7 * 24 * H).toISOString(),
    strategy, startingBalance: 10_000,
  };
  const record: AgentRecord = {
    agentId: 'agent-x', generation: 1, parentAgentId: null, weekStart: agent.weekStart, weekEnd: agent.weekEnd,
    strategy, startingBalance: 10_000, endingBalance: 9_830, returnPct: -1.7, maxDrawdownPct: 2.5,
    tradeCount: 10, verdict: 'fail', reasons: [], criteria, closedAt: new Date(MON).toISOString(),
  };
  return { agent, record };
}

function outcome(trades: BacktestTrade[], gateBlocks: Record<string, number> = {}): WeekOutcome {
  return {
    startingBalance: 10_000, endingBalance: 9_830,
    equityCurve: [
      { time: MON, equity: 10_000 },
      { time: MON + 3 * 24 * H, equity: 9_750 },
      { time: MON + 7 * 24 * H, equity: 9_830 },
    ],
    tradeCount: trades.length, trades, gateBlocks,
  };
}

test('lesson from a known trade log produces hand-checked stats', () => {
  const s = computeStats(toLessonTrades(FIXTURE), outcome(FIXTURE).equityCurve, 10_000);
  assert.equal(s.trades, 10);
  assert.equal(s.winRatePct, 40);
  assert.equal(s.avgWin, 27.5);
  assert.equal(s.avgLoss, 46.67);
  assert.equal(s.lossToWinRatio, 1.7);
  assert.equal(s.profitFactor, 0.39);
  assert.equal(s.expectancy, -17);
  assert.equal(s.maxConsecutiveLosses, 3);
  assert.deepEqual(s.bySession.asia, { trades: 5, losses: 5, netProfit: -250 });
  assert.deepEqual(s.bySession.london, { trades: 3, losses: 0, netProfit: 85 });
  assert.deepEqual(s.bySession.newyork, { trades: 2, losses: 1, netProfit: -5 });
  assert.deepEqual(s.exitReasons, { tp: 4, sl: 6 });
  // Trough is 3 days into a 7-day curve: 3/7 = 0.43; 2.5% deep.
  assert.equal(s.drawdown.maxPct, 2.5);
  assert.equal(s.drawdown.troughWeekFraction, 0.43);
});

test('lesson names the session cluster as root cause and records each trade', () => {
  const { agent, record } = agentAndRecord();
  const lesson = buildLesson(agent, record, outcome(FIXTURE));
  assert.equal(lesson.rootCause, 'SESSION_CLUSTER');
  assert.match(lesson.findings[0].message, /5 of 6 losses came in the asia session/);
  assert.equal(lesson.trades.length, 10);
  assert.equal(lesson.trades[2].session, 'asia');
  assert.equal(lesson.trades[2].result, 'loss');
  assert.ok(lesson.findings.some((f) => f.code === 'ASYMMETRIC_LOSSES'));
});

test('session proposal removes the clustered hours as one explained change', () => {
  const { agent, record } = agentAndRecord();
  const lesson = buildLesson(agent, record, outcome(FIXTURE));
  const p = proposeNextConfig(agent.strategy, lesson);
  assert.equal(p.change?.parameter, 'risk.sessions');
  assert.deepEqual(p.strategy.risk.sessions, [{ startHour: 7, endHour: 24 }]);
  assert.match(p.reasoning, /exclude asia hours/i);
  // Nothing else changed.
  assert.deepEqual({ ...p.strategy.risk, sessions: [] }, { ...agent.strategy.risk, sessions: [] });
  assert.equal(gateViolation(agent.strategy.risk, p.strategy.risk), null);
});

test('proposals never relax a risk gate', () => {
  const base = openStrategy().risk;
  assert.match(gateViolation(base, { ...base, fixedLot: base.fixedLot * 2 }) ?? '', /fixedLot/);
  assert.match(gateViolation(base, { ...base, maxDailyLossPercent: base.maxDailyLossPercent + 1 }) ?? '', /maxDailyLossPercent/);
  assert.match(gateViolation(base, { ...base, maxDailyLossPercent: 0 }) ?? '', /maxDailyLossPercent/);
  assert.match(gateViolation(base, { ...base, maxSpreadPoints: base.maxSpreadPoints + 5 }) ?? '', /maxSpreadPoints/);
  assert.match(gateViolation({ ...base, sessions: [{ startHour: 7, endHour: 13 }] }, { ...base, sessions: [] }) ?? '', /sessions/);

  // Generated proposals always pass the check, including size cuts for a drawdown breach.
  const { agent, record } = agentAndRecord();
  const dd = buildLesson(agent, { ...record, maxDrawdownPct: 9 }, { ...outcome([]), equityCurve: outcome([]).equityCurve });
  const p = proposeNextConfig(agent.strategy, dd);
  assert.equal(gateViolation(agent.strategy.risk, p.strategy.risk), null);
  assert.ok(p.strategy.risk.fixedLot <= agent.strategy.risk.fixedLot);
});

test('two consecutive spread-gate failures keep addressing the spread limit', () => {
  // Balanced trades, no cluster, no asymmetry: only the spread gate stands out.
  const flat: BacktestTrade[] = [
    bt(1, 0, 8, 20, 'tp'), bt(2, 1, 14, -20, 'sl'), bt(3, 2, 9, 20, 'tp'),
    bt(4, 3, 15, -20, 'sl'), bt(5, 4, 8, -20, 'sl'), bt(6, 4, 14, 20, 'tp'),
  ];
  const { agent, record } = agentAndRecord();
  const l1 = buildLesson(agent, record, outcome(flat, { spread: 20 }));
  assert.equal(l1.rootCause, 'SPREAD_GATE');
  const p1 = proposeNextConfig(agent.strategy, l1);
  assert.equal(p1.change?.parameter, 'risk.maxSpreadPoints');
  assert.equal(p1.change?.to, 20); // 25 * 0.8

  const agent2 = { ...agent, agentId: 'agent-y', strategy: p1.strategy };
  const l2 = buildLesson(agent2, { ...record, agentId: 'agent-y' }, outcome(flat, { spread: 18 }));
  const p2 = proposeNextConfig(agent2.strategy, l2, [l1]);
  assert.equal(p2.rootCause, 'SPREAD_GATE');
  assert.equal(p2.change?.parameter, 'risk.maxSpreadPoints');
  assert.equal(p2.change?.to, 16);
  assert.match(p2.reasoning, /Repeat cause/);
  assert.deepEqual({ ...p2.strategy.risk, maxSpreadPoints: 0 }, { ...agent.strategy.risk, maxSpreadPoints: 0 });
});

test('an exhausted knob yields no change rather than drifting to another parameter', () => {
  const s = openStrategy();
  s.risk.maxSpreadPoints = 1;
  const flat = [bt(1, 0, 8, 20, 'tp'), bt(2, 1, 14, -20, 'sl')];
  const { agent, record } = agentAndRecord(s);
  const lesson = buildLesson(agent, record, outcome(flat, { spread: 30 }));
  const p = proposeNextConfig(s, lesson);
  assert.equal(p.change, null);
  assert.deepEqual(p.strategy, s);
  assert.match(p.reasoning, /manual review/);
});

test('lesson history is append-only, ordered, and queryable by week', () => {
  const store = new LessonStore();
  const { agent, record } = agentAndRecord();
  const weeks = [0, 7, 14, 21, 28];
  for (const [i, d] of weeks.entries()) {
    const ws = new Date(MON + d * 24 * H).toISOString();
    const a = { ...agent, agentId: `a${i}`, weekStart: ws };
    const r = { ...record, agentId: `a${i}`, weekStart: ws };
    const lesson = buildLesson(a, r, outcome(FIXTURE));
    store.append({ lesson, proposal: proposeNextConfig(a.strategy, lesson), createdAt: ws });
  }
  assert.equal(store.all().length, 5);
  const last4 = store.last(4).map((e) => e.lesson.agentId);
  assert.deepEqual(last4, ['a1', 'a2', 'a3', 'a4']);
  assert.equal(store.byWeek('2026-09-21').length, 1);
  assert.equal(store.byWeek('2026-09-21')[0].lesson.agentId, 'a1');

  const dup = store.all()[0];
  assert.throws(() => store.append(dup), /already exists/);
  assert.throws(() => {
    (store.all()[0] as { createdAt: string }).createdAt = 'x';
  }, TypeError);
});

test('closeOutWeek wires lessons in on failure and the successor gets the proposed config', () => {
  const store = new MemoryAgentStore();
  const lessons = new LessonStore();
  const agent = startFirstAgent(store, openStrategy(), 10_000, new Date(MON));
  const o = { ...outcome(FIXTURE), endingBalance: 9_830 };
  const { next, record } = closeOutWeek(store, agent, o, criteria, () => {}, () => new Date(MON), lessons);
  assert.equal(record.verdict, 'fail');
  assert.equal(lessons.all().length, 1);
  assert.deepEqual(next.strategy.risk.sessions, [{ startHour: 7, endHour: 24 }]);

  // Re-running does not add a second lesson.
  closeOutWeek(store, agent, o, criteria, () => {}, () => new Date(MON), lessons);
  assert.equal(lessons.all().length, 1);
});
