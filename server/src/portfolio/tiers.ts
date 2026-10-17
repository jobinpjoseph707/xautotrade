import { TIER_COUNT } from './config.js';

/** What a strategy has actually done, measured over its last 30 demo days. */
export interface TierMeasures {
  /** Average money at risk to the stop on each trade, % of equity. */
  riskPerTradePct: number;
  /** Worst peak-to-trough fall of equity, %. */
  maxDrawdownPct: number;
  /** Worst single day, % of equity lost. */
  worstDayPct: number;
}

/** Top of each tier (inclusive) for tiers 1 to 4; above the last bound is tier 5. */
export const TIER_LIMITS: Record<keyof TierMeasures, readonly number[]> = {
  riskPerTradePct: [0.25, 0.5, 1, 1.5],
  maxDrawdownPct: [3, 6, 10, 15],
  worstDayPct: [0.5, 1, 2, 3],
};

export function tierOfValue(value: number, bounds: readonly number[]): number {
  const i = bounds.findIndex((b) => value <= b);
  return i === -1 ? TIER_COUNT : i + 1;
}

export interface TierDecision {
  tier: number;
  byMeasure: Record<keyof TierMeasures, number>;
  /** The measure that set the tier (the worst of the three). */
  decidedBy: keyof TierMeasures;
}

/** The worst of the three measures decides. */
export function tierFromMeasures(m: TierMeasures): TierDecision {
  const byMeasure = {
    riskPerTradePct: tierOfValue(m.riskPerTradePct, TIER_LIMITS.riskPerTradePct),
    maxDrawdownPct: tierOfValue(m.maxDrawdownPct, TIER_LIMITS.maxDrawdownPct),
    worstDayPct: tierOfValue(m.worstDayPct, TIER_LIMITS.worstDayPct),
  };
  const keys = Object.keys(byMeasure) as (keyof TierMeasures)[];
  const decidedBy = keys.reduce((a, b) => (byMeasure[b] > byMeasure[a] ? b : a));
  return { tier: byMeasure[decidedBy], byMeasure, decidedBy };
}

/** Days in a row a strategy must measure safer before it is moved to a safer tier. */
export const SAFER_DAYS = 3;

export interface TierState {
  tier: number;
  /** Consecutive days measured safer than `tier`. */
  saferDays: number;
  /** The riskiest tier measured during that streak: where it will move to. */
  saferTo: number;
  /** UTC day number (days since 1970) of the last check. */
  lastDay: number;
}

export const utcDayNumber = (ms: number): number => Math.floor(ms / 86_400_000);

/**
 * One daily check. Riskier is immediate. Safer needs 3 days in a row, and then goes only as far as the
 * riskiest of those three days measured. A second check on the same day changes nothing.
 */
export function nextTierState(prev: TierState | null, measured: number, day: number): TierState {
  if (!prev) return { tier: measured, saferDays: 0, saferTo: measured, lastDay: day };
  if (measured > prev.tier) return { tier: measured, saferDays: 0, saferTo: measured, lastDay: day };
  if (measured === prev.tier) return { ...prev, saferDays: 0, saferTo: prev.tier, lastDay: day };
  if (day === prev.lastDay) return prev;
  const streak = prev.saferDays > 0 && day === prev.lastDay + 1;
  const saferDays = streak ? prev.saferDays + 1 : 1;
  const saferTo = streak ? Math.max(prev.saferTo, measured) : measured;
  if (saferDays >= SAFER_DAYS) return { tier: saferTo, saferDays: 0, saferTo, lastDay: day };
  return { tier: prev.tier, saferDays, saferTo, lastDay: day };
}
