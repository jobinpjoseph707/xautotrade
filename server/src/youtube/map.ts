/**
 * Map an extracted description onto the engine's Strategy schema, reusing the
 * existing indicators. Anything unmappable is a gap, never a silent guess.
 */
import { validateStrategy } from '../engine/rules.js';
import {
  DEFAULT_RISK,
  type Condition,
  type IndicatorSpec,
  type RuleGroup,
  type Strategy,
  type SymbolSpec,
  type Timeframe,
} from '../engine/types.js';
import type { Distance, ExtractedCondition, ExtractedStrategy, Gap } from './extract.js';

/** Indicator types the engine implements (see engine/indicators.ts computeIndicators). */
export const SUPPORTED_INDICATORS = ['sma', 'ema', 'wma', 'rsi', 'atr', 'macd', 'bbands', 'stoch', 'adx', 'cci'] as const;

export class UnsupportedIndicatorError extends Error {
  constructor(readonly indicator: string) {
    super(`Indicator "${indicator}" is not implemented in the engine; cannot map it.`);
    this.name = 'UnsupportedIndicatorError';
  }
}

export interface MapContext {
  symbol: string;
  spec: SymbolSpec;
  /** Used only to convert a percent stop/target into points. */
  referencePrice: number;
  /** Resolves NO_TIMEFRAME / MULTIPLE_TIMEFRAMES. */
  timeframe?: Timeframe;
  name?: string;
}

export interface MapResult {
  status: 'candidate' | 'needs_review';
  strategy: Strategy | null;
  gaps: Gap[];
  /** Non-blocking explanations of every conversion/default that was applied. */
  notes: string[];
}

export function mapToStrategy(x: ExtractedStrategy, ctx: MapContext): MapResult {
  const gaps: Gap[] = [...x.gaps];
  const notes: string[] = [];
  const indicators = new Map<string, IndicatorSpec>();

  const addInd = (id: string, type: string, params: Record<string, number>): string => {
    if (!(SUPPORTED_INDICATORS as readonly string[]).includes(type)) throw new UnsupportedIndicatorError(type);
    if (!indicators.has(id)) indicators.set(id, { id, type: type as IndicatorSpec['type'], source: 'close', params });
    return id;
  };

  const toConditions = (c: ExtractedCondition): Condition[] => {
    switch (c.kind) {
      case 'unsupported':
        throw new UnsupportedIndicatorError(c.name);
      case 'rsi': {
        let period = c.period;
        if (period == null) {
          period = 14;
          gaps.push({ severity: 'assumed', code: 'RSI_PERIOD', message: 'RSI period not stated; using 14.', evidence: c.evidence });
        }
        const id = addInd(`rsi_${period}`, 'rsi', { period });
        return [{ left: { kind: 'indicator', id }, op: c.cmp, right: { kind: 'const', value: c.value } }];
      }
      case 'priceVsMa': {
        const id = addInd(`${c.ma}_${c.period}`, c.ma, { period: c.period });
        return [{ left: { kind: 'price', field: 'close' }, op: c.cmp, right: { kind: 'indicator', id } }];
      }
      case 'maCross': {
        const f = addInd(`${c.ma}_${c.fast}`, c.ma, { period: c.fast });
        const s = addInd(`${c.ma}_${c.slow}`, c.ma, { period: c.slow });
        return [{ left: { kind: 'indicator', id: f }, op: c.cmp, right: { kind: 'indicator', id: s } }];
      }
      case 'macdCross': {
        const p = c.params ?? { fast: 12, slow: 26, signal: 9 };
        if (!c.params) gaps.push({ severity: 'assumed', code: 'MACD_PARAMS', message: 'MACD settings not stated; using 12/26/9.', evidence: c.evidence });
        const id = addInd('macd', 'macd', p);
        return [{ left: { kind: 'indicator', id, line: 'value' }, op: c.cmp, right: { kind: 'indicator', id, line: 'signal' } }];
      }
      case 'bbandsBreak': {
        const period = c.period ?? 20;
        const mult = c.mult ?? 2;
        if (c.period == null) gaps.push({ severity: 'assumed', code: 'BBANDS_PARAMS', message: 'Bollinger settings not stated; using 20 / 2.', evidence: c.evidence });
        const id = addInd(`bb_${period}_${mult}`, 'bbands', { period, mult });
        return [{ left: { kind: 'price', field: 'close' }, op: c.cmp, right: { kind: 'indicator', id, line: c.band } }];
      }
    }
  };

  // Conditions from one sentence are AND-ed; several sentences for the same side
  // are also AND-ed, which is flagged because the speaker may mean OR.
  const group = (sentences: ExtractedCondition[][], label: string): RuleGroup | undefined => {
    if (sentences.length === 0) return undefined;
    if (sentences.length > 1) {
      gaps.push({ severity: 'assumed', code: 'COMBINED_RULES', message: `${sentences.length} separate ${label} rules were combined with AND; the video may mean OR.` });
    }
    return { logic: 'AND', conditions: sentences.flat().flatMap(toConditions) };
  };

  const entryLong = group(x.entryLong, 'long entry');
  const entryShort = group(x.entryShort, 'short entry');
  const exitLong = group(x.exitLong, 'long exit');
  const exitShort = group(x.exitShort, 'short exit');

  const timeframe = ctx.timeframe ?? (x.timeframes.length === 1 ? x.timeframes[0] : undefined);
  if (ctx.timeframe) {
    for (let i = gaps.length - 1; i >= 0; i--) {
      if (gaps[i].code === 'NO_TIMEFRAME' || gaps[i].code === 'MULTIPLE_TIMEFRAMES') gaps.splice(i, 1);
    }
    notes.push(`Timeframe ${ctx.timeframe} supplied by the operator.`);
  }

  const risk = { ...DEFAULT_RISK };
  // The engine default spread cap (25 pts) would block every entry on wider-spread
  // symbols such as gold, so scale it to the instrument's typical spread.
  risk.maxSpreadPoints = Math.max(DEFAULT_RISK.maxSpreadPoints, Math.ceil(ctx.spec.spreadPoints * 2.5));
  notes.push(`Spread cap set to ${risk.maxSpreadPoints} points (2.5x the ${ctx.symbol} typical spread); the video does not specify one.`);
  const pointsOf = (v: Distance, what: string): number => {
    if (v.unit === 'points') return Math.round(v.value);
    if (v.unit === 'pips') {
      notes.push(`${what}: ${v.value} pips converted at 1 pip = 10 points.`);
      return Math.round(v.value * 10);
    }
    const pts = Math.max(1, Math.round(((v.value / 100) * ctx.referencePrice) / ctx.spec.point));
    notes.push(`${what}: ${v.value}% converted to a fixed ${pts}-point distance at reference price ${ctx.referencePrice} (engine has no percent-based stops).`);
    return pts;
  };
  if (x.stopLoss) {
    risk.slMode = 'points';
    risk.slPoints = pointsOf(x.stopLoss, 'Stop loss');
  }
  if (x.takeProfit) {
    risk.tpMode = 'points';
    risk.tpPoints = pointsOf(x.takeProfit, 'Take profit');
  } else if (x.rewardRisk != null && x.stopLoss) {
    risk.tpMode = 'rr';
    risk.tpRR = x.rewardRisk;
  } else {
    // Every strategy needs a target at least 1.5x its stop (see validateRisk),
    // so an unstated one becomes the minimum reward:risk instead of "none".
    risk.tpMode = 'rr';
    risk.tpRR = DEFAULT_RISK.minRewardRisk;
    notes.push(`No take-profit stated; using a ${DEFAULT_RISK.minRewardRisk}:1 reward:risk target, the minimum the app allows.`);
  }
  if (x.riskPerTradePct != null) {
    risk.lotMode = 'percentRisk';
    risk.riskPercent = x.riskPerTradePct;
  }

  if (gaps.some((g) => g.severity === 'blocking') || !timeframe) {
    return { status: 'needs_review', strategy: null, gaps, notes };
  }

  const empty: RuleGroup = { logic: 'AND', conditions: [] };
  const strategy: Strategy = {
    id: `yt_${Math.random().toString(36).slice(2, 10)}`,
    name: ctx.name ?? 'YouTube strategy',
    symbol: ctx.symbol,
    timeframe,
    indicators: [...indicators.values()],
    entryLong: entryLong ?? empty,
    entryShort: entryShort ?? empty,
    ...(exitLong ? { exitLong } : {}),
    ...(exitShort ? { exitShort } : {}),
    risk,
  };

  const errors = validateStrategy(strategy);
  if (errors.length > 0) {
    return {
      status: 'needs_review',
      strategy: null,
      gaps: [...gaps, ...errors.map((e): Gap => ({ severity: 'blocking', code: 'INVALID_CONFIG', message: e }))],
      notes,
    };
  }
  return { status: 'candidate', strategy, gaps, notes };
}
