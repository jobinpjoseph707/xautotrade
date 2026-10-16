/**
 * The lesson ledger: what counts as evidence, when a lesson is trusted, and what an agent may see.
 * Test IDs L-3 to L-12 are from docs/plan/xautotrade-test-plan.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatService } from '../chat/service.js';
import { fastScalpTest } from '../engine/presets.js';
import type { Strategy, Timeframe } from '../engine/types.js';
import { buildLedger, marketState, outcomesFrom } from './ledger.js';
import { MemoryRecordStore } from './records.js';
import { MAX_CHARS, MAX_ROWS, retrieve } from './retrieve.js';
import type { ChangeRecord, MarketSnapshot } from './types.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);

const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  symbol: 'XAUUSD', timeframe: '1m', bars: 500, atrPct: 0.02, trendPct: 0.5, avgSpreadPoints: 20, ...over,
});

let n = 0;
/** A scored, approved change with its evidence. Defaults: optimizer, XAUUSD 1m, mid/mid/mid, tightened stop, hurt, 30 trades, just now. */
function outcome(over: Partial<ChangeRecord> & { trades?: number; ageDays?: number; snapshot?: MarketSnapshot } = {}): ChangeRecord {
  const { trades = 30, ageDays = 0, snapshot, ...rest } = over;
  const at = NOW - ageDays * DAY;
  const market = snapshot ?? snap();
  return {
    id: `o${++n}`, createdAt: at, source: 'chat', agent: 'optimizer', model: 'fake', actionType: 'update_strategy',
    strategyId: 'str_a', symbol: market.symbol, timeframe: market.timeframe, summary: 's',
    signatures: ['risk.slPoints:down'], before: null, after: null, warnings: [], status: 'approved', score: 'hurt',
    scoreReasons: [], market, decidedAt: at, scoredAt: at,
    followUp: { measuredAt: at, demo: { from: 0, to: 1, trades, netProfit: -5 } },
    ...rest,
  };
}
const many = (k: number, over: Parameters<typeof outcome>[0] = {}): ChangeRecord[] => Array.from({ length: k }, () => outcome(over));
const scope = (over: Partial<{ agent: string; symbol: string; timeframe: Timeframe; market: MarketSnapshot | null }> = {}) => ({
  agent: 'optimizer', symbol: 'XAUUSD', timeframe: '1m' as Timeframe, market: snap(), ...over,
});

test('L-3 a gold lesson never reaches a EURUSD strategy', () => {
  const history = many(5);
  assert.equal(retrieve(history, scope(), NOW).rows.length, 1, 'control: the lesson is visible in its own market');
  const eur = retrieve(history, scope({ symbol: 'EURUSD', market: snap({ symbol: 'EURUSD' }) }), NOW);
  assert.deepEqual(eur.rows, []);
  assert.equal(eur.matched, 0);
});

test('L-4 a 1-minute lesson never reaches a 5-minute strategy', () => {
  const history = many(5);
  const five = retrieve(history, scope({ timeframe: '5m', market: snap({ timeframe: '5m', atrPct: 0.045 }) }), NOW);
  assert.deepEqual(five.rows, []);
});

test('L-5 market state comes from the saved snapshot, with the edges worked by hand', () => {
  const st = (o: Partial<MarketSnapshot>) => marketState(snap(o))!;
  // volatility = atrPct / sqrt(minutes): on 1m the edges are 0.01 and 0.025
  assert.equal(st({ atrPct: 0.0099 }).volatility, 'low');
  assert.equal(st({ atrPct: 0.01 }).volatility, 'mid');
  assert.equal(st({ atrPct: 0.0249 }).volatility, 'mid');
  assert.equal(st({ atrPct: 0.025 }).volatility, 'high');
  // a 5-minute bar is divided by sqrt(5) = 2.236: 0.022 -> 0.00984 (low), 0.0224 -> 0.01002 (mid)
  assert.equal(st({ timeframe: '5m', atrPct: 0.022 }).volatility, 'low');
  assert.equal(st({ timeframe: '5m', atrPct: 0.0224 }).volatility, 'mid');
  // trend counts the size of the move, either way: edges 0.3 and 1
  assert.equal(st({ trendPct: -0.29 }).trend, 'low');
  assert.equal(st({ trendPct: -0.3 }).trend, 'mid');
  assert.equal(st({ trendPct: 0.99 }).trend, 'mid');
  assert.equal(st({ trendPct: -1 }).trend, 'high');
  // spread edges 15 and 35 points
  assert.equal(st({ avgSpreadPoints: 14.9 }).spread, 'low');
  assert.equal(st({ avgSpreadPoints: 15 }).spread, 'mid');
  assert.equal(st({ avgSpreadPoints: 34.9 }).spread, 'mid');
  assert.equal(st({ avgSpreadPoints: 35 }).spread, 'high');
  // no spread reading: no market state, so no lesson can be keyed
  assert.equal(marketState(snap({ avgSpreadPoints: null })), null);
  assert.equal(marketState(null), null);
});

test('L-6 an outcome resting on 29 trades is ignored; 30 counts', () => {
  const a = outcomesFrom([outcome({ trades: 29 })]);
  assert.equal(a.outcomes.length, 0);
  assert.match(a.ignored[0].why, /only 29 trades/);
  assert.equal(outcomesFrom([outcome({ trades: 30 })]).outcomes.length, 1);
});

test('L-7 four agreeing outcomes are not a lesson; five are', () => {
  assert.equal(buildLedger(many(4), NOW).lessons[0].trusted, false);
  assert.equal(retrieve(many(4), scope(), NOW).rows.length, 0);
  assert.equal(buildLedger(many(5), NOW).lessons[0].trusted, true);
  assert.equal(retrieve(many(5), scope(), NOW).rows.length, 1);
});

test('L-8 five outcomes from 60 days ago no longer count as trusted', () => {
  const old = buildLedger(many(5, { ageDays: 60 }), NOW).lessons[0];
  // 0.5^(60/14) = 0.051 each, five of them = 0.26, far under the 2.5 needed
  assert.ok(old.weightAgree < 0.3);
  assert.equal(old.agree, 5);
  assert.equal(old.trusted, false);
  // the same five at 14 days (half weight, 2.5 in all) are still just enough
  assert.equal(buildLedger(many(5, { ageDays: 14 }), NOW).lessons[0].trusted, true);
  // and structural settings fade more slowly: 90-day half-life
  const structural = buildLedger(many(5, { ageDays: 60, signatures: ['rules.entry:changed'] }), NOW).lessons[0];
  assert.equal(structural.trusted, true);
});

test('L-9 new outcomes that disagree take trust away', () => {
  const trusted = many(5);
  assert.equal(buildLedger(trusted, NOW).lessons[0].trusted, true);
  const disputed = [...trusted, ...many(3, { score: 'helped' })];
  const l = buildLedger(disputed, NOW).lessons[0];
  assert.equal(l.agree, 5);
  assert.equal(l.against, 3);
  assert.ok(l.share < 0.75, `share ${l.share}`);
  assert.equal(l.trusted, false);
  assert.equal(retrieve(disputed, scope(), NOW).rows.length, 0);
});

const SL_DOWN_HURT = { signatures: ['risk.slPoints:down'], score: 'hurt' as const };
const SL_UP_HURT = { signatures: ['risk.slPoints:up'], score: 'hurt' as const };

test('L-10 two trusted lessons that disagree on a setting give HOLD', () => {
  // Tightening hurt (so: go wider) and widening hurt (so: go tighter): they cannot both be followed.
  const history = [...many(5, SL_DOWN_HURT), ...many(5, SL_UP_HURT), ...many(5, { signatures: ['risk.fixedLot:down'], score: 'helped' })];
  const got = retrieve(history, scope(), NOW);
  assert.deepEqual(got.holds.map((h) => h.setting), ['risk.slPoints']);
  assert.ok(got.rows[0].includes('HOLD'));
  assert.ok(!got.rows.some((r) => r.includes('setting=risk.slPoints | change')), 'no advice is given on the held setting');
  assert.ok(got.rows.some((r) => r.includes('setting=risk.fixedLot')), 'other settings are unaffected');
});

test('L-10 no proposal can be made on a held setting', async () => {
  const host = (() => {
    const db = new Map<string, Strategy>();
    const s: Strategy = fastScalpTest('XAUUSD');
    s.id = 'str_a';
    s.risk = { ...s.risk, slMode: 'points', slPoints: 200, tpMode: 'points', tpPoints: 300 };
    db.set(s.id, s);
    return {
      list: () => [...db.values()], get: (id: string) => structuredClone(db.get(id) ?? null), save: (x: Strategy) => { db.set(x.id, x); return x; },
      remove: (id: string) => { db.delete(id); }, reload: () => undefined, start: async () => undefined, stop: () => undefined,
    };
  })();
  const changes = new MemoryRecordStore<ChangeRecord>();
  for (const r of [...many(5, SL_DOWN_HURT), ...many(5, SL_UP_HURT)]) changes.put(r);
  const reply = (changes_: object) => `x\n\`\`\`xat-actions\n${JSON.stringify([{ type: 'update_strategy', id: 'str_a', reason: 'r', changes: changes_ }])}\n\`\`\``;
  let next = reply({ risk: { slPoints: 150 } });
  const svc = new ChatService({
    backend: { name: 'fake', complete: async () => next },
    host, bots: () => [], issues: () => [],
    learning: { changes, critic: 'off', market: async () => snap(), now: () => NOW },
  });
  const held = await svc.chat({ agent: 'optimizer', message: 'tune' });
  assert.equal(held.proposals.length, 0);
  assert.match(held.rejected.join(' '), /disagree about risk\.slPoints/);
  assert.ok(changes.all(100).some((r) => r.status === 'blocked' && r.signatures.includes('risk.slPoints:down')), 'the held-back proposal is recorded');

  // A different setting still goes through.
  next = reply({ risk: { tpPoints: 250 } });
  const ok = await svc.chat({ agent: 'optimizer', message: 'tune' });
  assert.equal(ok.proposals.length, 1, ok.rejected.join(' | '));
});

test('L-11 there is no all-markets lesson and no lesson shared between agents', () => {
  const history = [...many(5), ...many(5, { agent: 'doctor' }), ...many(5, { snapshot: snap({ atrPct: 0.05 }) })];
  const { lessons } = buildLedger(history, NOW);
  assert.equal(lessons.length, 3, 'one lesson per agent and market state, never merged');
  assert.ok(lessons.every((l) => l.key.includes('|vol:') && l.key.includes('|trend:') && l.key.includes('|spread:')));
  // same market, different agent: nothing
  assert.deepEqual(retrieve(many(5), scope({ agent: 'guard' }), NOW).rows, []);
  // same agent and symbol and timeframe, different market state (volatility high): only its own lesson
  const high = retrieve(history, scope({ market: snap({ atrPct: 0.05 }) }), NOW);
  assert.equal(high.rows.length, 1);
  assert.equal(high.matched, 1);
  // a strategy whose market cannot be read gets nothing at all
  assert.deepEqual(retrieve(history, scope({ market: null }), NOW).rows, []);
});

test('L-12 200 lessons in scope give 10 rows, in the same order every time, under the size cap', () => {
  const history: ChangeRecord[] = [];
  for (let i = 0; i < 200; i++) history.push(...many(5, { signatures: [`ind.ema${String(i).padStart(3, '0')}.period:down`] }));
  assert.equal(buildLedger(history, NOW).lessons.filter((l) => l.trusted).length, 200);
  const a = retrieve(history, scope(), NOW);
  assert.equal(a.matched, 200);
  assert.equal(a.rows.length, MAX_ROWS);
  assert.ok(a.rows.join('\n').length <= MAX_CHARS);
  const b = retrieve([...history].reverse(), scope(), NOW);
  assert.deepEqual(b.rows, a.rows, 'record order does not change the rows');
  assert.deepEqual(retrieve(history, scope(), NOW).rows, a.rows, 'same answer every time');
  // the size cap bites before the row cap when rows are long
  const longRows = [] as ChangeRecord[];
  for (let i = 0; i < 20; i++) longRows.push(...many(5, { signatures: [`ind.${'x'.repeat(150)}${i}.period:down`] }));
  const c = retrieve(longRows, scope(), NOW);
  assert.ok(c.rows.length < MAX_ROWS);
  assert.ok(c.rows.join('\n').length <= MAX_CHARS);
});
