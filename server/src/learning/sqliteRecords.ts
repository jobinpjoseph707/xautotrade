import db from '../store.js';
import type { Keyed, RecordStore } from './records.js';

db.exec(`
CREATE TABLE IF NOT EXISTS learning_records (
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  json       TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_learning_kind_time ON learning_records(kind, created_at DESC);
`);

/** Rows of one kind ("change", "candidate") in a single table, JSON bodies. */
export class SqliteRecordStore<T extends Keyed> implements RecordStore<T> {
  constructor(private readonly kind: string) {}

  put(r: T): void {
    db.prepare(
      `INSERT INTO learning_records (id, kind, created_at, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json`,
    ).run(r.id, this.kind, r.createdAt, JSON.stringify(r));
  }

  get(id: string): T | null {
    const row = db.prepare('SELECT json FROM learning_records WHERE kind = ? AND id = ?').get(this.kind, id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  }

  all(limit = 10_000): T[] {
    const rows = db
      .prepare('SELECT json FROM learning_records WHERE kind = ? ORDER BY created_at DESC LIMIT ?')
      .all(this.kind, limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as T);
  }
}
