import db from '../store.js';
import type { GateStage } from '../engine/types.js';
import type { GateAttempt, GateStore } from './types.js';

/** Gate history in SQLite. The table refuses UPDATE and DELETE, so the record cannot be rewritten by anyone. */
export class SqliteGateStore implements GateStore {
  append(a: GateAttempt): void {
    db.prepare('INSERT INTO gate_history (id, strategy_id, stage, at, json) VALUES (@id, @strategyId, @stage, @at, @json)').run({
      id: a.id,
      strategyId: a.strategyId,
      stage: a.stage,
      at: a.at,
      json: JSON.stringify(a),
    });
  }

  list(strategyId: string, stage?: GateStage): GateAttempt[] {
    const rows = (stage
      ? db.prepare('SELECT json FROM gate_history WHERE strategy_id = ? AND stage = ? ORDER BY at, rowid').all(strategyId, stage)
      : db.prepare('SELECT json FROM gate_history WHERE strategy_id = ? ORDER BY at, rowid').all(strategyId)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as GateAttempt);
  }

  latest(strategyId: string, stage?: GateStage): GateAttempt | null {
    const l = this.list(strategyId, stage);
    return l.length ? l[l.length - 1] : null;
  }
}
