/**
 * Money management and risk gating.
 *
 * Deliberately shared by the backtester and the live trader: if position sizing
 * or stop placement diverged between the two, backtest results would be
 * meaningless. Everything here is pure — no I/O, no clock reads.
 */

import type { RiskConfig, Side, SymbolSpec } from './types.js';

export function roundLot(lots: number, spec: { lotStep: number; minLot: number; maxLot: number }): number {
  const step = spec.lotStep > 0 ? spec.lotStep : 0.01;
  let v = Math.floor(lots / step) * step;
  // Guard against binary float dust like 0.30000000000000004.
  v = Math.round(v * 1e8) / 1e8;
  if (v < spec.minLot) v = spec.minLot;
  if (v > spec.maxLot) v = spec.maxLot;
  return Math.round(v * 100) / 100;
}

/**
 * Position size. In percentRisk mode we solve for the lot size whose loss at
 * the stop equals `riskPercent` of balance; without a stop we fall back to the
 * fixed lot, because "risk 1%" is undefined with unbounded downside.
 */
export function computeLots(
  risk: RiskConfig,
  balance: number,
  slPoints: number | null,
  spec: SymbolSpec,
): number {
  const bounds = { lotStep: risk.lotStep, minLot: risk.minLot, maxLot: risk.maxLot };
  if (risk.lotMode === 'fixed' || !slPoints || slPoints <= 0) {
    return roundLot(risk.fixedLot, bounds);
  }
  const riskAmount = (balance * risk.riskPercent) / 100;
  const lossPerLot = slPoints * spec.pointValuePerLot + spec.commissionPerLot;
  if (lossPerLot <= 0) return roundLot(risk.fixedLot, bounds);
  return roundLot(riskAmount / lossPerLot, bounds);
}

/** Stop distance in points for a prospective entry, or null when SL is off. */
export function stopDistancePoints(risk: RiskConfig, atrValue: number | null, spec: SymbolSpec): number | null {
  if (risk.slMode === 'none') return null;
  if (risk.slMode === 'atr') {
    if (atrValue == null || atrValue <= 0) return null;
    return (atrValue * risk.slAtrMult) / spec.point;
  }
  return risk.slPoints > 0 ? risk.slPoints : null;
}

/** Take-profit distance in points, or null when TP is off. */
export function targetDistancePoints(
  risk: RiskConfig,
  atrValue: number | null,
  slPoints: number | null,
  spec: SymbolSpec,
): number | null {
  if (risk.tpMode === 'none') return null;
  if (risk.tpMode === 'atr') {
    if (atrValue == null || atrValue <= 0) return null;
    return (atrValue * risk.tpAtrMult) / spec.point;
  }
  if (risk.tpMode === 'rr') {
    if (!slPoints || slPoints <= 0) return null;
    return slPoints * risk.tpRR;
  }
  return risk.tpPoints > 0 ? risk.tpPoints : null;
}

export function slTpPrices(
  side: Side,
  entryPrice: number,
  slPoints: number | null,
  tpPoints: number | null,
  spec: SymbolSpec,
): { sl: number | null; tp: number | null } {
  const round = (v: number) => Number(v.toFixed(spec.digits));
  if (side === 'long') {
    return {
      sl: slPoints ? round(entryPrice - slPoints * spec.point) : null,
      tp: tpPoints ? round(entryPrice + tpPoints * spec.point) : null,
    };
  }
  return {
    sl: slPoints ? round(entryPrice + slPoints * spec.point) : null,
    tp: tpPoints ? round(entryPrice - tpPoints * spec.point) : null,
  };
}

/** Is `timeMs` inside an allowed trading session and weekday? */
export function isTradingTime(risk: RiskConfig, timeMs: number): boolean {
  const d = new Date(timeMs);
  if (risk.tradingDays && risk.tradingDays.length > 0) {
    if (!risk.tradingDays.includes(d.getUTCDay())) return false;
  }
  if (!risk.sessions || risk.sessions.length === 0) return true;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  return risk.sessions.some((s) => {
    if (s.startHour <= s.endHour) return hour >= s.startHour && hour < s.endHour;
    // Session wrapping past midnight, e.g. 22:00 -> 06:00.
    return hour >= s.startHour || hour < s.endHour;
  });
}

/** Profit in account currency for a closed or open position. */
export function positionProfit(
  side: Side,
  lots: number,
  entryPrice: number,
  exitPrice: number,
  spec: SymbolSpec,
): number {
  const diff = side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return (diff / spec.point) * spec.pointValuePerLot * lots;
}

/**
 * New stop for a trailing/break-even position, or null to leave it alone.
 * Only ever tightens — a trailing stop that could loosen is a bug, not a feature.
 */
export function trailStop(
  side: Side,
  entryPrice: number,
  currentPrice: number,
  currentSl: number | null,
  risk: RiskConfig,
  spec: SymbolSpec,
): number | null {
  const round = (v: number) => Number(v.toFixed(spec.digits));
  const profitPoints =
    side === 'long'
      ? (currentPrice - entryPrice) / spec.point
      : (entryPrice - currentPrice) / spec.point;

  let candidate: number | null = null;

  if (risk.breakEvenPoints > 0 && profitPoints >= risk.breakEvenPoints) {
    candidate = round(entryPrice);
  }

  if (risk.trailingEnabled && profitPoints >= risk.trailingStartPoints) {
    const dist = risk.trailingStepPoints > 0 ? risk.trailingStepPoints : risk.trailingStartPoints;
    const trailed =
      side === 'long'
        ? round(currentPrice - dist * spec.point)
        : round(currentPrice + dist * spec.point);
    if (candidate == null) candidate = trailed;
    else candidate = side === 'long' ? Math.max(candidate, trailed) : Math.min(candidate, trailed);
  }

  if (candidate == null) return null;
  if (currentSl != null) {
    const tighter = side === 'long' ? candidate > currentSl : candidate < currentSl;
    if (!tighter) return null;
  }
  return candidate;
}
