/**
 * Bar-by-bar backtester.
 *
 * Execution model, chosen to avoid look-ahead bias:
 *   1. At each bar, a signal queued on the PREVIOUS bar's close fills at this
 *      bar's open (plus spread and slippage).
 *   2. The open position is then managed against this bar's high/low.
 *   3. Only after that do we evaluate rules on this bar's close and queue a
 *      signal for the next bar.
 *
 * Prices in the candle series are treated as BID. Buys fill at ask
 * (bid + spread), sells fill at bid, and every fill is pushed one slippage
 * increment against us. When a bar contains both the stop and the target we
 * assume the stop hit first, because we cannot see the intra-bar path.
 */

import { computeIndicators, warmupBars } from './indicators.js';
import { evaluateGroup, type EvalContext } from './rules.js';
import {
  computeLots,
  isTradingTime,
  positionProfit,
  slTpPrices,
  stopDistancePoints,
  targetDistancePoints,
  trailStop,
} from './risk.js';
import type {
  BacktestMetrics,
  BacktestResult,
  BacktestTrade,
  Candle,
  EquityPoint,
  Side,
  Strategy,
  SymbolSpec,
} from './types.js';

export interface BacktestOptions {
  initialBalance: number;
  spec: SymbolSpec;
  /** Cap on equity-curve points returned, to keep API payloads small. */
  maxEquityPoints?: number;
  /**
   * Force every bar to use this spread, ignoring the per-bar spread the broker
   * recorded. This is the stress-test knob: broker demo feeds quote far tighter
   * spreads than a real retail account gets, so a strategy that only survives
   * at the recorded spread has no edge. Null/undefined = use recorded spreads.
   */
  spreadOverridePoints?: number | null;
}

interface OpenPosition {
  side: Side;
  lots: number;
  entryPrice: number;
  entryTime: number;
  entryBar: number;
  sl: number | null;
  tp: number | null;
  mfePoints: number;
  maePoints: number;
}

export function runBacktest(
  strategy: Strategy,
  candles: Candle[],
  options: BacktestOptions,
): BacktestResult {
  const warnings: string[] = [];
  const spec = options.spec;
  const risk = strategy.risk;
  const point = spec.point;

  if (candles.length < 50) {
    warnings.push('Fewer than 50 candles supplied — results are not meaningful.');
  }

  const indicators = computeIndicators(candles, strategy.indicators);
  const warmup = Math.min(warmupBars(strategy.indicators) + 2, Math.max(candles.length - 1, 0));

  const atrSeries = risk.atrIndicatorId ? indicators[risk.atrIndicatorId]?.value : undefined;
  if ((risk.slMode === 'atr' || risk.tpMode === 'atr') && !atrSeries) {
    warnings.push('ATR-based stops requested but no ATR indicator is linked — falling back to fixed points.');
  }

  const ctx: EvalContext = { candles, indicators, spreadPoints: spec.spreadPoints };

  let balance = options.initialBalance;
  let equity = balance;
  let peakEquity = balance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const returns: number[] = [];

  let position: OpenPosition | null = null;
  let pending: { side: Side } | null = null;
  let lastEntryBar = -Infinity;
  let tradeId = 0;
  const gateBlocks: Record<string, number> = {};

  let dayKey = '';
  let dayStartBalance = balance;
  let dayTrades = 0;
  let dayBlocked = false;

  const closePosition = (
    pos: OpenPosition,
    exitPrice: number,
    time: number,
    bar: number,
    reason: BacktestTrade['reason'],
  ) => {
    const gross = positionProfit(pos.side, pos.lots, pos.entryPrice, exitPrice, spec);
    const commission = spec.commissionPerLot * pos.lots;
    const net = gross - commission;
    balance += net;
    tradeId += 1;
    trades.push({
      id: tradeId,
      side: pos.side,
      lots: pos.lots,
      openTime: pos.entryTime,
      openPrice: Number(pos.entryPrice.toFixed(spec.digits)),
      closeTime: time,
      closePrice: Number(exitPrice.toFixed(spec.digits)),
      sl: pos.sl,
      tp: pos.tp,
      reason,
      grossProfit: round2(gross),
      commission: round2(commission),
      netProfit: round2(net),
      balanceAfter: round2(balance),
      maxFavourablePoints: Math.round(pos.mfePoints),
      maxAdversePoints: Math.round(pos.maePoints),
      barsHeld: bar - pos.entryBar,
    });
    returns.push(net / Math.max(options.initialBalance, 1));
  };

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];
    // An explicit override wins over the broker's recorded per-bar spread —
    // otherwise the stress-test control would silently do nothing on feeds
    // that report spread per candle (MetaTrader does).
    const barSpread =
      options.spreadOverridePoints != null && options.spreadOverridePoints > 0
        ? options.spreadOverridePoints
        : bar.spread && bar.spread > 0
          ? bar.spread
          : spec.spreadPoints;
    ctx.spreadPoints = barSpread;

    // --- Daily reset -------------------------------------------------------
    const d = new Date(bar.time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (key !== dayKey) {
      dayKey = key;
      dayStartBalance = balance;
      dayTrades = 0;
      dayBlocked = false;
    }

    // --- 1. Fill any signal queued on the previous close -------------------
    if (pending && !position) {
      const side = pending.side;
      const slipPts = spec.slippagePoints;
      const entryPrice =
        side === 'long'
          ? bar.open + (barSpread + slipPts) * point
          : bar.open - slipPts * point;

      const atrVal = atrSeries ? (atrSeries[i - 1] as number | null) : null;
      const slPts = stopDistancePoints(risk, atrVal, spec);
      const tpPts = targetDistancePoints(risk, atrVal, slPts, spec);
      const lots = computeLots(risk, balance, slPts, spec);
      const { sl, tp } = slTpPrices(side, entryPrice, slPts, tpPts, spec);

      if (lots > 0) {
        position = {
          side,
          lots,
          entryPrice,
          entryTime: bar.time,
          entryBar: i,
          sl,
          tp,
          mfePoints: 0,
          maePoints: 0,
        };
        lastEntryBar = i;
        dayTrades += 1;
      }
    }
    pending = null;

    // --- 2. Manage the open position against this bar ----------------------
    if (position) {
      const pos = position;
      // Track excursions in points using the price the position is valued at.
      const favourable =
        pos.side === 'long' ? (bar.high - pos.entryPrice) / point : (pos.entryPrice - bar.low) / point;
      const adverse =
        pos.side === 'long' ? (pos.entryPrice - bar.low) / point : (bar.high - pos.entryPrice) / point;
      if (favourable > pos.mfePoints) pos.mfePoints = favourable;
      if (adverse > pos.maePoints) pos.maePoints = adverse;

      // Exit prices are quoted on the side we close at.
      const closeLow = pos.side === 'long' ? bar.low : bar.low + barSpread * point;
      const closeHigh = pos.side === 'long' ? bar.high : bar.high + barSpread * point;

      let exited = false;
      if (pos.sl != null) {
        const hit = pos.side === 'long' ? closeLow <= pos.sl : closeHigh >= pos.sl;
        if (hit) {
          const px =
            pos.side === 'long'
              ? pos.sl - spec.slippagePoints * point
              : pos.sl + spec.slippagePoints * point;
          closePosition(pos, px, bar.time, i, 'sl');
          position = null;
          exited = true;
        }
      }
      if (!exited && pos.tp != null) {
        const hit = pos.side === 'long' ? closeHigh >= pos.tp : closeLow <= pos.tp;
        if (hit) {
          closePosition(pos, pos.tp, bar.time, i, 'tp');
          position = null;
          exited = true;
        }
      }

      // Trailing / break-even, applied on the close of the bar it survived.
      if (!exited && position) {
        const mark = position.side === 'long' ? bar.close : bar.close + barSpread * point;
        const newSl = trailStop(position.side, position.entryPrice, mark, position.sl, risk, spec);
        if (newSl != null) position.sl = newSl;
      }
    }

    // --- 3. Evaluate rules on this bar's close -----------------------------
    const longEntry = evaluateGroup(strategy.entryLong, i, ctx);
    const shortEntry = evaluateGroup(strategy.entryShort, i, ctx);

    if (position) {
      const exitRule = position.side === 'long' ? strategy.exitLong : strategy.exitShort;
      const ruleExit = evaluateGroup(exitRule, i, ctx);
      const oppositeExit =
        risk.closeOnOppositeSignal &&
        ((position.side === 'long' && shortEntry) || (position.side === 'short' && longEntry));

      if (ruleExit || oppositeExit) {
        const px =
          position.side === 'long'
            ? bar.close - spec.slippagePoints * point
            : bar.close + (barSpread + spec.slippagePoints) * point;
        closePosition(position, px, bar.time, i, ruleExit ? 'signal' : 'opposite');
        position = null;
      }
    }

    // --- 4. Risk gates, then queue the next entry --------------------------
    const dailyLossPct = ((dayStartBalance - balance) / Math.max(dayStartBalance, 1)) * 100;
    if (risk.maxDailyLossPercent > 0 && dailyLossPct >= risk.maxDailyLossPercent) dayBlocked = true;

    const canOpen =
      !position &&
      !dayBlocked &&
      dayTrades < (risk.maxDailyTrades > 0 ? risk.maxDailyTrades : Infinity) &&
      i - lastEntryBar >= risk.cooldownBars &&
      barSpread <= (risk.maxSpreadPoints > 0 ? risk.maxSpreadPoints : Infinity) &&
      isTradingTime(risk, bar.time) &&
      i < candles.length - 1;

    // Count which gate suppressed a live signal, so a failed week can say
    // which risk gate (if any) was doing the blocking.
    if ((longEntry || shortEntry) && !position && i < candles.length - 1) {
      const bump = (k: string) => {
        gateBlocks[k] = (gateBlocks[k] ?? 0) + 1;
      };
      if (dayBlocked) bump('dailyLoss');
      if (dayTrades >= (risk.maxDailyTrades > 0 ? risk.maxDailyTrades : Infinity)) bump('dailyTrades');
      if (i - lastEntryBar < risk.cooldownBars) bump('cooldown');
      if (barSpread > (risk.maxSpreadPoints > 0 ? risk.maxSpreadPoints : Infinity)) bump('spread');
      if (!isTradingTime(risk, bar.time)) bump('session');
    }

    if (canOpen) {
      if (longEntry && !shortEntry) pending = { side: 'long' };
      else if (shortEntry && !longEntry) pending = { side: 'short' };
      // Both firing at once is contradictory — take neither.
    }

    // --- 5. Mark to market -------------------------------------------------
    equity = balance;
    if (position) {
      const mark = position.side === 'long' ? bar.close : bar.close + barSpread * point;
      equity += positionProfit(position.side, position.lots, position.entryPrice, mark, spec);
    }
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    equityCurve.push({
      time: bar.time,
      equity: round2(equity),
      balance: round2(balance),
      drawdownPct: round2(ddPct),
    });
  }

  // Close anything still open at the final bar.
  if (position && candles.length > 0) {
    const last = candles[candles.length - 1];
    const px = position.side === 'long' ? last.close : last.close + spec.spreadPoints * point;
    closePosition(position, px, last.time, candles.length - 1, 'end');
    position = null;
  }

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    symbol: strategy.symbol,
    timeframe: strategy.timeframe,
    metrics: computeMetrics(trades, options.initialBalance, balance, maxDrawdown, maxDrawdownPct, returns, candles, warmup),
    trades,
    equity: downsample(equityCurve, options.maxEquityPoints ?? 400),
    warnings,
    gateBlocks,
  };
}

function computeMetrics(
  trades: BacktestTrade[],
  initialBalance: number,
  finalBalance: number,
  maxDrawdown: number,
  maxDrawdownPct: number,
  returns: number[],
  candles: Candle[],
  warmup: number,
): BacktestMetrics {
  const wins = trades.filter((t) => t.netProfit > 0);
  const losses = trades.filter((t) => t.netProfit <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.netProfit, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netProfit, 0));

  let consec = 0;
  let maxConsec = 0;
  for (const t of trades) {
    if (t.netProfit <= 0) {
      consec += 1;
      if (consec > maxConsec) maxConsec = consec;
    } else consec = 0;
  }

  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length
    : 0;
  const sd = Math.sqrt(variance);
  // Per-trade Sharpe, annualised on the assumption of ~250 trading days.
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(Math.min(returns.length, 250)) : 0;

  const net = finalBalance - initialBalance;

  return {
    initialBalance: round2(initialBalance),
    finalBalance: round2(finalBalance),
    netProfit: round2(net),
    netProfitPct: round2((net / Math.max(initialBalance, 1)) * 100),
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? round2((wins.length / trades.length) * 100) : 0,
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? 999 : 0,
    expectancy: trades.length ? round2(net / trades.length) : 0,
    avgWin: wins.length ? round2(grossProfit / wins.length) : 0,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : 0,
    largestWin: wins.length ? round2(Math.max(...wins.map((t) => t.netProfit))) : 0,
    largestLoss: losses.length ? round2(Math.min(...losses.map((t) => t.netProfit))) : 0,
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPct: round2(maxDrawdownPct),
    maxConsecutiveLosses: maxConsec,
    sharpe: round2(sharpe),
    totalCommission: round2(trades.reduce((a, t) => a + t.commission, 0)),
    longTrades: trades.filter((t) => t.side === 'long').length,
    shortTrades: trades.filter((t) => t.side === 'short').length,
    avgBarsHeld: trades.length ? round2(trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length) : 0,
    barsProcessed: Math.max(candles.length - warmup, 0),
    from: candles.length ? candles[0].time : 0,
    to: candles.length ? candles[candles.length - 1].time : 0,
  };
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
