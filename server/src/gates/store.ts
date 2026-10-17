import type { GateStage } from '../engine/types.js';
import type { GateAttempt, GateStore } from './types.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as object)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Gate history in memory (tests). Records are frozen copies: they can be added to, never changed. */
export class MemoryGateStore implements GateStore {
  private rows: GateAttempt[] = [];

  append(a: GateAttempt): void {
    if (this.rows.some((r) => r.id === a.id)) throw new Error(`Gate record ${a.id} already exists.`);
    this.rows.push(deepFreeze(structuredClone(a)));
  }

  list(strategyId: string, stage?: GateStage): GateAttempt[] {
    return this.rows.filter((r) => r.strategyId === strategyId && (!stage || r.stage === stage));
  }

  latest(strategyId: string, stage?: GateStage): GateAttempt | null {
    const l = this.list(strategyId, stage);
    return l.length ? l[l.length - 1] : null;
  }
}
