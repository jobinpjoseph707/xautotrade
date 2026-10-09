import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../config.js';
import { DEFAULT_RISK, GATE_STAGES, type Strategy } from '../engine/types.js';
import { blankStrategy } from '../engine/presets.js';
import { initSchema, normalizeStrategy, strategies } from '../store.js';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// T-0.2
test('tests never open the real database file', () => {
  assert.equal(config.dbPath, ':memory:');
});

// F-1
test('new risk defaults are maxLot 0.5, minRewardRisk 1.5, maxSpreadToStopRatio 0.15', () => {
  assert.equal(DEFAULT_RISK.maxLot, 0.5);
  assert.equal(DEFAULT_RISK.minRewardRisk, 1.5);
  assert.equal(DEFAULT_RISK.maxSpreadToStopRatio, 0.15);
  assert.equal(DEFAULT_RISK.flatAtUTC, '21:45');
  assert.equal(DEFAULT_RISK.flatBeforeWeekend, true);
});

// F-2
test('a strategy saved before this change still loads and gets the new defaults', () => {
  const legacy = JSON.parse(JSON.stringify(blankStrategy('XAUUSD'))) as Strategy;
  legacy.id = 'legacy-1';
  delete (legacy as Partial<Strategy>).isTest;
  delete (legacy as Partial<Strategy>).gate;
  const risk = legacy.risk as unknown as Record<string, unknown>;
  delete risk.minRewardRisk;
  delete risk.maxSpreadToStopRatio;
  delete risk.flatAtUTC;
  delete risk.flatBeforeWeekend;
  risk.maxLot = 5; // an old saved value must be kept, not overwritten

  const loaded = normalizeStrategy(legacy);
  assert.equal(loaded.isTest, false);
  assert.equal(loaded.gate, 'backtest');
  assert.equal(loaded.risk.minRewardRisk, 1.5);
  assert.equal(loaded.risk.maxSpreadToStopRatio, 0.15);
  assert.equal(loaded.risk.maxLot, 5);
});

// F-3
test('isTest, gate, tier and pausedBy survive a save and load', () => {
  const s = blankStrategy('EURUSD');
  s.id = 'roundtrip-1';
  s.isTest = true;
  s.gate = 'demo';
  s.tier = 3;
  s.pausedBy = 'safety';
  strategies.save(s);
  const back = strategies.get('roundtrip-1');
  assert.ok(back);
  assert.equal(back.isTest, true);
  assert.equal(back.gate, 'demo');
  assert.equal(back.tier, 3);
  assert.equal(back.pausedBy, 'safety');
  assert.ok(strategies.list().some((x) => x.id === 'roundtrip-1'));
});

// F-4
test('gate stages are ordered backtest, paper, demo, live', () => {
  assert.deepEqual([...GATE_STAGES], ['backtest', 'paper', 'demo', 'live']);
});

// F-4
test('starting twice on the same database changes nothing', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'xat-schema-')), 'a.db');
  const first = new Database(file);
  initSchema(first);
  first.prepare("INSERT INTO settings (key, value) VALUES ('k', '\"v\"')").run();
  first.close();
  const second = new Database(file);
  initSchema(second); // the second start
  const rows = second.prepare('SELECT key, value FROM settings').all();
  assert.deepEqual(rows, [{ key: 'k', value: '"v"' }]);
  second.close();
});
