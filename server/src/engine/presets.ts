/**
 * Starter strategies for M5 scalping. These are working examples of the rule
 * DSL, not trading advice — every one of them needs to be backtested and
 * forward-tested on a demo account before it goes anywhere near real money.
 */

import { DEFAULT_RISK, type Strategy } from './types.js';

function id(): string {
  return `str_${Math.random().toString(36).slice(2, 10)}`;
}

export function emaPullbackScalp(symbol = 'EURUSD'): Strategy {
  return {
    id: id(),
    name: 'M5 EMA Pullback Scalp',
    symbol,
    timeframe: '5m',
    indicators: [
      { id: 'ema_fast', type: 'ema', source: 'close', params: { period: 8 } },
      { id: 'ema_slow', type: 'ema', source: 'close', params: { period: 21 } },
      { id: 'ema_trend', type: 'ema', source: 'close', params: { period: 100 } },
      { id: 'rsi', type: 'rsi', source: 'close', params: { period: 14 } },
      { id: 'atr', type: 'atr', params: { period: 14 } },
    ],
    entryLong: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'crossesAbove', right: { kind: 'indicator', id: 'ema_slow' } },
        { left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'indicator', id: 'ema_trend' } },
        { left: { kind: 'indicator', id: 'rsi' }, op: 'gt', right: { kind: 'const', value: 50 } },
        { left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 72 } },
      ],
    },
    entryShort: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'crossesBelow', right: { kind: 'indicator', id: 'ema_slow' } },
        { left: { kind: 'price', field: 'close' }, op: 'lt', right: { kind: 'indicator', id: 'ema_trend' } },
        { left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 50 } },
        { left: { kind: 'indicator', id: 'rsi' }, op: 'gt', right: { kind: 'const', value: 28 } },
      ],
    },
    exitLong: { logic: 'OR', conditions: [{ left: { kind: 'indicator', id: 'rsi' }, op: 'gt', right: { kind: 'const', value: 78 } }] },
    exitShort: { logic: 'OR', conditions: [{ left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 22 } }] },
    risk: {
      ...DEFAULT_RISK,
      slMode: 'atr',
      slAtrMult: 1.4,
      tpMode: 'rr',
      tpRR: 1.5,
      atrIndicatorId: 'atr',
      lotMode: 'percentRisk',
      riskPercent: 0.5,
      trailingEnabled: true,
      trailingStartPoints: 60,
      trailingStepPoints: 30,
      breakEvenPoints: 40,
      maxSpreadPoints: 20,
      maxDailyTrades: 12,
      maxDailyLossPercent: 3,
      cooldownBars: 3,
      // No hard-coded session hours: they are chosen from measured results, not guessed here.
      sessions: [],
      tradingDays: [1, 2, 3, 4, 5],
    },
  };
}

export function bollingerFadeScalp(symbol = 'EURUSD'): Strategy {
  return {
    id: id(),
    name: 'M5 Bollinger Fade Scalp',
    symbol,
    timeframe: '5m',
    indicators: [
      { id: 'bb', type: 'bbands', source: 'close', params: { period: 20, mult: 2.2 } },
      { id: 'rsi', type: 'rsi', source: 'close', params: { period: 7 } },
      { id: 'adx', type: 'adx', params: { period: 14 } },
      { id: 'atr', type: 'atr', params: { period: 14 } },
    ],
    entryLong: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'price', field: 'close' }, op: 'lt', right: { kind: 'indicator', id: 'bb', line: 'lower' } },
        { left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 25 } },
        // Fade only in range conditions — a strong trend eats mean-reversion entries.
        { left: { kind: 'indicator', id: 'adx', line: 'adx' }, op: 'lt', right: { kind: 'const', value: 25 } },
      ],
    },
    entryShort: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'indicator', id: 'bb', line: 'upper' } },
        { left: { kind: 'indicator', id: 'rsi' }, op: 'gt', right: { kind: 'const', value: 75 } },
        { left: { kind: 'indicator', id: 'adx', line: 'adx' }, op: 'lt', right: { kind: 'const', value: 25 } },
      ],
    },
    exitLong: {
      logic: 'OR',
      conditions: [{ left: { kind: 'price', field: 'close' }, op: 'gte', right: { kind: 'indicator', id: 'bb', line: 'middle' } }],
    },
    exitShort: {
      logic: 'OR',
      conditions: [{ left: { kind: 'price', field: 'close' }, op: 'lte', right: { kind: 'indicator', id: 'bb', line: 'middle' } }],
    },
    risk: {
      ...DEFAULT_RISK,
      slMode: 'atr',
      slAtrMult: 1.8,
      tpMode: 'atr',
      tpAtrMult: 2.7, // 1.5 x the 1.8 ATR stop: the minimum reward:risk the app allows
      atrIndicatorId: 'atr',
      lotMode: 'percentRisk',
      riskPercent: 0.4,
      maxSpreadPoints: 18,
      maxDailyTrades: 10,
      cooldownBars: 4,
      closeOnOppositeSignal: false,
      sessions: [],
      tradingDays: [1, 2, 3, 4, 5],
    },
  };
}

export function macdMomentumScalp(symbol = 'XAUUSD'): Strategy {
  return {
    id: id(),
    name: 'M5 MACD Momentum Scalp',
    symbol,
    timeframe: '5m',
    indicators: [
      { id: 'macd', type: 'macd', source: 'close', params: { fast: 12, slow: 26, signal: 9 } },
      { id: 'ema200', type: 'ema', source: 'close', params: { period: 200 } },
      { id: 'adx', type: 'adx', params: { period: 14 } },
      { id: 'atr', type: 'atr', params: { period: 14 } },
    ],
    entryLong: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'macd', line: 'value' }, op: 'crossesAbove', right: { kind: 'indicator', id: 'macd', line: 'signal' } },
        { left: { kind: 'indicator', id: 'macd', line: 'value' }, op: 'lt', right: { kind: 'const', value: 0 } },
        { left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'indicator', id: 'ema200' } },
        { left: { kind: 'indicator', id: 'adx', line: 'adx' }, op: 'gt', right: { kind: 'const', value: 20 } },
      ],
    },
    entryShort: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'macd', line: 'value' }, op: 'crossesBelow', right: { kind: 'indicator', id: 'macd', line: 'signal' } },
        { left: { kind: 'indicator', id: 'macd', line: 'value' }, op: 'gt', right: { kind: 'const', value: 0 } },
        { left: { kind: 'price', field: 'close' }, op: 'lt', right: { kind: 'indicator', id: 'ema200' } },
        { left: { kind: 'indicator', id: 'adx', line: 'adx' }, op: 'gt', right: { kind: 'const', value: 20 } },
      ],
    },
    risk: {
      ...DEFAULT_RISK,
      slMode: 'atr',
      slAtrMult: 1.5,
      tpMode: 'rr',
      tpRR: 2,
      atrIndicatorId: 'atr',
      lotMode: 'percentRisk',
      riskPercent: 0.5,
      trailingEnabled: true,
      trailingStartPoints: 100,
      trailingStepPoints: 50,
      maxSpreadPoints: 40,
      maxDailyTrades: 8,
      cooldownBars: 6,
      sessions: [],
      tradingDays: [1, 2, 3, 4, 5],
    },
  };
}

/**
 * NOT a trading strategy — a plumbing test.
 *
 * Goes long on any green M1 bar and short on any red one, so it fires on nearly
 * every bar and proves the whole order path (place → appear in MT5 → manage →
 * close) within a couple of minutes. It is a coin flip, so after spread it
 * loses money by construction. Minimum lot size, tight stops, and a hard
 * 20-trade daily cap keep the cost of finding that out trivial.
 */
export function orderPathTest(symbol = 'XAUUSD'): Strategy {
  return {
    id: id(),
    name: 'ORDER TEST — not a strategy',
    isTest: true,
    symbol,
    timeframe: '1m',
    // No indicators: bar direction alone decides, so there is no warm-up wait.
    indicators: [],
    entryLong: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'price', field: 'open' } },
      ],
    },
    entryShort: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'price', field: 'close' }, op: 'lt', right: { kind: 'price', field: 'open' } },
      ],
    },
    risk: {
      ...DEFAULT_RISK,
      lotMode: 'fixed',
      fixedLot: 0.01,
      slMode: 'points',
      slPoints: 200,
      tpMode: 'points',
      tpPoints: 200,
      trailingEnabled: false,
      breakEvenPoints: 0,
      // Deliberately permissive so no filter can mask an order-path failure.
      maxSpreadPoints: 200,
      maxOpenPositions: 1,
      cooldownBars: 0,
      sessions: [],
      tradingDays: [],
      // The two limits that stop a coin flip running away unattended.
      maxDailyTrades: 20,
      maxDailyLossPercent: 5,
      closeOnOppositeSignal: true,
    },
  };
}

/**
 * High-frequency M1 scalp for exercising the whole live path on demo.
 *
 * State-based rather than cross-based, so it re-enters within a bar or two of
 * each exit instead of waiting for a fresh crossover: long while EMA3 > EMA8
 * and price is above EMA3, short on the mirror image. Tight ATR stops close
 * trades within a few minutes, giving roughly one trade every 1-3 minutes.
 * It has no proven edge: spread and slippage will erode it. Demo only.
 */
export function fastScalpTest(symbol = 'BTCUSD'): Strategy {
  return {
    id: id(),
    name: 'M1 Fast Scalp (test)',
    isTest: true,
    symbol,
    timeframe: '1m',
    indicators: [
      { id: 'ema_fast', type: 'ema', source: 'close', params: { period: 3 } },
      { id: 'ema_slow', type: 'ema', source: 'close', params: { period: 8 } },
      { id: 'atr', type: 'atr', params: { period: 10 } },
    ],
    entryLong: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'gt', right: { kind: 'indicator', id: 'ema_slow' } },
        { left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'indicator', id: 'ema_fast' } },
      ],
    },
    entryShort: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'lt', right: { kind: 'indicator', id: 'ema_slow' } },
        { left: { kind: 'price', field: 'close' }, op: 'lt', right: { kind: 'indicator', id: 'ema_fast' } },
      ],
    },
    risk: {
      ...DEFAULT_RISK,
      lotMode: 'fixed',
      fixedLot: 0.01,
      slMode: 'atr',
      slAtrMult: 0.8,
      tpMode: 'atr',
      tpAtrMult: 0.5,
      atrIndicatorId: 'atr',
      trailingEnabled: false,
      breakEvenPoints: 0,
      // Off so a wide-spread symbol (crypto) is never silently blocked; minimum lot keeps cost small.
      maxSpreadPoints: 0,
      maxOpenPositions: 1,
      cooldownBars: 1,
      sessions: [],
      tradingDays: [],
      maxDailyTrades: 300,
      maxDailyLossPercent: 3,
      closeOnOppositeSignal: true,
    },
  };
}

/**
 * Fast M1 gold scalp built to watch a strategy trade live, right now.
 *
 * EMA5/EMA13 with a price-confirmation filter re-enters within a bar or two
 * of each exit, so on an open session you should see fills within the first
 * 10-15 minutes rather than waiting on a slower crossover system. Tuned
 * specifically for XAUUSD: the account-wide 25-point spread gate is too
 * tight for gold, which routinely sits at 20-35 points off-session on this
 * demo feed (see runbook), so this strategy raises its own gate to 50 points
 * instead of silently blocking every entry. No proven edge — this is for
 * observing the live path end-to-end (fills, SL/TP, logs, the mobile app's
 * live view), not for making money. Demo only.
 */
export function goldQuickScalpTest(symbol = 'XAUUSD'): Strategy {
  return {
    id: id(),
    name: 'M1 Gold Quick Scalp (test)',
    isTest: true,
    symbol,
    timeframe: '1m',
    indicators: [
      { id: 'ema_fast', type: 'ema', source: 'close', params: { period: 5 } },
      { id: 'ema_slow', type: 'ema', source: 'close', params: { period: 13 } },
      { id: 'atr', type: 'atr', params: { period: 10 } },
    ],
    entryLong: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'gt', right: { kind: 'indicator', id: 'ema_slow' } },
        { left: { kind: 'price', field: 'close' }, op: 'gt', right: { kind: 'indicator', id: 'ema_fast' } },
      ],
    },
    entryShort: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'lt', right: { kind: 'indicator', id: 'ema_slow' } },
        { left: { kind: 'price', field: 'close' }, op: 'lt', right: { kind: 'indicator', id: 'ema_fast' } },
      ],
    },
    risk: {
      ...DEFAULT_RISK,
      lotMode: 'fixed',
      fixedLot: 0.01,
      slMode: 'atr',
      slAtrMult: 1.0,
      tpMode: 'atr',
      tpAtrMult: 0.8,
      atrIndicatorId: 'atr',
      trailingEnabled: false,
      breakEvenPoints: 0,
      // Account default is 25pt; XAUUSD alone routinely needs more off-session.
      maxSpreadPoints: 50,
      maxOpenPositions: 1,
      cooldownBars: 1,
      sessions: [],
      tradingDays: [],
      maxDailyTrades: 100,
      maxDailyLossPercent: 3,
      closeOnOppositeSignal: true,
    },
  };
}

/**
 * Presets carry spread caps tuned for EURUSD-like symbols (18-40 points). On a
 * wider-spread symbol such as XAUUSD (~30-35 points) a 20-point cap blocks
 * every single entry, so the strategy silently never trades. Scale the cap to
 * the symbol's typical spread (2.5x), never lowering it and leaving 0 (= off)
 * alone.
 */
export function fitSpreadCap(strategy: Strategy, typicalSpreadPoints: number): Strategy {
  const cap = strategy.risk.maxSpreadPoints;
  if (cap > 0 && Number.isFinite(typicalSpreadPoints) && typicalSpreadPoints > 0) {
    strategy.risk.maxSpreadPoints = Math.max(cap, Math.ceil(typicalSpreadPoints * 2.5));
  }
  return strategy;
}

export const PRESETS: {
  key: string;
  label: string;
  description: string;
  /** Shown prominently in the app when a preset is not meant for real use. */
  warning?: string;
  build: (symbol?: string) => Strategy;
}[] = [
  {
    key: 'ema-pullback',
    label: 'M5 EMA Pullback Scalp',
    description: 'Trend-following. 8/21 EMA cross in the direction of the 100 EMA, RSI confirming momentum without being overbought.',
    build: emaPullbackScalp,
  },
  {
    key: 'bollinger-fade',
    label: 'M5 Bollinger Fade Scalp',
    description: 'Mean reversion. Fades closes outside the 2.2σ band when RSI(7) is stretched and ADX says the market is ranging.',
    build: bollingerFadeScalp,
  },
  {
    key: 'macd-momentum',
    label: 'M5 MACD Momentum Scalp',
    description: 'Momentum. MACD signal cross below/above zero, aligned with the 200 EMA, filtered by ADX > 20.',
    build: macdMomentumScalp,
  },
  {
    key: 'order-test',
    label: 'ORDER TEST — not a strategy',
    description:
      'Buys any green 1-minute bar, sells any red one, so it trades almost every minute. Use it to prove orders reach your broker, then stop and delete it. Minimum lot, 200-point stop, capped at 20 trades a day.',
    warning:
      'This is a test rig, not a trading strategy. It is a coin flip and loses money to spread by design. Run it on demo only, watch it place a few trades, then stop it.',
    build: orderPathTest,
  },
  {
    key: 'fast-scalp-test',
    label: 'M1 Fast Scalp (test) — trades every 1-3 min',
    description:
      'High-frequency 1-minute scalp: long while EMA3 > EMA8 and price is above EMA3, short on the mirror. ATR stops (0.8x stop, 0.5x target) close trades within minutes and it re-enters straight away. Minimum lot, 300 trades/day cap, 3% daily loss cap. Pick a symbol that is trading right now (crypto like BTCUSD is open 24/7).',
    warning:
      'Test rig with no proven edge. Spread and slippage will erode it. Demo only. Watch a few trades, then stop it.',
    build: fastScalpTest,
  },
  {
    key: 'gold-quick-test',
    label: 'M1 Gold Quick Scalp (test) — for watching it trade live',
    description:
      "EMA5/EMA13 cross with a price-confirmation filter on XAUUSD M1, re-entering within a bar or two of each exit so you see fills fast. Spread gate raised to 50pt to match XAUUSD's real off-session spread instead of the 25pt account default. Built to prove the live path (fills, SL/TP, logs) quickly, not to make money.",
    warning:
      'Test rig with no proven edge. Demo only. Watch it place and manage a few trades, then stop it.',
    build: goldQuickScalpTest,
  },
];

export function blankStrategy(symbol = 'EURUSD'): Strategy {
  return {
    id: id(),
    name: 'New Strategy',
    symbol,
    timeframe: '5m',
    indicators: [
      { id: 'ema_fast', type: 'ema', source: 'close', params: { period: 9 } },
      { id: 'ema_slow', type: 'ema', source: 'close', params: { period: 21 } },
      { id: 'atr', type: 'atr', params: { period: 14 } },
    ],
    entryLong: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'crossesAbove', right: { kind: 'indicator', id: 'ema_slow' } },
      ],
    },
    entryShort: {
      logic: 'AND',
      conditions: [
        { left: { kind: 'indicator', id: 'ema_fast' }, op: 'crossesBelow', right: { kind: 'indicator', id: 'ema_slow' } },
      ],
    },
    risk: { ...DEFAULT_RISK, atrIndicatorId: 'atr' },
  };
}
