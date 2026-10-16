/**
 * Theory and test (task 3.3). Test IDs P-1 to P-4, P-8 and P-9 are from docs/plan/xautotrade-test-plan.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PaperBroker } from '../broker/paper.js';
import type { ChatBackend } from '../chat/backend.js';
import { fastScalpTest } from '../engine/presets.js';
import type { Strategy } from '../engine/types.js';
import { Evolver, mergeChanges } from './evolve.js';
import type { Lab } from './lab.js';
import { parseTheory, type Disproof, type Theory } from './hypothesis.js';
import { writeOutcomeNote } from './outcomeNote.js';
import { MemoryRecordStore } from './records.js';
import { scoreDue } from './scoring.js';
import { claimSurvivor, openChange, testTheory, TrialRefused, windowsOverlap, type SurvivedTrial, type Trial, type TrialDeps } from './trials.js';
import { DEFAULT_EVOLVE, type ChangeRecord, type EvolveCandidate, type EvolveSettings, type MetricsLite, type Validation } from './types.js';
import { validateOnCandles } from './validate.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 12);

function base(): Strategy {
  const s = fastScalpTest('XAUUSD');
  s.id = 'str_a';
  s.risk = { ...s.risk, slMode: 'points', slPoints: 200, tpMode: 'points', tpPoints: 300 };
  return s;
}
const metrics = (over: Partial<MetricsLite> = {}): MetricsLite => ({ bars: 1000, trades: 50, netProfitPct: 2, profitFactor: 1.4, winRatePct: 52, maxDrawdownPct: 3, ...over });

/** A validation whose unseen window ran from `oosFrom` to `oosTo` and whose result is `after`. */
function validation(oosFrom: number, oosTo: number, after = metrics(), verdict: Validation['verdict'] = 'pass'): Validation {
  return {
    verdict, reasons: [`verdict ${verdict}`],
    inSample: { from: oosTo + 1, to: NOW, before: metrics({ netProfitPct: 1 }), after: metrics({ netProfitPct: 2 }) },
    outOfSample: { from: oosFrom, to: oosTo, before: metrics({ netProfitPct: 1 }), after },
  };
}

const theory = (over: Partial<Theory> = {}): Theory => ({
  id: 't1', strategyId: 'str_a', agent: 'optimizer', claim: 'Stops are too tight in high volatility', changes: { risk: { slPoints: 260 } },
  disproof: { metric: 'profitFactor', op: '<', value: 1 }, checklist: {
    market: 'XAUUSD', timeframe: '1m', marketState: 'volatility high', tier: '3 (Moderate)', evidence: '12 of 20 losses were stopped out within 2 bars',
    change: 'slPoints 200 → 260', wouldProveWrong: 'profitFactor < 1 on unseen bars',
  },
  formedOn: { from: NOW - 14 * DAY, to: NOW }, lessonsUsed: [], ...over,
});

function deps(v: Validation | (() => Promise<never>), store = new MemoryRecordStore<Trial>()): TrialDeps & { store: MemoryRecordStore<Trial> } {
  return {
    store, merge: mergeChanges, now: () => NOW,
    validate: async () => {
      if (typeof v === 'function') return v();
      return { validation: v };
    },
  };
}

// --- P-1 -----------------------------------------------------------------------

test('P-1 a proposal cannot be created without a surviving test', async () => {
  const d = deps(validation(NOW - 40 * DAY, NOW - 15 * DAY));
  const good = await testTheory(theory(), base(), d);
  assert.equal(good.status, 'survived');

  // A plain trial is not a SurvivedTrial: this line does not compile without the directive.
  const plain: Trial = { ...good };
  // @ts-expect-error a Trial that was not produced by a passing test has no survivor brand
  const notBranded: SurvivedTrial = plain;
  void notBranded;

  const claim = (trialId: string, over: Partial<{ strategyId: string; changes: Record<string, unknown> }> = {}, now = NOW) =>
    claimSurvivor(d.store, { trialId, strategyId: 'str_a', changes: { risk: { slPoints: 260 } }, proposalId: 'p1', ...over }, now);

  assert.throws(() => claim('missing'), TrialRefused);
  assert.throws(() => claim(good.id, { strategyId: 'str_b' }), /different strategy/);
  assert.throws(() => claim(good.id, { changes: { risk: { slPoints: 100 } } }), /different change/);
  assert.throws(() => claim(good.id, {}, NOW + 2 * 3_600_000), /too old/);
  assert.equal(claim(good.id).id, good.id);
  assert.throws(() => claim(good.id), /already been used/);

  const dropped = await testTheory(theory({ id: 't2' }), base(), deps(validation(NOW - 40 * DAY, NOW - 15 * DAY, metrics({ profitFactor: 0.7 })), d.store));
  assert.equal(dropped.status, 'dropped');
  assert.throws(() => claim(dropped.id), /did not survive/);
});

// --- P-2 -----------------------------------------------------------------------

test('P-2 the test bars never overlap the bars the theory was formed on', async () => {
  assert.equal(windowsOverlap({ from: 1, to: 5 }, { from: 5, to: 9 }), true);
  assert.equal(windowsOverlap({ from: 1, to: 4 }, { from: 5, to: 9 }), false);

  // Test bars that run into the evidence period: dropped, however well it did.
  const overlapping = await testTheory(theory(), base(), deps(validation(NOW - 20 * DAY, NOW - 10 * DAY)));
  assert.equal(overlapping.status, 'dropped');
  assert.match(overlapping.reasons[0], /overlap/);
  // Bars wholly before it: tested.
  assert.equal((await testTheory(theory(), base(), deps(validation(NOW - 40 * DAY, NOW - 15 * DAY)))).status, 'survived');

  // And the real check, on real candles, built the way Lab.validateSince builds it: the "seen" window is
  // the evidence period, so the unseen bars end before it begins.
  const broker = new PaperBroker();
  await broker.connect();
  const candles = await broker.getCandles('XAUUSD', '1m', 4000);
  const spec = await broker.getSymbolSpec('XAUUSD');
  const evidenceFrom = candles[3000].time;
  const inSampleBars = candles.filter((c) => c.time >= evidenceFrom).length;
  const s = base();
  const v = validateOnCandles({ before: s, after: s, candles, spec, opts: { inSampleBars } });
  assert.ok(v.outOfSample && v.inSample);
  assert.ok(v.outOfSample!.to < evidenceFrom, 'unseen bars end before the evidence period starts');
  assert.ok(v.inSample!.from >= evidenceFrom);
});

// --- P-3 -----------------------------------------------------------------------

test('P-3 a theory that meets its own "this would prove me wrong" line is dropped and recorded as an attempt', async () => {
  const d = deps(validation(NOW - 40 * DAY, NOW - 15 * DAY, metrics({ profitFactor: 0.9 })));
  const t = await testTheory(theory(), base(), d);
  assert.equal(t.status, 'dropped');
  assert.match(t.reasons[0], /met its own disproof line/);
  const kept = d.store.get(t.id)!;
  assert.equal(kept.status, 'dropped', 'the attempt is on record');
  assert.equal(kept.theory.claim, theory().claim);

  // The same result against a looser line survives.
  const loose: Disproof = { metric: 'profitFactor', op: '<', value: 0.5 };
  assert.equal((await testTheory(theory({ disproof: loose }), base(), deps(validation(NOW - 40 * DAY, NOW - 15 * DAY, metrics({ profitFactor: 0.9 })), d.store))).status, 'survived');

  // A test that cannot run is recorded too, and is not a survivor.
  const broken = await testTheory(theory(), base(), deps(async () => { throw new Error('no candles'); }, d.store));
  assert.equal(broken.status, 'untestable');
  assert.equal(d.store.all().length, 3);
});

test('a theory is refused when a part is missing', () => {
  const ctx = { strategy: base(), agent: 'optimizer', id: 'x', formedOn: { from: 1, to: 2 }, known: { market: 'XAUUSD', timeframe: '1m', marketState: 's', tier: '3' }, lessonsUsed: [] };
  const full = { claim: 'c', changes: { risk: { slPoints: 1 } }, disproof: { metric: 'profitFactor', op: '<', value: 1 }, checklist: { evidence: 'e', change: 'ch' } };
  assert.ok('theory' in parseTheory(full, ctx));
  assert.match((parseTheory({ ...full, claim: '' }, ctx) as { error: string }).error, /claim/);
  assert.match((parseTheory({ ...full, changes: {} }, ctx) as { error: string }).error, /one change/);
  assert.match((parseTheory({ ...full, disproof: undefined }, ctx) as { error: string }).error, /prove me wrong/);
  assert.match((parseTheory({ ...full, disproof: { metric: 'luck', op: '<', value: 1 } }, ctx) as { error: string }).error, /metric/);
  assert.match((parseTheory({ ...full, checklist: { change: 'ch' } }, ctx) as { error: string }).error, /evidence/);
  // The four facts the server knows are taken from the server, not from the agent.
  const t = (parseTheory({ ...full, checklist: { evidence: 'e', change: 'ch', market: 'EURUSD', tier: '1' } }, ctx) as { theory: Theory }).theory;
  assert.equal(t.checklist.market, 'XAUUSD');
  assert.equal(t.checklist.tier, '3');
  assert.equal(Object.keys(t.checklist).length, 7);
});

// --- P-4 -----------------------------------------------------------------------

function record(over: Partial<ChangeRecord>): ChangeRecord {
  return {
    id: Math.random().toString(36).slice(2), createdAt: NOW, source: 'agent', agent: 'optimizer', model: 'x', actionType: 'update_strategy', strategyId: 'str_a',
    symbol: 'XAUUSD', timeframe: '1m', summary: 's', signatures: ['risk.slPoints:up'], before: null, after: null, warnings: [], status: 'approved', score: 'pending', scoreReasons: [], ...over,
  };
}

test('P-4 a strategy with one change waiting to be scored gets no second change', () => {
  assert.equal(openChange([], 'str_a'), null);
  assert.ok(openChange([record({})], 'str_a'), 'approved and not scored yet');
  assert.ok(openChange([record({ status: 'pending' })], 'str_a'), 'still waiting in the Inbox');
  assert.equal(openChange([record({ score: 'helped' })], 'str_a'), null, 'scored: free again');
  assert.equal(openChange([record({ status: 'rejected' })], 'str_a'), null);
  assert.equal(openChange([record({})], 'str_b'), null, 'another strategy is not blocked');
  assert.equal(openChange([record({ actionType: 'stop_bot' })], 'str_a'), null);
});

// --- P-8 -----------------------------------------------------------------------

const DEFAULT: EvolveSettings = { ...DEFAULT_EVOLVE, enabled: true, strategyIds: ['str_a'] };

function evolveRig(opts: { validation: Validation; changes?: ChangeRecord[] }) {
  const parent = base();
  const db = new Map([[parent.id, parent]]);
  const changes = new MemoryRecordStore<ChangeRecord>();
  for (const c of opts.changes ?? []) changes.put(c);
  const trialStore = new MemoryRecordStore<Trial>();
  const candidates = new MemoryRecordStore<EvolveCandidate>();
  const reply: ChatBackend = {
    name: 'fake',
    complete: async () => `Try wider.\n\`\`\`xat-actions\n${JSON.stringify([{ type: 'update_strategy', id: 'str_a', reason: 'wider stop', changes: { risk: { slPoints: 260 } } }])}\n\`\`\``,
  };
  const lab = { validate: async () => { throw new Error('the old path must not be used'); } } as unknown as Lab;
  let settings = DEFAULT;
  const ev = new Evolver({
    backend: reply, lab, candidates, changes, now: () => NOW,
    host: { list: () => [...db.values()], get: (id) => structuredClone(db.get(id) ?? null), save: (s) => { db.set(s.id, s); return s; }, reload: () => undefined },
    getSettings: () => settings, setSettings: (s) => { settings = s; },
    trial: (th, p) => testTheory(th, p, { store: trialStore, merge: mergeChanges, now: () => NOW, validate: async () => ({ validation: opts.validation }) }),
  });
  return { ev, trialStore, candidates, changes };
}

test('P-8 auto-evolve goes through the same test path', async () => {
  const pass = evolveRig({ validation: validation(NOW - 40 * DAY, NOW - 15 * DAY) });
  const ok = await pass.ev.runCycle(true);
  assert.equal(ok.created.length, 1);
  assert.equal(pass.trialStore.all().length, 1, 'the variant was tested as a theory and the attempt kept');
  assert.equal(pass.trialStore.all()[0].status, 'survived');
  assert.equal(ok.created[0].rationale?.checklist.market, 'XAUUSD');
  assert.equal(Object.keys(ok.created[0].rationale!.checklist).length, 7);

  // A variant that loses on unseen bars (profit factor under 1, its own disproof) is dropped, never tested forward.
  const bad = evolveRig({ validation: validation(NOW - 40 * DAY, NOW - 15 * DAY, metrics({ profitFactor: 0.8 })) });
  const res = await bad.ev.runCycle(true);
  assert.equal(res.created.length, 0);
  assert.equal(bad.trialStore.all()[0].status, 'dropped');
  assert.match(res.skipped.join(' '), /held back/);
  assert.equal(bad.candidates.all().length, 0);

  // One change at a time, here too.
  const waiting = evolveRig({ validation: validation(NOW - 40 * DAY, NOW - 15 * DAY), changes: [record({})] });
  const w = await waiting.ev.runCycle(true);
  assert.equal(w.created.length, 0);
  assert.match(w.skipped.join(' '), /already waiting/);
  assert.equal(waiting.trialStore.all().length, 0, 'no model call and no test was spent');
});

// --- P-9 -----------------------------------------------------------------------

test('P-9 the one-line reason is written after scoring, never before', async () => {
  const changes = new MemoryRecordStore<ChangeRecord>();
  const rec = record({
    id: 'c1', decidedAt: 0, rationale: { trialId: 't', claim: 'Stops are too tight in high volatility', checklist: theory().checklist, disproof: 'x', lessonsUsed: [] },
  });
  changes.put(rec);
  assert.equal(changes.get('c1')!.outcomeNote, undefined, 'nothing is written when the change is made');
  assert.throws(() => writeOutcomeNote(rec), /only after it has been scored/);

  const waiting = await scoreDue(changes, { profits: () => Array.from({ length: 10 }, () => 1), now: 5 * DAY, cfg: { minAgeMs: DAY, maxAgeMs: 45 * DAY, minTrades: 30 } });
  assert.equal(waiting.waiting, 1);
  assert.equal(changes.get('c1')!.outcomeNote, undefined, 'still waiting for 30 trades: still no explanation');

  const ups = Array.from({ length: 30 }, (_, i) => 2 + (i % 2 ? 0.1 : -0.1));
  const downs = Array.from({ length: 30 }, (_, i) => -1 + (i % 2 ? 0.1 : -0.1));
  await scoreDue(changes, { profits: (_id, from) => (from >= 0 ? ups : downs), now: 5 * DAY, cfg: { minAgeMs: DAY, maxAgeMs: 45 * DAY, minTrades: 30 } });
  const done = changes.get('c1')!;
  assert.equal(done.score, 'helped');
  assert.match(done.outcomeNote!, /^Helped: Stops are too tight in high volatility/);
  assert.match(done.outcomeNote!, /After 30 demo trades the average was \+2\.00/);
});
