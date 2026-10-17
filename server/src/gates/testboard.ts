import { PASS_MARKS } from './types.js';
import type { GateStage, Strategy } from '../engine/types.js';
import type { GateAttempt, GateStore } from './types.js';

export interface TestboardRow {
  strategyId: string;
  name: string;
  symbol: string;
  /** Mirrors the strategy's own `gate`, kept under both names so older clients keep working. */
  gate: GateStage;
  stage: GateStage;
  /** The most recent test of the stage it is in. */
  latest: Pick<GateAttempt, 'verdict' | 'passed' | 'reasons' | 'at' | 'attemptNo' | 'requiredProfitFactor'> | null;
  /** Demo stage only: how far along the evidence is. */
  progress: { trades: number; tradesNeeded: number; days: number; daysNeeded: number } | null;
  /** True when a pass is waiting for you to tap Move to next stage in the Inbox. */
  waiting: boolean;
}

export type DemoProgressFn = (strategy: Strategy) => { trades: number; days: number } | null;

/** One row per real strategy. Test rigs and demo presets never show up here. */
export function testboardRows(strategies: Strategy[], store: GateStore, demoProgress: DemoProgressFn = () => null): TestboardRow[] {
  return strategies
    .filter((s) => !s.isTest)
    .map((s) => {
      const stage = s.gate ?? 'backtest';
      const a = store.latest(s.id, stage);
      const d = stage === 'demo' ? demoProgress(s) : null;
      return {
        strategyId: s.id,
        name: s.name,
        symbol: s.symbol,
        gate: stage,
        stage,
        latest: a ? { verdict: a.verdict, passed: a.passed, reasons: a.reasons, at: a.at, attemptNo: a.attemptNo, requiredProfitFactor: a.requiredProfitFactor } : null,
        progress: d ? { trades: d.trades, tradesNeeded: PASS_MARKS.demo.minTrades, days: Math.round(d.days * 10) / 10, daysNeeded: PASS_MARKS.demo.minDays } : null,
        waiting: !!a?.passed && stage !== 'live',
      };
    });
}
