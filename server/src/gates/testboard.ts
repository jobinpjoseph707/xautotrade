import type { GateStage, Strategy } from '../engine/types.js';
import type { GateAttempt, GateStore } from './types.js';

export interface TestboardRow {
  strategyId: string;
  name: string;
  symbol: string;
  stage: GateStage;
  /** The most recent test of the stage it is in. */
  latest: Pick<GateAttempt, 'verdict' | 'passed' | 'reasons' | 'at' | 'attemptNo' | 'requiredProfitFactor'> | null;
}

/** One row per real strategy. Test rigs and demo presets never show up here. */
export function testboardRows(strategies: Strategy[], store: GateStore): TestboardRow[] {
  return strategies
    .filter((s) => !s.isTest)
    .map((s) => {
      const stage = s.gate ?? 'backtest';
      const a = store.latest(s.id, stage);
      return {
        strategyId: s.id,
        name: s.name,
        symbol: s.symbol,
        stage,
        latest: a ? { verdict: a.verdict, passed: a.passed, reasons: a.reasons, at: a.at, attemptNo: a.attemptNo, requiredProfitFactor: a.requiredProfitFactor } : null,
      };
    });
}
