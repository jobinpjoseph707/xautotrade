import type { BacktestMetrics, Strategy, SymbolSpec } from '../engine/types.js';
import type { LogEntry } from '../store.js';
import { closedProfits } from '../gates/demoEvidence.js';
import { DEFAULT_TIER, type TierConfig } from './config.js';
import { maxDrawdownPctFromEquity } from './drawdown.js';
import { stopPointsOf } from './openRisk.js';
import type { TierRecord, TierStore } from './store.js';
import { nextTierState, tierFromMeasures, utcDayNumber, type TierMeasures } from './tiers.js';

const DAY = 86_400_000;
export const MEASURE_DAYS = 30;
/** Fewer closed demo trades than this and the numbers are too thin: the tier is provisional. */
export const MIN_TRADES_TO_MEASURE = 20;

export interface MeasureInput {
  closes: { ts: number; profit: number }[];
  /** Average money at risk to the stop per trade, in account currency, from the entries; null if unknown. */
  avgRiskPerTrade: number | null;
  equity: number;
}

/** Measures from the closed trades of the last 30 days. */
export function measureFromTrades(i: MeasureInput): TierMeasures {
  const total = i.closes.reduce((a, c) => a + c.profit, 0);
  const start = Math.max(i.equity - total, 1);
  let eq = start;
  const curve = i.closes.map((c) => ({ time: c.ts, equity: (eq += c.profit) }));
  const days = new Map<number, number>();
  for (const c of i.closes) days.set(utcDayNumber(c.ts), (days.get(utcDayNumber(c.ts)) ?? 0) + c.profit);
  const worst = Math.min(0, ...days.values());
  return {
    riskPerTradePct: i.avgRiskPerTrade != null ? (i.avgRiskPerTrade / Math.max(i.equity, 1)) * 100 : 0,
    maxDrawdownPct: maxDrawdownPctFromEquity(start, curve),
    worstDayPct: (-worst / start) * 100,
  };
}

/** Measures from a backtest: its drawdown and the risk the strategy is set to take. There are no real days to look at. */
export function measureFromBacktest(m: Pick<BacktestMetrics, 'maxDrawdownPct'>, riskPerTradePct: number): TierMeasures {
  return { riskPerTradePct, maxDrawdownPct: m.maxDrawdownPct, worstDayPct: 0 };
}

export interface TierServiceDeps {
  store: TierStore;
  strategies: { list(): Strategy[] };
  tradesBetween: (strategyId: string, from: number, to: number) => LogEntry[];
  latestBacktest: (strategyId: string) => { maxDrawdownPct: number } | null;
  equity: () => Promise<number>;
  specOf: (symbol: string) => Promise<SymbolSpec>;
  config: () => TierConfig;
  now?: () => number;
}

/** Sets every real strategy's tier from what it has actually done. Run once a day. */
export class TierService {
  private readonly now: () => number;
  constructor(private readonly deps: TierServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Risk per trade the strategy is set to take, % of equity, from its own settings. */
  private async configuredRiskPct(s: Strategy, equity: number): Promise<number> {
    const r = s.risk;
    if (r.lotMode === 'percentRisk') return r.riskPercent;
    if (r.slMode !== 'points') return 0;
    const spec = await this.deps.specOf(s.symbol);
    return ((r.fixedLot * r.slPoints * spec.pointValuePerLot) / Math.max(equity, 1)) * 100;
  }

  /** Average risk to the stop of the entries logged for this strategy in the window, in account currency. */
  private async loggedRisk(s: Strategy, entries: LogEntry[]): Promise<number | null> {
    const risks: number[] = [];
    for (const e of entries) {
      if (e.event !== 'entry') continue;
      const d = e.data as { lots?: number; sl?: number | null; entryPrice?: number } | undefined;
      if (!d || typeof d.lots !== 'number' || typeof d.entryPrice !== 'number' || d.sl == null) continue;
      const spec = await this.deps.specOf(s.symbol);
      risks.push(d.lots * stopPointsOf(d.entryPrice, d.sl, spec.point) * spec.pointValuePerLot);
    }
    return risks.length ? risks.reduce((a, b) => a + b, 0) / risks.length : null;
  }

  async recompute(): Promise<TierRecord[]> {
    const now = this.now();
    const equity = await this.deps.equity();
    const out: TierRecord[] = [];
    for (const s of this.deps.strategies.list()) {
      if (s.isTest) continue;
      const entries = this.deps.tradesBetween(s.id, now - MEASURE_DAYS * DAY, now + 1);
      const closes = closedProfits(entries);
      let measures: TierMeasures | null = null;
      let provisional = true;
      if (closes.length >= MIN_TRADES_TO_MEASURE) {
        const logged = await this.loggedRisk(s, entries);
        const avg = logged ?? ((await this.configuredRiskPct(s, equity)) / 100) * equity;
        measures = measureFromTrades({ closes, avgRiskPerTrade: avg, equity });
        provisional = false;
      } else {
        const bt = this.deps.latestBacktest(s.id);
        if (bt) measures = measureFromBacktest(bt, await this.configuredRiskPct(s, equity));
      }
      const measured = measures ? tierFromMeasures(measures).tier : DEFAULT_TIER;
      const prev = this.deps.store.get(s.id);
      const rec: TierRecord = {
        strategyId: s.id,
        state: nextTierState(prev?.state ?? null, measured, utcDayNumber(now)),
        measured,
        provisional,
        measures,
        at: now,
      };
      this.deps.store.put(rec);
      out.push(rec);
    }
    return out;
  }
}
