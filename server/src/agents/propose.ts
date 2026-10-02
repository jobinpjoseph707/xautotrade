/**
 * "Propose next config": one deliberate, explainable change per failed week,
 * chosen by the lesson's root cause. Never relaxes a risk gate.
 */
import { roundLot } from '../engine/risk.js';
import type { RiskConfig, Strategy } from '../engine/types.js';
import { SESSION_HOURS, type FindingCode, type Lesson, type SessionName } from './lessons.js';

export interface ConfigChange {
  parameter: string;
  from: unknown;
  to: unknown;
}

export interface Proposal {
  rootCause: FindingCode | null;
  strategy: Strategy;
  /** Null when no safe, cause-directed change exists; the config is returned unchanged. */
  change: ConfigChange | null;
  reasoning: string;
}

const SIZE_CUT = 0.75;
const STOP_TIGHTEN = 0.8;
const SPREAD_TIGHTEN = 0.8;

// --- gate-preservation helpers ------------------------------------------------

export function allowedHours(risk: RiskConfig): boolean[] {
  const hours = new Array<boolean>(24).fill(false);
  for (let h = 0; h < 24; h++) {
    hours[h] =
      !risk.sessions || risk.sessions.length === 0
        ? true
        : risk.sessions.some((s) => (s.startHour <= s.endHour ? h >= s.startHour && h < s.endHour : h >= s.startHour || h < s.endHour));
  }
  return hours;
}

function allowedDays(risk: RiskConfig): number[] {
  return risk.tradingDays && risk.tradingDays.length > 0 ? [...risk.tradingDays] : [0, 1, 2, 3, 4, 5, 6];
}

function hoursToSessions(hours: boolean[]): { startHour: number; endHour: number }[] {
  const out: { startHour: number; endHour: number }[] = [];
  let start = -1;
  for (let h = 0; h <= 24; h++) {
    const on = h < 24 && hours[h];
    if (on && start < 0) start = h;
    if (!on && start >= 0) {
      out.push({ startHour: start, endHour: h });
      start = -1;
    }
  }
  return out;
}

/** Limits where 0 means "off/unlimited": after may only be tighter, never looser. */
const tighterOrEqual = (before: number, after: number): boolean => {
  if (before <= 0) return true; // was unlimited: any limit is tighter
  return after > 0 && after <= before;
};

/** Returns the reason a change relaxes a gate, or null if it is safe. */
export function gateViolation(before: RiskConfig, after: RiskConfig): string | null {
  if (after.fixedLot > before.fixedLot) return 'raises fixedLot';
  if (after.riskPercent > before.riskPercent) return 'raises riskPercent';
  if (after.maxLot > before.maxLot) return 'raises maxLot';
  if (after.maxOpenPositions > before.maxOpenPositions) return 'raises maxOpenPositions';
  if (!tighterOrEqual(before.maxDailyLossPercent, after.maxDailyLossPercent)) return 'loosens maxDailyLossPercent';
  if (!tighterOrEqual(before.maxDailyTrades, after.maxDailyTrades)) return 'loosens maxDailyTrades';
  if (!tighterOrEqual(before.maxSpreadPoints, after.maxSpreadPoints)) return 'loosens maxSpreadPoints';
  if (after.cooldownBars < before.cooldownBars) return 'shortens cooldownBars';
  const b = allowedHours(before);
  const a = allowedHours(after);
  if (a.some((on, h) => on && !b[h])) return 'widens trading sessions';
  if (!a.some(Boolean)) return 'removes every trading hour';
  const bd = new Set(allowedDays(before));
  const ad = allowedDays(after);
  if (ad.some((d) => !bd.has(d))) return 'widens trading days';
  if (ad.length === 0) return 'removes every trading day';
  return null;
}

// --- per-cause proposals ------------------------------------------------------

type Attempt = { risk: RiskConfig; change: ConfigChange; reasoning: string } | { blocked: string };

function sizeCut(risk: RiskConfig, why: string): Attempt {
  if (risk.lotMode === 'percentRisk') {
    const to = Math.max(0.05, Number((risk.riskPercent * SIZE_CUT).toFixed(3)));
    if (to >= risk.riskPercent) return { blocked: 'riskPercent is already at its floor' };
    return { risk: { ...risk, riskPercent: to }, change: { parameter: 'risk.riskPercent', from: risk.riskPercent, to }, reasoning: `${why} Cutting risk per trade by 25%.` };
  }
  const to = roundLot(risk.fixedLot * SIZE_CUT, risk);
  if (to >= risk.fixedLot) return { blocked: 'fixedLot is already at the minimum lot' };
  return { risk: { ...risk, fixedLot: to }, change: { parameter: 'risk.fixedLot', from: risk.fixedLot, to }, reasoning: `${why} Cutting position size by 25%.` };
}

function attempt(lesson: Lesson, risk: RiskConfig): Attempt {
  const f = lesson.findings.find((x) => x.code === lesson.rootCause);
  const why = f?.message ?? '';
  switch (lesson.rootCause) {
    case 'SESSION_CLUSTER': {
      const name = String(f!.data.bucket) as SessionName;
      const [a, b] = SESSION_HOURS[name];
      const hours = allowedHours(risk);
      let changed = false;
      for (let h = a; h < b; h++) if (hours[h]) { hours[h] = false; changed = true; }
      if (!changed) return { blocked: `${name} hours are already excluded` };
      if (!hours.some(Boolean)) return { blocked: 'excluding that session would leave no trading hours' };
      const sessions = hoursToSessions(hours);
      return { risk: { ...risk, sessions }, change: { parameter: 'risk.sessions', from: risk.sessions, to: sessions }, reasoning: `${why} Tightening session gating to exclude ${name} hours (${a}:00-${b}:00 UTC).` };
    }
    case 'WEEKDAY_CLUSTER': {
      const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(f!.data.bucket));
      const days = allowedDays(risk);
      if (!days.includes(day)) return { blocked: 'that weekday is already excluded' };
      const to = days.filter((d) => d !== day);
      if (to.length === 0) return { blocked: 'excluding that day would leave no trading days' };
      return { risk: { ...risk, tradingDays: to }, change: { parameter: 'risk.tradingDays', from: risk.tradingDays, to }, reasoning: `${why} Removing ${f!.data.bucket} from trading days.` };
    }
    case 'SPREAD_GATE': {
      if (risk.maxSpreadPoints <= 0) return { blocked: 'no spread limit to tighten' };
      const to = Math.max(1, Math.floor(risk.maxSpreadPoints * SPREAD_TIGHTEN));
      if (to >= risk.maxSpreadPoints) return { blocked: 'maxSpreadPoints is already at its floor' };
      return { risk: { ...risk, maxSpreadPoints: to }, change: { parameter: 'risk.maxSpreadPoints', from: risk.maxSpreadPoints, to }, reasoning: `${why} Tightening the spread limit by 20% so only genuinely cheap bars are traded.` };
    }
    case 'DAILY_LOSS_GATE':
      return sizeCut(risk, why);
    case 'DRAWDOWN_BREACH':
      return sizeCut(risk, why);
    case 'ASYMMETRIC_LOSSES': {
      if (risk.slMode === 'points') {
        const to = Math.max(10, Math.round(risk.slPoints * STOP_TIGHTEN));
        if (to >= risk.slPoints) return { blocked: 'slPoints is already at its floor' };
        return { risk: { ...risk, slPoints: to }, change: { parameter: 'risk.slPoints', from: risk.slPoints, to }, reasoning: `${why} Tightening the stop by 20% to shrink the average loss.` };
      }
      if (risk.slMode === 'atr') {
        const to = Math.max(0.5, Number((risk.slAtrMult * STOP_TIGHTEN).toFixed(2)));
        if (to >= risk.slAtrMult) return { blocked: 'slAtrMult is already at its floor' };
        return { risk: { ...risk, slAtrMult: to }, change: { parameter: 'risk.slAtrMult', from: risk.slAtrMult, to }, reasoning: `${why} Tightening the ATR stop multiple by 20%.` };
      }
      return { blocked: 'no stop-loss is configured to tighten' };
    }
    default:
      return { blocked: 'no actionable root cause was identified' };
  }
}

/**
 * `history` is accepted so callers can pass prior lessons; the cause->parameter
 * mapping is fixed, so repeated failures for the same cause keep escalating the
 * SAME knob instead of drifting elsewhere. When that knob is exhausted the
 * result is "no change, needs review", never an unrelated tweak.
 */
export function proposeNextConfig(strategy: Strategy, lesson: Lesson, history: Lesson[] = []): Proposal {
  const same = history.filter((h) => h.rootCause === lesson.rootCause && lesson.rootCause != null).length;
  const unchanged = (reasoning: string): Proposal => ({
    rootCause: lesson.rootCause,
    strategy: structuredClone(strategy),
    change: null,
    reasoning,
  });

  const a = attempt(lesson, strategy.risk);
  if ('blocked' in a) {
    return unchanged(`No change: ${a.blocked}. Needs manual review${same ? ` (same cause seen in ${same} earlier week(s))` : ''}.`);
  }
  const violation = gateViolation(strategy.risk, a.risk);
  if (violation) return unchanged(`No change: the candidate change ${violation}, which is not allowed.`);

  const next = structuredClone(strategy);
  next.risk = a.risk;
  const prefix = same ? `Repeat cause (${same} earlier week(s)): ` : '';
  return { rootCause: lesson.rootCause, strategy: next, change: a.change, reasoning: prefix + a.reasoning };
}
