import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emaPullbackScalp } from '../engine/presets.js';
import type { BacktestTrade } from '../engine/types.js';
import { diagnose } from './diagnose.js';
import { legacyLessonFrom, migrateLegacyLessonFile, migrateLegacyLessons, type LegacyLesson } from './legacy.js';
import { proposeNextConfig } from './propose.js';
import { MemoryRecordStore } from './records.js';

const MON = Date.UTC(2026, 8, 14);
const H = 3_600_000;
const bt = (id: number, hour: number, net: number): BacktestTrade => ({
  id, side: 'long', lots: 0.1, openTime: MON + hour * H, openPrice: 2000, closeTime: MON + (hour + 1) * H, closePrice: 2001,
  sl: null, tp: null, reason: net > 0 ? 'tp' : 'sl', grossProfit: net, commission: 0, netProfit: net, balanceAfter: 0,
  maxFavourablePoints: 0, maxAdversePoints: 0, barsHeld: 12,
});

/** An entry in exactly the shape the old rotation wrote to data/lessons.json. */
function oldEntry(n: number, symbol: string | null, timeframe: string | null = '5m'): unknown {
  const strategy = emaPullbackScalp('XAUUSD');
  strategy.risk = { ...strategy.risk, sessions: [], tradingDays: [], maxSpreadPoints: 25 };
  const trades = [bt(1, 2, -50), bt(2, 3, -40), bt(3, 4, -60), bt(4, 8, 30), bt(5, 9, 20)];
  const weekStart = new Date(MON + n * 7 * 24 * H).toISOString();
  const d = diagnose(
    { id: `agent-${n}:${weekStart}`, from: weekStart, to: weekStart, strategy, verdict: 'fail', returnPct: -1.7, maxDrawdownPct: 2.5, criteria: { minReturnPct: 2, maxDrawdownPct: 5 } },
    { startingBalance: 10_000, endingBalance: 9_830, equityCurve: [{ time: MON, equity: 10_000 }, { time: MON + 3 * 24 * H, equity: 9_800 }], tradeCount: trades.length, trades },
  );
  const { id, from, to, ...rest } = d;
  const lesson = { ...rest, lessonId: id, agentId: `agent-${n}`, generation: n + 1, weekStart: from, weekEnd: to, strategy: { ...d.strategy, symbol, timeframe } };
  if (symbol === null) delete (lesson.strategy as Record<string, unknown>).symbol;
  if (timeframe === null) delete (lesson.strategy as Record<string, unknown>).timeframe;
  return { lesson, proposal: proposeNextConfig(strategy, d), createdAt: weekStart };
}

// L-1
test('L-1 every old lesson is carried over, and one with no market becomes display-only', () => {
  const entries: unknown[] = [
    oldEntry(0, 'XAUUSD'),
    oldEntry(1, 'XAUUSD'),
    oldEntry(2, 'EURUSD', '1m'),
    oldEntry(3, null), // the old record did not say which market
    oldEntry(4, 'XAUUSD', null), // no timeframe either: still no usable market
    null, // a damaged entry is kept too, not dropped
  ];
  const store = new MemoryRecordStore<LegacyLesson>();
  const r = migrateLegacyLessons(entries, store);
  assert.equal(r.found, 6);
  assert.equal(store.all().length, 6, 'count in = count out');
  assert.equal(r.written, 6);
  assert.equal(r.displayOnly, 3);

  const rows = store.all();
  const byMarket = rows.filter((l) => l.market).map((l) => `${l.market!.symbol} ${l.market!.timeframe}`).sort();
  assert.deepEqual(byMarket, ['EURUSD 1m', 'XAUUSD 5m', 'XAUUSD 5m']);
  assert.ok(rows.filter((l) => !l.market).every((l) => l.displayOnly), 'no market -> display-only');
  assert.ok(rows.filter((l) => l.market).every((l) => !l.displayOnly));
  const first = rows.find((l) => l.market?.symbol === 'EURUSD')!;
  assert.equal(first.rootCause, 'SESSION_CLUSTER');
  assert.match(first.summary, /losses came in the asia session/);
  assert.match(first.change ?? '', /exclude asia hours/i);

  // Running it again writes nothing new.
  const again = migrateLegacyLessons(entries, store);
  assert.equal(again.written, 0);
  assert.equal(store.all().length, 6);
});

test('L-1b the old file is moved aside, not deleted, and a broken file is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xat-legacy-'));
  const path = join(dir, 'lessons.json');
  const store = new MemoryRecordStore<LegacyLesson>();
  assert.equal(migrateLegacyLessonFile(path, store), null, 'no file, nothing to do');

  writeFileSync(path, JSON.stringify([oldEntry(0, 'XAUUSD'), oldEntry(1, null)]));
  const r = migrateLegacyLessonFile(path, store);
  assert.deepEqual([r!.found, r!.written, r!.displayOnly], [2, 2, 1]);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.migrated`), true, 'the original stays on disk');

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.throws(() => migrateLegacyLessonFile(broken, store));
  assert.equal(existsSync(broken), true, 'nothing is moved when it cannot be read');
  writeFileSync(broken, '{"not":"a list"}');
  assert.throws(() => migrateLegacyLessonFile(broken, store), /not a list/);
  assert.equal(existsSync(broken), true);
  assert.equal(legacyLessonFrom('garbage', 7).displayOnly, true);
});

// L-2
test('L-2 package.json has no agents:weekly script and nothing imports the deleted files', () => {
  const serverDir = fileURLToPath(new URL('../..', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(Object.hasOwn(pkg.scripts, 'agents:weekly'), false);
  assert.ok(!Object.values(pkg.scripts).some((s) => /agents\/|weekly/.test(s)), 'no script runs the old code');

  const src = join(serverDir, 'src');
  assert.equal(existsSync(join(src, 'agents')), false, 'the agents/ folder is gone');
  const DELETED = ['rotation', 'lessonStore', 'paperRunner', 'weekly', 'lessons', 'store', 'types', 'evaluate'];
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) {
        for (const m of readFileSync(full, 'utf8').matchAll(/from\s+'([^']*agents\/([^']*))'/g)) {
          if (DELETED.some((d) => m[2].replace(/\.js$/, '') === d) || m[1].includes('agents/')) bad.push(`${relative(src, full).split(sep).join('/')} imports ${m[1]}`);
        }
      }
    }
  };
  walk(src);
  assert.deepEqual(bad, []);
});
