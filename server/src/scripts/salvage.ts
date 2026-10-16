/**
 * Copy what can still be read out of a damaged database into a fresh one. Never changes the damaged file:
 * it works on a copy in a temporary folder. Logs and chat usage are skipped on purpose (they are the usual
 * casualties and nothing depends on them); strategies, settings, backtests and closed-trade details are kept.
 * The API key setting is not carried over, so the key in your .env is the one that counts.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/** Same shape as the tables in store.ts; the server adds every other table itself on its next start. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backtests (id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS position_history (position_id TEXT PRIMARY KEY, json TEXT NOT NULL);
`;

const TABLES = ['strategies', 'settings', 'backtests', 'position_history'] as const;

export interface SalvageResult {
  copied: Record<string, number>;
  problems: string[];
  strategyNames: string[];
  lines: string[];
}

function openCopy(source: string, withWal: boolean): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xat-salvage-'));
  copyFileSync(source, join(dir, 'copy.db'));
  if (withWal && existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, join(dir, 'copy.db-wal'));
  return { db: new Database(join(dir, 'copy.db')), dir };
}

export function salvage(source: string, dest: string): SalvageResult {
  if (!existsSync(source)) throw new Error(`Cannot find ${source}`);
  if (existsSync(dest)) throw new Error(`${dest} already exists. Move it away first; this never overwrites anything.`);

  const result: SalvageResult = { copied: {}, problems: [], strategyNames: [], lines: [] };
  const out = new Database(dest);
  out.exec(SCHEMA);

  // Try with the write-ahead file first (it holds the newest changes), then without it.
  let attempt = 0;
  let readable = false;
  for (const withWal of [true, false]) {
    attempt += 1;
    const { db, dir } = openCopy(source, withWal);
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      readable = true;
      for (const table of TABLES) {
        let n = 0;
        try {
          const ins = (cols: string[]) => out.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
          let stmt: ReturnType<typeof ins> | null = null;
          for (const row of db.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<Record<string, unknown>>) {
            if (table === 'settings' && row.key === 'apiKey') continue;
            stmt ??= ins(Object.keys(row));
            stmt.run(...Object.values(row));
            n += 1;
          }
        } catch (err) {
          if (/no such table/i.test(String(err))) continue; // an older file may simply not have this table
          result.problems.push(`${table}: stopped after ${n} rows (${err instanceof Error ? err.message : String(err)})`);
        }
        result.copied[table] = Math.max(result.copied[table] ?? 0, n);
      }
    } catch (err) {
      result.problems.push(`attempt ${attempt} (${withWal ? 'with' : 'without'} the -wal file): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
    if (readable && (result.copied.strategies ?? 0) > 0) break;
  }

  result.strategyNames = (out.prepare('SELECT name, symbol, timeframe FROM strategies ORDER BY name').all() as { name: string; symbol: string; timeframe: string }[])
    .map((s) => `${s.name} (${s.symbol} ${s.timeframe})`);
  out.close();

  result.lines.push(`Saved to ${dest}. Your damaged file was not changed.`);
  for (const t of TABLES) result.lines.push(`  ${t}: ${result.copied[t] ?? 0} copied`);
  if (result.strategyNames.length) result.lines.push('Strategies recovered:', ...result.strategyNames.map((n) => `  - ${n}`));
  else result.lines.push('No strategies could be read from that file.');
  if (result.problems.length) result.lines.push('Problems met along the way:', ...result.problems.map((p) => `  - ${p}`));
  return result;
}
