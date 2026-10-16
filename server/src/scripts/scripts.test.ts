import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { DEFAULT_RISK, type Strategy } from '../engine/types.js';
import { validStrategy } from '../testkit/index.js';
import { backupDatabase, strategies as realStore } from '../store.js';
import { planCleanup, runCleanup, type CleanupStore } from './cleanup.js';
import { formatRank, rankStrategies, type RankInput } from './rank.js';

function memStore(initial: Strategy[]) {
  const db = new Map(initial.map((s) => [s.id, structuredClone(s)]));
  const ops: string[] = [];
  const store: CleanupStore = {
    list: () => [...db.values()].map((s) => structuredClone(s)),
    save: (s) => { ops.push(`save:${s.id}`); db.set(s.id, structuredClone(s)); },
    remove: (id) => { ops.push(`remove:${id}`); db.delete(id); },
  };
  return { store, db, ops };
}

const strat = (id: string, name: string, symbol: string, maxLot = DEFAULT_RISK.maxLot): Strategy => {
  const s = validStrategy(symbol, id);
  s.name = name;
  s.risk = { ...s.risk, maxLot };
  return s;
};

// The strategies named in the open-issues list, plus two real ones.
const fixture = (): Strategy[] => [
  strat('real1', 'M5 EMA Pullback Scalp', 'EURUSD', 5),
  strat('real2', 'Gold Trend', 'XAUUSD', 5),
  strat('t1', 'M1 Fast Scalp (test)', 'BTCUSD', 0.5),
  strat('gq1', 'M1 Gold Quick Scalp', 'EURUSD', 0.5),
  strat('gq2', 'M1 Gold Quick Scalp', 'EURUSD', 0.5),
  strat('gq3', 'M1 Gold Quick Scalp (test)', 'XAUUSD', 0.2),
  strat('hft', 'M1 HFT EMA Scalp', 'XAUUSD', 0.2),
];

const noBackup = () => { throw new Error('backup must not be taken on a dry run'); };

// C-1
test('a dry run changes nothing and prints what it would do', () => {
  const { store, db, ops } = memStore(fixture());
  const before = JSON.stringify([...db.values()]);
  const r = runCleanup({ store, backup: noBackup }, { apply: false });
  assert.equal(r.applied, false);
  assert.deepEqual(ops, []);
  assert.equal(JSON.stringify([...db.values()]), before);
  assert.ok(r.lines.some((l) => /Would do: delete "M1 HFT EMA Scalp"/.test(l)));
  assert.ok(r.lines.some((l) => /Would do: lower max lot of "M5 EMA Pullback Scalp" from 5 to 0.5/.test(l)));
  assert.ok(r.lines.some((l) => /Dry run/.test(l)));
});

// C-2
test('a backup is written before the first change, and no backup means no change', () => {
  const { store, ops } = memStore(fixture());
  const order: string[] = [];
  const wrapped: CleanupStore = {
    list: store.list,
    save: (s) => { order.push('change'); store.save(s); },
    remove: (id) => { order.push('change'); store.remove(id); },
  };
  runCleanup({ store: wrapped, backup: () => { order.push('backup'); return 'b.db'; } }, { apply: true });
  assert.equal(order[0], 'backup');
  assert.ok(order.filter((x) => x === 'backup').length === 1 && order.length > 1);

  const failing = memStore(fixture());
  assert.throws(() => runCleanup({ store: failing.store, backup: () => { throw new Error('disk full'); } }, { apply: true }), /disk full/);
  assert.deepEqual(failing.ops, [], 'nothing was touched');
  void ops;
});

// C-3
test('strategies with "(test)" in the name are flagged isTest', () => {
  const { store, db } = memStore(fixture());
  runCleanup({ store, backup: () => 'b.db' }, { apply: true });
  assert.equal(db.get('t1')!.isTest, true);
  assert.equal(db.get('gq3')!.isTest, true, 'a "(test)" gold scalp on XAUUSD is kept and flagged, not deleted');
  assert.notEqual(db.get('real1')!.isTest, true);
});

// C-4
test('maxLot above the new default is clamped (0.5, or 0.2 on gold)', () => {
  const { store, db } = memStore(fixture());
  runCleanup({ store, backup: () => 'b.db' }, { apply: true });
  assert.equal(db.get('real1')!.risk.maxLot, 0.5); // 5 -> 0.5
  assert.equal(db.get('real2')!.risk.maxLot, 0.2); // gold: 5 -> 0.2
  assert.equal(db.get('t1')!.risk.maxLot, 0.5, 'already at the cap: unchanged');
});

// C-5
test('only the named duplicates and the HFT scalper are deleted, and a second run does nothing', () => {
  const { store, db, ops } = memStore(fixture());
  const first = runCleanup({ store, backup: () => 'b.db' }, { apply: true });
  assert.deepEqual([...db.keys()].sort(), ['gq3', 'real1', 'real2', 't1']);
  assert.deepEqual(first.plan.remove.map((r) => r.id).sort(), ['gq1', 'gq2', 'hft']);
  const opsAfterFirst = ops.length;
  const second = runCleanup({ store, backup: noBackup }, { apply: true });
  assert.equal(second.applied, false);
  assert.equal(ops.length, opsAfterFirst, 'no further writes');
  assert.deepEqual(second.lines, ['Nothing to clean up.']);
});

test('a strategy that is being deleted is not also flagged or clamped', () => {
  const plan = planCleanup([strat('hft', 'M1 HFT EMA Scalp (test)', 'XAUUSD', 5)]);
  assert.equal(plan.remove.length, 1);
  assert.equal(plan.flagTest.length + plan.clampLot.length, 0);
});

test('backupDatabase writes a real, readable copy of the database', () => {
  const s = validStrategy('EURUSD', 'backup-me');
  realStore.save(s);
  const dest = join(mkdtempSync(join(tmpdir(), 'xat-backup-')), 'copy.db');
  backupDatabase(dest);
  assert.ok(existsSync(dest) && statSync(dest).size > 0);
  const copy = new Database(dest, { readonly: true });
  const row = copy.prepare('SELECT id FROM strategies WHERE id = ?').get('backup-me');
  copy.close();
  assert.deepEqual(row, { id: 'backup-me' });
});

// C-7
test('ranking marks a strategy with under 100 trades as unproven and sorts the rest', () => {
  const inputs: RankInput[] = [
    { id: 'a', name: 'A', symbol: 'EURUSD', timeframe: '5m', trades: 99, profitFactor: 3, maxDrawdownPct: 2 },
    { id: 'b', name: 'B', symbol: 'EURUSD', timeframe: '5m', trades: 100, profitFactor: 1.1, maxDrawdownPct: 5 },
    { id: 'c', name: 'C', symbol: 'XAUUSD', timeframe: '15m', trades: 250, profitFactor: 1.6, maxDrawdownPct: 8 },
    { id: 'd', name: 'D', symbol: 'XAUUSD', timeframe: '15m', trades: 300, profitFactor: 0.8, maxDrawdownPct: 15 },
    { id: 'e', name: 'E', symbol: 'GBPUSD', timeframe: '5m', refused: 'No stop-loss' },
  ];
  const rows = rankStrategies(inputs);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'b', 'd', 'a', 'e']);
  assert.deepEqual(rows.map((r) => r.verdict), ['candidate', 'candidate', 'losing', 'unproven', 'refused']);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, null, null]);
  assert.match(rows.find((r) => r.id === 'a')!.note, /only 99 trades/);
  assert.ok(formatRank(rows).length === 6, 'a header plus one line per strategy');
  assert.match(formatRank(rows)[1], /^1\s+C\s/);
});
