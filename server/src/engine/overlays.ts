/**
 * Strategy overlays: everything a strategy takes into account, drawn on the
 * MT5 chart by the XATLevels EA (and returned to the app for a preview).
 *
 *  - price-scale indicators (SMA/EMA/WMA, Bollinger bands) → polylines of SEG objects
 *  - oscillators (RSI, MACD, Stochastic, ADX, CCI, ATR) → info-panel rows (current value)
 *  - entry/exit rules → a checklist panel: which conditions are true on the last closed bar
 *  - this strategy's open trades → entry / stop / target lines
 *  - the recent range → resistance / support lines (the original Lines feature)
 *
 * Pure: candles + positions in, Level rows + a summary out. Candle times are the
 * broker's own (server) times, which is exactly the MT5 chart's time axis.
 */
import type { BrokerPosition } from '../broker/types.js';
import { computeIndicators } from './indicators.js';
import { levelsFromRange, type Level } from './levels.js';
import { describeOperand, evaluateCondition, evaluateGroup, OP_LABELS, type EvalContext } from './rules.js';
import type { Candle, Condition, IndicatorSpec, RuleGroup, Strategy } from './types.js';

/** Categorical slots (dark-surface steps, fixed order) — the same colours the app legend uses. */
export const OVERLAY_COLORS = ['#3987E5', '#D95926', '#199E70', '#C98500', '#D55181', '#9085E9', '#008300', '#E66767'];

const PRICE_TYPES = new Set(['sma', 'ema', 'wma', 'bbands']);

export interface OverlayOptions {
  /** How many closed bars the indicator lines cover (default 120). */
  bars?: number;
  indicators?: boolean;
  rules?: boolean;
  trades?: boolean;
  range?: boolean;
  rangeMinutes?: number;
}

export interface OverlaySeries {
  id: string;
  label: string;
  color: string;
  /** One value per point in `closes` (null during warm-up). */
  points: (number | null)[];
}

export interface PanelRow {
  id: string;
  label: string;
  value: string;
  color: string;
}

export interface RuleCheck {
  side: 'Long entry' | 'Short entry' | 'Long exit' | 'Short exit';
  logic: 'AND' | 'OR';
  passed: boolean;
  conditions: { text: string; ok: boolean }[];
}

export interface OverlayResult {
  levels: Level[];
  /** Closed-bar times (broker ms) and closes for the preview chart. */
  times: number[];
  closes: number[];
  series: OverlaySeries[];
  panel: PanelRow[];
  rules: RuleCheck[];
  signal: 'LONG' | 'SHORT' | 'none';
  lastBarTime: number | null;
}

/** '#RRGGBB' → MQL5 color (0xBBGGRR) as a decimal string, which the EA already parses. */
export function mqlColor(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return String((b << 16) | (g << 8) | r);
}

export function indicatorLabel(spec: IndicatorSpec): string {
  const p = spec.params ?? {};
  const args =
    spec.type === 'macd' ? `${p.fast ?? 12},${p.slow ?? 26},${p.signal ?? 9}`
    : spec.type === 'bbands' ? `${p.period ?? 20},${p.mult ?? 2}`
    : spec.type === 'stoch' ? `${p.kPeriod ?? 14},${p.dPeriod ?? 3},${p.slowing ?? 3}`
    : String(p.period ?? 14);
  return `${spec.type.toUpperCase()}(${args})`;
}

const fmt = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(digits));
/** ASCII only: the EA reads the file as ANSI. */
const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, '').trim();

function conditionText(c: Condition, names: Map<string, string>): string {
  const side = (o: Condition['left']) => {
    if (o.kind === 'indicator') {
      const base = names.get(o.id) ?? o.id;
      return `${base}${o.line && o.line !== 'value' ? `.${o.line}` : ''}${o.shift ? `[${o.shift}]` : ''}`;
    }
    return describeOperand(o);
  };
  const op = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[c.op as string] ?? OP_LABELS[c.op] ?? c.op;
  return `${side(c.left)} ${op} ${side(c.right)}`;
}

export function buildOverlays(
  strategy: Strategy,
  closed: Candle[],
  positions: BrokerPosition[],
  opts: OverlayOptions = {},
): OverlayResult {
  const o = { bars: 120, indicators: true, rules: true, trades: true, range: false, rangeMinutes: 30, ...opts };
  const sym = strategy.symbol;
  const tag = strategy.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  const pre = `ov_${tag}`;
  const levels: Level[] = [];
  const panel: PanelRow[] = [];
  const series: OverlaySeries[] = [];
  const rules: RuleCheck[] = [];

  const n = closed.length;
  const i = n - 1;
  const start = Math.max(1, n - o.bars);
  const times = closed.slice(start).map((c) => c.time);
  const closes = closed.slice(start).map((c) => c.close);
  const ind = n ? computeIndicators(closed, strategy.indicators) : {};
  const names = new Map(strategy.indicators.map((s) => [s.id, indicatorLabel(s)]));
  const ctx: EvalContext = { candles: closed, indicators: ind, spreadPoints: 0 };
  const t = (k: number) => Math.floor(closed[k].time / 1000);

  // --- indicators -----------------------------------------------------------
  strategy.indicators.forEach((spec, slot) => {
    const color = OVERLAY_COLORS[slot % OVERLAY_COLORS.length];
    const out = ind[spec.id];
    if (!out) return;
    const label = indicatorLabel(spec);
    if (PRICE_TYPES.has(spec.type)) {
      const lines = spec.type === 'bbands' ? ['upper', 'middle', 'lower'] : ['value'];
      for (const line of lines) {
        const vals = out[line] ?? [];
        const name = lines.length > 1 ? `${label} ${line}` : label;
        series.push({ id: `${spec.id}.${line}`, label: name, color, points: vals.slice(start) as (number | null)[] });
        if (o.indicators) {
          for (let k = start; k <= i; k++) {
            const a = vals[k - 1];
            const b = vals[k];
            if (a == null || b == null) continue;
            levels.push({
              symbol: sym,
              kind: 'SEG',
              id: `${pre}_${spec.id}_${line}_${i - k}`,
              price1: a,
              time1: t(k - 1),
              price2: b,
              time2: t(k),
              color: mqlColor(color),
              width: line === 'middle' ? 1 : 2,
              style: line === 'middle' ? 2 : 0,
              label: name,
            });
          }
        }
        const v = vals[i] as number | null;
        const d = v == null ? 2 : Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 10 ? 3 : 5;
        panel.push({ id: `${spec.id}.${line}`, label: name, value: fmt(v, d), color });
      }
    } else {
      const parts = Object.entries(out)
        .filter(([k]) => k !== 'value' || Object.keys(out).length === 1)
        .map(([k, v]) => `${Object.keys(out).length > 1 ? `${k} ` : ''}${fmt(v[i] as number | null)}`);
      panel.push({ id: spec.id, label, value: parts.join('  '), color });
    }
  });

  // --- rule checklist ----------------------------------------------------------
  const groups: [RuleCheck['side'], RuleGroup | undefined][] = [
    ['Long entry', strategy.entryLong],
    ['Short entry', strategy.entryShort],
    ['Long exit', strategy.exitLong],
    ['Short exit', strategy.exitShort],
  ];
  if (n > 1) {
    for (const [side, g] of groups) {
      if (!g || !g.conditions?.length) continue;
      const conditions = g.conditions.map((c) => ({ text: conditionText(c, names), ok: evaluateCondition(c, i, ctx) }));
      rules.push({ side, logic: g.logic, passed: evaluateGroup(g, i, ctx), conditions });
    }
  }
  const longSig = rules.find((r) => r.side === 'Long entry')?.passed ?? false;
  const shortSig = rules.find((r) => r.side === 'Short entry')?.passed ?? false;
  const signal = longSig && !shortSig ? 'LONG' : shortSig && !longSig ? 'SHORT' : 'none';

  // --- on-chart info panel (LABEL rows, top-left) ------------------------------
  let row = 0;
  const label = (text: string, color = '#C3C2B7') => {
    levels.push({ symbol: sym, kind: 'LABEL', id: `${pre}_panel_${row}`, price1: row, color: mqlColor(color), width: 9, style: 0, label: ascii(text) });
    row++;
  };
  if (o.indicators || o.rules) {
    label(`XAT  ${strategy.name}  ${strategy.timeframe}   signal: ${signal}`, '#FFFFFF');
  }
  if (o.indicators) {
    for (const p of panel) label(`${p.label}: ${p.value}`, p.color);
  }
  if (o.rules) {
    for (const r of rules) {
      label(`${r.side} (${r.logic === 'AND' ? 'all of' : 'any of'}): ${r.passed ? 'YES' : 'no'}`, r.passed ? '#0CA30C' : '#9C9A93');
      for (const c of r.conditions) label(`   ${c.ok ? '[+]' : '[ ]'} ${c.text}`, c.ok ? '#0CA30C' : '#9C9A93');
    }
  }

  // --- open trades --------------------------------------------------------------
  if (o.trades) {
    for (const p of positions) {
      const side = p.side === 'long' ? 'BUY' : 'SELL';
      levels.push({ symbol: sym, kind: 'HLINE', id: `${pre}_pos_${p.id}_in`, price1: p.openPrice, color: mqlColor('#C3C2B7'), width: 1, style: 2, label: `${side} ${p.volume} entry` });
      if (p.stopLoss) levels.push({ symbol: sym, kind: 'HLINE', id: `${pre}_pos_${p.id}_sl`, price1: p.stopLoss, color: mqlColor('#E66767'), width: 1, style: 1, label: `${side} stop` });
      if (p.takeProfit) levels.push({ symbol: sym, kind: 'HLINE', id: `${pre}_pos_${p.id}_tp`, price1: p.takeProfit, color: mqlColor('#0CA30C'), width: 1, style: 1, label: `${side} target` });
    }
  }

  // --- recent range ----------------------------------------------------------------
  if (o.range && n > 0) {
    const tfMin = Math.max(1, Math.round((closed[n - 1].time - (closed[n - 2]?.time ?? closed[n - 1].time - 60_000)) / 60_000));
    const want = Math.max(1, Math.ceil(o.rangeMinutes / tfMin));
    const bars = closed.slice(-want).map((c) => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
    levels.push(...levelsFromRange(sym, bars, { idPrefix: `${pre}_rng`, label: `${strategy.name} ${o.rangeMinutes}m` }));
  }

  return { levels, times, closes, series, panel, rules, signal, lastBarTime: n ? closed[i].time : null };
}
