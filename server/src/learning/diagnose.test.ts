import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeStats, diagnose, toLessonTrades, type DiagnosisInput, type SuccessCriteria, type WindowOutcome } from './diagnose.js';
import { gateViolation, proposeNextConfig } from './propose.js';
import { emaPullbackScalp } from '../engine/presets.js';
import type { BacktestTrade, Strategy } from '../engine/types.js';

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

function input(strategy: Strategy = openStrategy(), over: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    id: 'window-x', from: new Date(MON).toISOString(), to: new Date(MON + 7 * 24 * H).toISOString(),
    strategy, verdict: 'fail', returnPct: -1.7, maxDrawdownPct: 2.5, criteria, ...over,
  };
}

function outcome(trades: BacktestTrade[], gateBlocks: Record<string, number> = {}): WindowOutcome {
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

test('diagnosis from a known trade log produces hand-checked stats', () => {
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

test('diagnosis names the session cluster as root cause and records each trade', () => {
  const lesson = diagnose(input(), outcome(FIXTURE));
  assert.equal(lesson.rootCause, 'SESSION_CLUSTER');
  assert.match(lesson.findings[0].message, /5 of 6 losses came in the asia session/);
  assert.equal(lesson.trades.length, 10);
  assert.equal(lesson.trades[2].session, 'asia');
  assert.equal(lesson.trades[2].result, 'loss');
  assert.ok(lesson.findings.some((f) => f.code === 'ASYMMETRIC_LOSSES'));
});

test('session proposal removes the clustered hours as one explained change', () => {
  const strategy = openStrategy();
  const lesson = diagnose(input(strategy), outcome(FIXTURE));
  const p = proposeNextConfig(strategy, lesson);
  assert.equal(p.change?.parameter, 'risk.sessions');
  assert.deepEqual(p.strategy.risk.sessions, [{ startHour: 7, endHour: 24 }]);
  assert.match(p.reasoning, /exclude asia hours/i);
  // Nothing else changed.
  assert.deepEqual({ ...p.strategy.risk, sessions: [] }, { ...strategy.risk, sessions: [] });
  assert.equal(gateViolation(strategy.risk, p.strategy.risk), null);
});

test('proposals never relax a risk gate', () => {
  const base = openStrategy().risk;
  assert.match(gateViolation(base, { ...base, fixedLot: base.fixedLot * 2 }) ?? '', /fixedLot/);
  assert.match(gateViolation(base, { ...base, maxDailyLossPercent: base.maxDailyLossPercent + 1 }) ?? '', /maxDailyLossPercent/);
  assert.match(gateViolation(base, { ...base, maxDailyLossPercent: 0 }) ?? '', /maxDailyLossPercent/);
  assert.match(gateViolation(base, { ...base, maxSpreadPoints: base.maxSpreadPoints + 5 }) ?? '', /maxSpreadPoints/);
  assert.match(gateViolation({ ...base, sessions: [{ startHour: 7, endHour: 13 }] }, { ...base, sessions: [] }) ?? '', /sessions/);

  // Generated proposals always pass the check, including size cuts for a drawdown breach.
  const strategy = openStrategy();
  const dd = diagnose(input(strategy, { maxDrawdownPct: 9 }), { ...outcome([]), equityCurve: outcome([]).equityCurve });
  const p = proposeNextConfig(strategy, dd);
  assert.equal(gateViolation(strategy.risk, p.strategy.risk), null);
  assert.ok(p.strategy.risk.fixedLot <= strategy.risk.fixedLot);
});

test('two consecutive spread-gate failures keep addressing the spread limit', () => {
  // Balanced trades, no cluster, no asymmetry: only the spread gate stands out.
  const flat: BacktestTrade[] = [
    bt(1, 0, 8, 20, 'tp'), bt(2, 1, 14, -20, 'sl'), bt(3, 2, 9, 20, 'tp'),
    bt(4, 3, 15, -20, 'sl'), bt(5, 4, 8, -20, 'sl'), bt(6, 4, 14, 20, 'tp'),
  ];
  const strategy = openStrategy();
  const l1 = diagnose(input(strategy), outcome(flat, { spread: 20 }));
  assert.equal(l1.rootCause, 'SPREAD_GATE');
  const p1 = proposeNextConfig(strategy, l1);
  assert.equal(p1.change?.parameter, 'risk.maxSpreadPoints');
  assert.equal(p1.change?.to, 20); // 25 * 0.8

  const l2 = diagnose(input(p1.strategy, { id: 'window-y' }), outcome(flat, { spread: 18 }));
  const p2 = proposeNextConfig(p1.strategy, l2, [l1]);
  assert.equal(p2.rootCause, 'SPREAD_GATE');
  assert.equal(p2.change?.parameter, 'risk.maxSpreadPoints');
  assert.equal(p2.change?.to, 16);
  assert.match(p2.reasoning, /Repeat cause/);
  assert.deepEqual({ ...p2.strategy.risk, maxSpreadPoints: 0 }, { ...strategy.risk, maxSpreadPoints: 0 });
});

test('an exhausted knob yields no change rather than drifting to another parameter', () => {
  const s = openStrategy();
  s.risk.maxSpreadPoints = 1;
  const flat = [bt(1, 0, 8, 20, 'tp'), bt(2, 1, 14, -20, 'sl')];
  const lesson = diagnose(input(s), outcome(flat, { spread: 30 }));
  const p = proposeNextConfig(s, lesson);
  assert.equal(p.change, null);
  assert.deepEqual(p.strategy, s);
  assert.match(p.reasoning, /manual review/);
});
