import db from '../store.js';
import type { InboxStore } from './inbox.js';
import type { InboxItem, InboxStatus } from './types.js';

/** Inbox cards in SQLite. The full card is a JSON body; status, key and time are columns so lists are cheap. */
export class SqliteInboxStore implements InboxStore {
  put(item: InboxItem): void {
    db.prepare(
      `INSERT INTO inbox_items (id, status, dedupe_key, ref, created_at, json) VALUES (@id, @status, @key, @ref, @created, @json)
       ON CONFLICT(id) DO UPDATE SET status = @status, dedupe_key = @key, ref = @ref, json = @json`,
    ).run({ id: item.id, status: item.status, key: item.dedupeKey, ref: item.ref, created: item.createdAt, json: JSON.stringify(item) });
  }

  get(id: string): InboxItem | null {
    const row = db.prepare('SELECT json FROM inbox_items WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as InboxItem) : null;
  }

  list(status?: InboxStatus, limit = 200): InboxItem[] {
    const rows = (status
      ? db.prepare('SELECT json FROM inbox_items WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : db.prepare('SELECT json FROM inbox_items ORDER BY created_at DESC LIMIT ?').all(limit)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as InboxItem);
  }

  findOpenByKey(key: string): InboxItem | null {
    const row = db.prepare("SELECT json FROM inbox_items WHERE status = 'open' AND dedupe_key = ? LIMIT 1").get(key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as InboxItem) : null;
  }
}
