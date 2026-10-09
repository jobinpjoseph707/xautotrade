/**
 * Is the database file healthy? Pure: takes an open connection, returns null when healthy or a plain-English message.
 * Used at startup so a damaged file stops the server with an explanation instead of crashing later,
 * in the middle of a request, with "database disk image is malformed".
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';

export function integrityProblem(db: Pick<SqliteDatabase, 'prepare'>, path: string): string | null {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    if (rows.length === 1 && rows[0].quick_check === 'ok') return null;
    const first = rows.map((r) => r.quick_check).find((t) => !t.startsWith('***')) ?? 'the file failed its integrity check';
    return damagedMessage(path, first);
  } catch (err) {
    return damagedMessage(path, err instanceof Error ? err.message : String(err));
  }
}

export function damagedMessage(path: string, detail: string): string {
  return [
    `The database file "${path}" is damaged (${detail}).`,
    'Your strategies can usually be saved. Stop the server, then run:',
    `  npm run salvage -- ${path}`,
    'It copies what it can into a new file and never changes the old one. It tells you the next two steps.',
  ].join('\n');
}
