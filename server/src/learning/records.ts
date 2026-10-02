/**
 * Tiny record store. The interface keeps the learning logic testable with an
 * in-memory map; the server uses the SQLite-backed one in sqliteRecords.ts.
 */
export interface Keyed {
  id: string;
  createdAt: number;
}

export interface RecordStore<T extends Keyed> {
  put(r: T): void;
  get(id: string): T | null;
  /** Newest first. */
  all(limit?: number): T[];
}

export class MemoryRecordStore<T extends Keyed> implements RecordStore<T> {
  private readonly rows = new Map<string, T>();

  put(r: T): void {
    this.rows.set(r.id, structuredClone(r));
  }

  get(id: string): T | null {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }

  all(limit = 10_000): T[] {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}
