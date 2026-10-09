import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, openSync, readFileSync, statSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { integrityProblem } from './dbcheck.js';
import { salvage } from './salvage.js';

/** A database like the app's: a few strategies early in the file, then a big logs table. */
function makeDb(dir: string, name = 'old.db'): string {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE strategies (id TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE backtests (id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, message TEXT NOT NULL);
  `);
  const s = db.prepare('INSERT INTO strategies VALUES (?,?,?,?,?,?,?)');
  s.run('s1', 'Gold EMA Trend', 'XAUUSD', '15m', '{"a":1}', 1, 2);
  s.run('s2', 'Gold Pullback', 'XAUUSD', '5m', '{"a":2}', 1, 2);
  db.prepare('INSERT INTO settings VALUES (?,?)').run('apiKey', '"secret"');
  db.prepare('INSERT INTO settings VALUES (?,?)').run('safety:dailyLossCapPct', '3');
  db.prepare('INSERT INTO backtests VALUES (?,?,?,?)').run('b1', 's1', 1, '{}');
  const l = db.prepare('INSERT INTO logs (ts, message) VALUES (?, ?)');
  for (let i = 0; i < 4000; i++) l.run(i, `log line number ${i} with some padding to fill the pages `.repeat(2));
  db.close();
  return path;
}

/** Overwrite the later part of the file (where the logs live) with garbage, like a bad copy would. */
function damageTail(path: string): void {
  const size = statSync(path).size;
  const from = Math.floor(size * 0.6);
  const fd = openSync(path, 'r+');
  writeSync(fd, Buffer.alloc(size - from, 0xab), 0, size - from, from);
  closeSync(fd);
}

// SV-1
test('SV-1 a healthy file is copied across, the API key is left behind, and the original is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xat-sv-'));
  const old = makeDb(dir);
  const before = readFileSync(old);
  const r = salvage(old, join(dir, 'new.db'));
  assert.equal(r.copied.strategies, 2);
  assert.equal(r.copied.backtests, 1);
  assert.equal(r.copied.settings, 1, 'only the non-key setting');
  const out = new Database(join(dir, 'new.db'));
  assert.equal((out.prepare("SELECT count(*) AS n FROM settings WHERE key = 'apiKey'").get() as { n: number }).n, 0);
  assert.equal(integrityProblem(out, 'new.db'), null);
  out.close();
  assert.ok(before.equals(readFileSync(old)), 'the original file is byte for byte the same');
  assert.deepEqual(r.strategyNames, ['Gold EMA Trend (XAUUSD 15m)', 'Gold Pullback (XAUUSD 5m)']);
});

// SV-2
test('SV-2 a file damaged in the logs still gives back the strategies, and the check flags it as damaged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xat-sv-'));
  const old = makeDb(dir);
  damageTail(old);
  const probe = new Database(old);
  const problem = integrityProblem(probe, old);
  probe.close();
  assert.ok(problem, 'a damaged file must be reported');
  assert.match(problem!, /npm run salvage/);
  const r = salvage(old, join(dir, 'new.db'));
  assert.equal(r.copied.strategies, 2, 'both strategies are recovered');
  assert.ok(r.lines.some((l) => /Strategies recovered/.test(l)));
});

// SV-3
test('SV-3 it refuses to overwrite a file or to read one that is not there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xat-sv-'));
  const old = makeDb(dir);
  salvage(old, join(dir, 'new.db'));
  assert.throws(() => salvage(old, join(dir, 'new.db')), /already exists/);
  assert.throws(() => salvage(join(dir, 'missing.db'), join(dir, 'x.db')), /Cannot find/);
  assert.ok(!existsSync(join(dir, 'x.db')));
});

// SV-4
test('SV-4 a healthy database passes the integrity check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xat-sv-'));
  const db = new Database(makeDb(dir));
  assert.equal(integrityProblem(db, 'old.db'), null);
  db.close();
});
