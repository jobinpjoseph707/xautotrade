/**
 * Rule DSL evaluator.
 *
 * A rule is a group of conditions joined by AND/OR. Each condition compares two
 * operands (an indicator line, a price field, a constant, the live spread, or
 * the UTC hour). Operands can be shifted back N bars, which is what makes
 * "crosses above" and "rising for N bars" expressible without custom code.
 */

import type {
  Candle,
  Condition,
  IndicatorOutput,
  Operand,
  RuleGroup,
} from './types.js';

export interface EvalContext {
  candles: Candle[];
  indicators: Record<string, IndicatorOutput>;
  /** Current spread in points. */
  spreadPoints: number;
}

function priceAt(candles: Candle[], i: number, field: Operand extends never ? never : string): number | null {
  const c = candles[i];
  if (!c) return null;
  switch (field) {
    case 'open':
      return c.open;
    case 'high':
      return c.high;
    case 'low':
      return c.low;
    case 'close':
      return c.close;
    case 'hl2':
      return (c.high + c.low) / 2;
    case 'hlc3':
      return (c.high + c.low + c.close) / 3;
    case 'ohlc4':
      return (c.open + c.high + c.low + c.close) / 4;
    default:
      return c.close;
  }
}

/** Resolve an operand's numeric value at bar `i`, or null if unavailable. */
export function resolveOperand(op: Operand, i: number, ctx: EvalContext): number | null {
  switch (op.kind) {
    case 'const':
      return op.value;
    case 'spread':
      return ctx.spreadPoints;
    case 'hourUTC': {
      const c = ctx.candles[i];
      return c ? new Date(c.time).getUTCHours() : null;
    }
    case 'price': {
      const idx = i - (op.shift ?? 0);
      if (idx < 0) return null;
      return priceAt(ctx.candles, idx, op.field);
    }
    case 'indicator': {
      const idx = i - (op.shift ?? 0);
      if (idx < 0) return null;
      const ind = ctx.indicators[op.id];
      if (!ind) return null;
      const series = ind[op.line ?? 'value'];
      if (!series) return null;
      const v = series[idx];
      return v == null ? null : v;
    }
    default:
      return null;
  }
}

export function evaluateCondition(cond: Condition, i: number, ctx: EvalContext): boolean {
  const { op } = cond;

  if (op === 'risingFor' || op === 'fallingFor') {
    const n = Math.max(1, Math.round(resolveOperand(cond.right, i, ctx) ?? 1));
    for (let k = 0; k < n; k++) {
      const shifted: Operand = shiftOperand(cond.left, k);
      const shiftedPrev: Operand = shiftOperand(cond.left, k + 1);
      const a = resolveOperand(shifted, i, ctx);
      const b = resolveOperand(shiftedPrev, i, ctx);
      if (a == null || b == null) return false;
      if (op === 'risingFor' && !(a > b)) return false;
      if (op === 'fallingFor' && !(a < b)) return false;
    }
    return true;
  }

  const l = resolveOperand(cond.left, i, ctx);
  const r = resolveOperand(cond.right, i, ctx);
  if (l == null || r == null) return false;

  switch (op) {
    case 'gt':
      return l > r;
    case 'lt':
      return l < r;
    case 'gte':
      return l >= r;
    case 'lte':
      return l <= r;
    case 'crossesAbove':
    case 'crossesBelow': {
      const lPrev = resolveOperand(shiftOperand(cond.left, 1), i, ctx);
      const rPrev = resolveOperand(shiftOperand(cond.right, 1), i, ctx);
      if (lPrev == null || rPrev == null) return false;
      return op === 'crossesAbove' ? lPrev <= rPrev && l > r : lPrev >= rPrev && l < r;
    }
    default:
      return false;
  }
}

function shiftOperand(op: Operand, extra: number): Operand {
  if (op.kind === 'indicator' || op.kind === 'price') {
    return { ...op, shift: (op.shift ?? 0) + extra };
  }
  return op;
}

export function evaluateGroup(group: RuleGroup | undefined, i: number, ctx: EvalContext): boolean {
  if (!group || !group.conditions || group.conditions.length === 0) return false;
  if (group.logic === 'OR') {
    return group.conditions.some((c) => evaluateCondition(c, i, ctx));
  }
  return group.conditions.every((c) => evaluateCondition(c, i, ctx));
}

/** Human-readable rendering of a condition — used in the app and in logs. */
export function describeOperand(op: Operand): string {
  switch (op.kind) {
    case 'const':
      return String(op.value);
    case 'spread':
      return 'Spread (points)';
    case 'hourUTC':
      return 'Hour (UTC)';
    case 'price':
      return `${op.field}${op.shift ? `[${op.shift}]` : ''}`;
    case 'indicator':
      return `${op.id}${op.line && op.line !== 'value' ? `.${op.line}` : ''}${op.shift ? `[${op.shift}]` : ''}`;
    default:
      return '?';
  }
}

export const OP_LABELS: Record<string, string> = {
  gt: 'is greater than',
  lt: 'is less than',
  gte: 'is greater or equal',
  lte: 'is less or equal',
  crossesAbove: 'crosses above',
  crossesBelow: 'crosses below',
  risingFor: 'has been rising for (bars)',
  fallingFor: 'has been falling for (bars)',
};

export function describeCondition(c: Condition): string {
  return `${describeOperand(c.left)} ${OP_LABELS[c.op] ?? c.op} ${describeOperand(c.right)}`;
}

/** Structural validation. Returns a list of human-readable problems. */
export function validateStrategy(s: {
  indicators: { id: string; type: string }[];
  entryLong?: RuleGroup;
  entryShort?: RuleGroup;
  exitLong?: RuleGroup;
  exitShort?: RuleGroup;
}): string[] {
  const errors: string[] = [];
  const ids = new Set(s.indicators.map((i) => i.id));
  if (ids.size !== s.indicators.length) errors.push('Duplicate indicator ids.');

  const checkGroup = (g: RuleGroup | undefined, label: string) => {
    if (!g) return;
    for (const c of g.conditions) {
      for (const side of [c.left, c.right]) {
        if (side.kind === 'indicator' && !ids.has(side.id)) {
          errors.push(`${label}: references unknown indicator "${side.id}".`);
        }
      }
    }
  };
  checkGroup(s.entryLong, 'Long entry');
  checkGroup(s.entryShort, 'Short entry');
  checkGroup(s.exitLong, 'Long exit');
  checkGroup(s.exitShort, 'Short exit');

  const hasLong = (s.entryLong?.conditions?.length ?? 0) > 0;
  const hasShort = (s.entryShort?.conditions?.length ?? 0) > 0;
  if (!hasLong && !hasShort) errors.push('Strategy has no entry conditions — it will never trade.');
  return errors;
}
