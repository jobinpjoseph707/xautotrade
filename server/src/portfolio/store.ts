import db from '../store.js';
import { DEFAULT_TIER } from './config.js';
import type { TierMeasures, TierState } from './tiers.js';

/** One day's tier check for one strategy. */
export interface TierRecord {
  strategyId: string;
  state: TierState;
  /** The tier today's numbers alone would give. */
  measured: number;
  /** True when the numbers came from a backtest (or nothing), not from 30 days on demo. */
  provisional: boolean;
  measures: TierMeasures | null;
  at: number;
}

export interface TierStore {
  /** The latest record for a strategy. */
  get(strategyId: string): TierRecord | null;
  /** Add or replace today's record (one per strategy per day). */
  put(r: TierRecord): void;
  all(): TierRecord[];
}

export class MemoryTierStore implements TierStore {
  private rows = new Map<string, TierRecord>();
  get(id: string): TierRecord | null {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  put(r: TierRecord): void {
    this.rows.set(r.strategyId, structuredClone(r));
  }
  all(): TierRecord[] {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
}

export class SqliteTierStore implements TierStore {
  get(id: string): TierRecord | null {
    const row = db.prepare('SELECT json FROM tier_assignments WHERE strategy_id = ? ORDER BY day DESC LIMIT 1').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TierRecord) : null;
  }
  put(r: TierRecord): void {
    db.prepare('INSERT OR REPLACE INTO tier_assignments (strategy_id, day, json) VALUES (?, ?, ?)').run(r.strategyId, r.state.lastDay, JSON.stringify(r));
  }
  all(): TierRecord[] {
    const rows = db
      .prepare('SELECT json FROM tier_assignments t WHERE day = (SELECT MAX(day) FROM tier_assignments WHERE strategy_id = t.strategy_id)')
      .all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as TierRecord);
  }
}

/** The tier a strategy is in right now, and whether anybody has measured it yet. */
export function tierOfStrategy(store: TierStore, strategyId: string): { tier: number; provisional: boolean } {
  const r = store.get(strategyId);
  return r ? { tier: r.state.tier, provisional: r.provisional } : { tier: DEFAULT_TIER, provisional: true };
}
