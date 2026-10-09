/**
 * SQLite persistence. Small, synchronous, zero-ops — the right shape for a
 * single-user trading server that must survive restarts without losing its
 * strategies or its audit trail.
 */

import Database, { type Database as SqliteDatabase } from 'better-sqlite3';

import { config } from './config.js';
import { DEFAULT_RISK, type BacktestResult, type Strategy } from './engine/types.js';

export interface LogEntry {
  id?: number;
  ts: number;
  strategyId: string | null;
  level: 'info' | 'warn' | 'error' | 'trade';
  event: string;
  message: string;
  data?: unknown;
}

const db: SqliteDatabase = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

/** Every statement is IF NOT EXISTS, so running this on an existing database changes nothing. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strategies (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  timeframe  TEXT NOT NULL,
  json       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtests (
  id          TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  json        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  strategy_id TEXT,
  level       TEXT NOT NULL,
  event       TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_backtests_strategy ON backtests(strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_usage (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                            INTEGER NOT NULL,
  tag                           TEXT,
  model                         TEXT,
  input_tokens                  INTEGER NOT NULL,
  output_tokens                 INTEGER NOT NULL,
  cache_creation_input_tokens   INTEGER,
  cache_read_input_tokens       INTEGER,
  cost_usd                      REAL
);
CREATE INDEX IF NOT EXISTS idx_chat_usage_ts ON chat_usage(ts DESC);

CREATE TABLE IF NOT EXISTS inbox_items (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  dedupe_key TEXT,
  ref        TEXT,
  created_at INTEGER NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_status_time ON inbox_items(status, created_at DESC);
`;

/** Copies the whole database to `dest` (a safe online copy, works while the server is running). */
export function backupDatabase(dest: string): void {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

export function initSchema(d: Pick<SqliteDatabase, 'exec'>): void {
  d.exec(SCHEMA_SQL);
}

initSchema(db);

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * Strategies are one JSON column, so new fields need no SQL migration:
 * anything saved before a field existed is filled with its default on read.
 * Saved values always win; this never rewrites what is stored.
 */
export function normalizeStrategy(raw: Strategy): Strategy {
  return {
    ...raw,
    risk: { ...DEFAULT_RISK, ...raw.risk },
    isTest: raw.isTest ?? false,
    gate: raw.gate ?? 'backtest',
  };
}

export const strategies = {
  list(): Strategy[] {
    const rows = db.prepare('SELECT json FROM strategies ORDER BY updated_at DESC').all() as { json: string }[];
    return rows.map((r) => normalizeStrategy(JSON.parse(r.json) as Strategy));
  },

  get(id: string): Strategy | null {
    const row = db.prepare('SELECT json FROM strategies WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? normalizeStrategy(JSON.parse(row.json) as Strategy) : null;
  },

  save(s: Strategy): Strategy {
    const now = Date.now();
    const existing = strategies.get(s.id);
    const record: Strategy = {
      ...s,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    db.prepare(
      `INSERT INTO strategies (id, name, symbol, timeframe, json, created_at, updated_at)
       VALUES (@id, @name, @symbol, @timeframe, @json, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         name = @name, symbol = @symbol, timeframe = @timeframe,
         json = @json, updated_at = @updated_at`,
    ).run({
      id: record.id,
      name: record.name,
      symbol: record.symbol,
      timeframe: record.timeframe,
      json: JSON.stringify(record),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
    return record;
  },

  remove(id: string): void {
    db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
    db.prepare('DELETE FROM backtests WHERE strategy_id = ?').run(id);
  },
};

// ---------------------------------------------------------------------------
// Backtests
// ---------------------------------------------------------------------------

export const backtests = {
  save(id: string, result: BacktestResult): void {
    db.prepare('INSERT OR REPLACE INTO backtests (id, strategy_id, created_at, json) VALUES (?, ?, ?, ?)')
      .run(id, result.strategyId, Date.now(), JSON.stringify(result));
    // Keep only the ten most recent runs per strategy.
    db.prepare(
      `DELETE FROM backtests WHERE strategy_id = ? AND id NOT IN (
         SELECT id FROM backtests WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 10
       )`,
    ).run(result.strategyId, result.strategyId);
  },

  get(id: string): BacktestResult | null {
    const row = db.prepare('SELECT json FROM backtests WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as BacktestResult) : null;
  },

  listForStrategy(strategyId: string): { id: string; createdAt: number; metrics: BacktestResult['metrics'] }[] {
    const rows = db
      .prepare('SELECT id, created_at, json FROM backtests WHERE strategy_id = ? ORDER BY created_at DESC')
      .all(strategyId) as { id: string; created_at: number; json: string }[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      metrics: (JSON.parse(r.json) as BacktestResult).metrics,
    }));
  },
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settings = {
  get<T>(key: string, fallback: T): T {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  },
};

// ---------------------------------------------------------------------------
// Closed-position details from the broker (immutable once closed → cached forever)
// ---------------------------------------------------------------------------

db.exec(`CREATE TABLE IF NOT EXISTS position_history (position_id TEXT PRIMARY KEY, json TEXT NOT NULL)`);

export const positionHistory = {
  get<T>(id: string): T | null {
    const row = db.prepare('SELECT json FROM position_history WHERE position_id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  },
  many<T>(ids: string[]): Map<string, T> {
    const out = new Map<string, T>();
    if (!ids.length) return out;
    const stmt = db.prepare('SELECT position_id, json FROM position_history WHERE position_id = ?');
    for (const id of ids) {
      const row = stmt.get(id) as { position_id: string; json: string } | undefined;
      if (row) out.set(row.position_id, JSON.parse(row.json) as T);
    }
    return out;
  },
  put(id: string, value: unknown): void {
    db.prepare('INSERT OR REPLACE INTO position_history (position_id, json) VALUES (?, ?)').run(id, JSON.stringify(value));
  },
};

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const logs = {
  add(entry: Omit<LogEntry, 'id'>): LogEntry {
    const info = db
      .prepare('INSERT INTO logs (ts, strategy_id, level, event, message, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        entry.ts,
        entry.strategyId,
        entry.level,
        entry.event,
        entry.message,
        entry.data === undefined ? null : JSON.stringify(entry.data),
      );
    return { ...entry, id: Number(info.lastInsertRowid) };
  },

  recent(limit = 200, strategyId?: string): LogEntry[] {
    const rows = strategyId
      ? (db
          .prepare('SELECT * FROM logs WHERE strategy_id = ? ORDER BY id DESC LIMIT ?')
          .all(strategyId, limit) as any[])
      : (db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit) as any[]);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      strategyId: r.strategy_id,
      level: r.level,
      event: r.event,
      message: r.message,
      data: r.data ? JSON.parse(r.data) : undefined,
    }));
  },

  /** Trade-level entries for one strategy in [from, to), oldest first. */
  tradesBetween(strategyId: string, from: number, to: number): LogEntry[] {
    const rows = db
      .prepare("SELECT * FROM logs WHERE strategy_id = ? AND level = 'trade' AND ts >= ? AND ts < ? ORDER BY id ASC")
      .all(strategyId, from, to) as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      strategyId: r.strategy_id,
      level: r.level,
      event: r.event,
      message: r.message,
      data: r.data ? JSON.parse(r.data) : undefined,
    }));
  },

  /** Trade-level entries for ALL strategies in [from, to), oldest first (the trade journal's source). */
  tradesAll(from: number, to: number): LogEntry[] {
    const rows = db
      .prepare("SELECT * FROM logs WHERE level = 'trade' AND ts >= ? AND ts < ? ORDER BY id ASC")
      .all(from, to) as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      strategyId: r.strategy_id,
      level: r.level,
      event: r.event,
      message: r.message,
      data: r.data ? JSON.parse(r.data) : undefined,
    }));
  },

  /**
   * Trim the activity log, but never delete trade rows (entries and closes):
   * they are the trade journal and the realised-P&L history.
   */
  prune(keep = 5000): void {
    db.prepare("DELETE FROM logs WHERE level != 'trade' AND id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)").run(keep);
  },
};

// ---------------------------------------------------------------------------
// Chat/agent token usage — so cost isn't a surprise. Best-effort: only
// populated when the CLI backend reports usage for a call (see chat/backend.ts).
// ---------------------------------------------------------------------------

export interface ChatUsageEntry {
  ts: number;
  tag?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
}

export interface ChatUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  byTag: { tag: string; calls: number; totalTokens: number; costUsd: number }[];
}

export const chatUsage = {
  add(u: ChatUsageEntry): void {
    db.prepare(
      `INSERT INTO chat_usage (ts, tag, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.ts,
      u.tag ?? null,
      u.model ?? null,
      u.inputTokens,
      u.outputTokens,
      u.cacheCreationInputTokens ?? null,
      u.cacheReadInputTokens ?? null,
      u.costUsd ?? null,
    );
  },

  /** Totals (and a per-tag breakdown) for every call recorded since `sinceMs`. */
  summary(sinceMs: number): ChatUsageSummary {
    const t = db
      .prepare(
        `SELECT COUNT(*) as calls, COALESCE(SUM(input_tokens),0) as inputTokens,
                COALESCE(SUM(output_tokens),0) as outputTokens, COALESCE(SUM(cost_usd),0) as costUsd
         FROM chat_usage WHERE ts >= ?`,
      )
      .get(sinceMs) as { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
    const byTag = db
      .prepare(
        `SELECT COALESCE(tag, 'other') as tag, COUNT(*) as calls,
                COALESCE(SUM(input_tokens + output_tokens),0) as totalTokens, COALESCE(SUM(cost_usd),0) as costUsd
         FROM chat_usage WHERE ts >= ? GROUP BY tag ORDER BY totalTokens DESC`,
      )
      .all(sinceMs) as { tag: string; calls: number; totalTokens: number; costUsd: number }[];
    return { calls: t.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, totalTokens: t.inputTokens + t.outputTokens, costUsd: t.costUsd, byTag };
  },

  /** Keep the table from growing forever — only the summary numbers matter long-term. */
  prune(keep = 20_000): void {
    db.prepare('DELETE FROM chat_usage WHERE id NOT IN (SELECT id FROM chat_usage ORDER BY id DESC LIMIT ?)').run(keep);
  },
};

export default db;
