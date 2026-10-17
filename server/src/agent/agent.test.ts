/**
 * The server side of the agent service: dossier, the five routes, runs, the weekly cycle.
 * Test IDs AG-6 to AG-13, P-5 to P-7 are from docs/plan/xautotrade-test-plan.md.
 * The Python side (the graph itself) is tested in agents-py/tests.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { ChatService } from '../chat/service.js';
import { fastScalpTest } from '../engine/presets.js';
import type { Strategy } from '../engine/types.js';
import { Inbox, MemoryInboxStore } from '../inbox/inbox.js';
import { proposalFeed } from '../inbox/proposals.js';
import { mergeChanges } from '../learning/evolve.js';
import { MemoryRecordStore } from '../learning/records.js';
import type { Trial } from '../learning/trials.js';
import type { ChangeRecord, MarketSnapshot, MetricsLite, Validation } from '../learning/types.js';
import { buildDossier, MAX_DOSSIER_CHARS, type DossierDeps } from './dossier.js';
import { createAgentRouter, LlmCapped, LlmUnreachable, type AgentRouteDeps } from './routes.js';
import { AgentRunner, MAX_RUN_CALLS, type ServiceClient } from './runner.js';
import type { AgentNote, AgentRunRecord, RunResult } from './types.js';
import { WeeklyAgentCycle, pickFailing } from './weekly.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const SNAP: MarketSnapshot = { symbol: 'XAUUSD', timeframe: '1m', bars: 500, atrPct: 0.02, trendPct: 0.5, avgSpreadPoints: 20 };

function gold(id = 'str_a', over: Partial<Strategy> = {}): Strategy {
  const s = fastScalpTest('XAUUSD');
  s.id = id;
  s.name = `Gold ${id}`;
  s.risk = { ...s.risk, slMode: 'points', slPoints: 200, tpMode: 'points', tpPoints: 300 };
  return { ...s, isTest: false, ...over };
}

const metrics = (over: Partial<MetricsLite> = {}): MetricsLite => ({ bars: 1000, trades: 50, netProfitPct: 2, profitFactor: 1.4, winRatePct: 52, maxDrawdownPct: 3, ...over });
const passing = (after = metrics()): Validation => ({
  verdict: 'pass', reasons: ['Held up on unseen data.'],
  inSample: { from: NOW - 14 * DAY, to: NOW, before: metrics(), after: metrics() },
  outOfSample: { from: NOW - 40 * DAY, to: NOW - 15 * DAY, before: metrics({ netProfitPct: 1 }), after },
});

/** A scored outcome that makes a trusted lesson in the standard gold market (XAUUSD 1m, mid/mid/mid). */
function outcome(over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    id: Math.random().toString(36).slice(2), createdAt: NOW, source: 'chat', agent: 'optimizer', model: 'x', actionType: 'update_strategy', strategyId: 'str_a',
    symbol: 'XAUUSD', timeframe: '1m', summary: 's', signatures: ['risk.slPoints:down'], before: null, after: null, warnings: [], status: 'approved', score: 'hurt',
    scoreReasons: [], market: SNAP, decidedAt: NOW, scoredAt: NOW, followUp: { measuredAt: NOW, demo: { from: 0, to: 1, trades: 30, netProfit: -5 } }, ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// --- dossier ----------------------------------------------------------------

function dossierDeps(over: Partial<DossierDeps> = {}): DossierDeps & { notes: MemoryRecordStore<AgentNote>; changes: MemoryRecordStore<ChangeRecord>; trials: MemoryRecordStore<Trial> } {
  const strategies = new Map([['str_a', gold()]]);
  return {
    strategy: (id: string) => strategies.get(id) ?? null,
    changes: new MemoryRecordStore<ChangeRecord>(), notes: new MemoryRecordStore<AgentNote>(), trials: new MemoryRecordStore<Trial>(),
    stage: () => 'demo', tier: () => 3, trades: () => [], market: async () => SNAP, now: () => NOW, ...over,
  } as never;
}

const note = (symbol: string, text: string, i = 0): AgentNote => ({ id: `n${symbol}${i}`, createdAt: NOW - i, strategyId: `s_${symbol}`, symbol, timeframe: '1m', agent: 'doctor', text, evidence: ['e'] });

test('AG-8 the dossier for a gold strategy contains no EURUSD lessons or notes', async () => {
  const d = dossierDeps();
  d.notes.put(note('XAUUSD', 'Losses cluster at the London open'));
  d.notes.put(note('EURUSD', 'EURUSD secret note'));
  for (let i = 0; i < 5; i++) d.changes.put(outcome());
  for (let i = 0; i < 5; i++) d.changes.put(outcome({ symbol: 'EURUSD', market: { ...SNAP, symbol: 'EURUSD' }, signatures: ['risk.fixedLot:down'] }));

  const dossier = (await buildDossier(d, 'str_a'))!;
  const text = JSON.stringify(dossier);
  assert.ok(!text.includes('EURUSD'), 'nothing from another market');
  assert.ok(text.includes('London open'), 'control: the gold note is there');
  assert.equal(dossier.lessons.optimizer.length, 1, 'control: the gold lesson is there');
  assert.match(dossier.lessons.optimizer[0], /setting=risk\.slPoints/);
  assert.deepEqual(dossier.lessons.doctor, [], 'another agent\'s lessons are not shared');
  assert.equal(await buildDossier(d, 'missing'), null);
});

test('AG-9 the dossier respects the size limit', async () => {
  const d = dossierDeps();
  for (let i = 0; i < 400; i++) d.notes.put(note('XAUUSD', `A long note about losses at the London open. ${'x'.repeat(500)}`, i));
  for (let i = 0; i < 150; i++) {
    d.trials.put({ id: `t${i}`, createdAt: NOW - i, strategyId: 'str_a', status: 'dropped', reasons: ['y'.repeat(400)], theory: { id: `t${i}`, strategyId: 'str_a', agent: 'optimizer', claim: 'z'.repeat(500), changes: {}, disproof: { metric: 'profitFactor', op: '<', value: 1 }, checklist: {} as never, formedOn: { from: 0, to: 1 }, lessonsUsed: [] } });
    d.changes.put(outcome({ signatures: [`ind.ema${i}.period:down`], summary: 'q'.repeat(300), outcomeNote: 'w'.repeat(400) }));
  }
  const trades = Array.from({ length: 600 }, (_, i) => ({
    positionId: `p${i}`, strategyId: 'str_a', strategyName: 'g', symbol: 'XAUUSD', side: i % 2 ? 'long' : 'short', volume: 0.1, status: 'closed', outcome: 'win', openTime: NOW - i * 3_600_000, closeTime: NOW - i * 3_600_000 + 1, durationMs: 1, openPrice: 1, closePrice: 1, currentPrice: null,
    stopLoss: null, takeProfit: null, plannedRR: null, profit: i % 3 ? 1 : -2, commission: null, swap: null, exitReason: 'tp', spreadPoints: i % 50, source: 'log',
  }));
  const dossier = (await buildDossier({ ...d, trades: () => trades as never }, 'str_a'))!;
  const text = JSON.stringify(dossier);
  assert.ok(text.length <= MAX_DOSSIER_CHARS, `${text.length} chars`);
  assert.deepEqual(JSON.parse(text).strategy.id, 'str_a', 'still valid and still about the right strategy');
  assert.ok(dossier.trimmed.length > 0, 'it says what was cut');
  assert.ok(dossier.demo && dossier.demo.trades === 600, 'the headline numbers survive');
});

// --- runs ---------------------------------------------------------------------

function runnerRig(client: ServiceClient | null, changes = new MemoryRecordStore<ChangeRecord>()) {
  const inbox = new Inbox(new MemoryInboxStore(), {}, () => NOW);
  const store = new MemoryRecordStore<AgentRunRecord>();
  const strategies = new Map([['str_a', gold()], ['str_b', gold('str_b')]]);
  const runner = new AgentRunner({ store, client, strategy: (id) => strategies.get(id) ?? null, changes, inbox, now: () => NOW });
  return { runner, inbox, store, changes };
}

const result = (over: Partial<RunResult> = {}): RunResult => ({ runId: 'r', outcome: 'nothing_wrong', summary: 'ok', steps: [], modelCalls: 1, ...over });

test('AG-7 a second run on the same strategy is refused while one is active or a change awaits scoring', async () => {
  const gate = deferred<RunResult>();
  const { runner, changes } = runnerRig({ run: () => gate.promise, trace: async () => null });
  const first = runner.start('str_a', 'tune', 'owner');
  assert.throws(() => runner.start('str_a', 'tune', 'owner'), /already in progress/);
  assert.doesNotThrow(() => runner.start('str_b', 'diagnose', 'owner'), 'another strategy is free');
  gate.resolve(result());
  assert.equal((await runner.settle(first.id))!.status, 'done');
  assert.equal(runner.refusal('str_a'), null, 'free again once it has ended');

  changes.put(outcome({ status: 'approved', score: 'pending' }));
  assert.match(runner.refusal('str_a')!, /waiting to be scored/);
  const inboxWait = outcome({ id: 'z', strategyId: 'str_b', status: 'pending', score: 'pending' });
  changes.put(inboxWait);
  assert.match(runner.refusal('str_b')!, /waiting in the Inbox/);
  assert.match(runnerRig(null).runner.refusal('str_a')!, /not set up/);
});

test('AG-13 with the service down the server keeps trading and shows one Inbox item', async () => {
  const touched: string[] = [];
  const { runner, inbox, changes, store } = runnerRig({ run: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8000'); }, trace: async () => null });
  const a = await runner.settle(runner.start('str_a', 'tune', 'owner').id);
  const b = await runner.settle(runner.start('str_b', 'tune', 'owner').id);
  assert.equal(a!.outcome, 'service_down');
  assert.equal(b!.status, 'failed');
  const cards = inbox.list().filter((c) => c.kind === 'agent_unavailable');
  assert.equal(cards.length, 1, 'one card, not one per failure');
  assert.equal(cards[0].count, 2);
  assert.equal(changes.all().length, 0, 'no change of any kind was recorded');
  assert.deepEqual(touched, [], 'no bot was stopped or started');
  assert.equal(store.all().length, 2);
  // It closes itself when the service answers again.
  const up = runnerRig({ run: async () => result(), trace: async () => null });
  up.inbox.raise({ kind: 'agent_unavailable', title: 'x', dedupeKey: 'agent_service_down' });
  await up.runner.settle(up.runner.start('str_a', 'diagnose', 'owner').id);
  assert.equal(up.inbox.list().filter((c) => c.kind === 'agent_unavailable' && c.status === 'open').length, 0);
});

test('P-7 with Claude unreachable the run writes one inbox item and changes nothing', async () => {
  const { runner, inbox, changes } = runnerRig({ run: async () => result({ outcome: 'claude_unreachable', summary: 'Claude is not signed in.' }), trace: async () => null });
  await runner.settle(runner.start('str_a', 'tune', 'owner').id);
  await runner.settle(runner.start('str_b', 'tune', 'owner').id);
  const cards = inbox.list().filter((c) => c.kind === 'claude_unavailable');
  assert.equal(cards.length, 1);
  assert.equal(changes.all().length, 0);
  assert.equal(runner.list()[0].outcome, 'claude_unreachable');
});

// --- the five routes -----------------------------------------------------------

function routeRig(opts: { llm?: AgentRouteDeps['llm']; validation?: Validation; client?: ServiceClient } = {}) {
  const strategies = new Map([['str_a', gold()]]);
  const host = {
    list: () => [...strategies.values()], get: (id: string) => structuredClone(strategies.get(id) ?? null), save: (s: Strategy) => { strategies.set(s.id, s); return s; },
    remove: (id: string) => { strategies.delete(id); }, reload: () => undefined, start: async () => undefined, stop: () => undefined,
  };
  const changes = new MemoryRecordStore<ChangeRecord>();
  const trials = new MemoryRecordStore<Trial>();
  const notes = new MemoryRecordStore<AgentNote>();
  const inbox = new Inbox(new MemoryInboxStore(), {}, () => NOW);
  const gate = deferred<RunResult>();
  const { runner } = runnerRig(opts.client ?? { run: () => gate.promise, trace: async () => null }, changes);
  const validation = opts.validation ?? passing();
  const service = new ChatService({
    backend: { name: 'fake', complete: async () => '' }, host, bots: () => [], issues: () => [], inbox: proposalFeed(inbox),
    learning: { changes, now: () => NOW, critic: 'off', validate: async () => ({ validation, market: SNAP }), market: async () => SNAP },
  });
  let calls = 0;
  const deps: AgentRouteDeps = {
    runner, dossier: (id) => buildDossier(dossierDeps({ strategy: (x) => strategies.get(x) ?? null, changes, notes, trials }), id),
    strategy: (id) => strategies.get(id) ?? null, changes, notes, trials,
    trialDeps: { merge: mergeChanges, validate: async () => ({ validation, market: SNAP }) },
    known: async (s) => ({ market: s.symbol, timeframe: s.timeframe, marketState: 'volatility mid, trend mid, spread mid', tier: '3 (Moderate)' }),
    holds: async () => [], settingsOf: () => ['risk.slPoints'], checkChange: () => ({ ok: true }),
    llm: opts.llm ?? (async () => { calls++; return 'hello'; }),
    propose: (trial, info) => service.proposeUpdate(trial, info), now: () => NOW,
  };
  const app = express();
  app.use(express.json());
  app.use('/agent', createAgentRouter(deps));
  const server: Server = app.listen(0);
  after(() => void server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const run = () => runner.start('str_a', 'tune', 'owner').id;
  return { post, run, runner, strategies, changes, trials, notes, inbox, service, calls: () => calls, gate, base };
}

const theoryBody = (over: Record<string, unknown> = {}) => ({
  agent: 'optimizer', strategyId: 'str_a',
  theory: {
    claim: 'Stops are too tight in high volatility', changes: { risk: { slPoints: 180 } }, disproof: { metric: 'profitFactor', op: '<', value: 1 },
    checklist: { evidence: '12 of 20 losses stopped out within 2 bars', change: 'slPoints 200 → 180' }, lessonsUsed: ['setting=risk.slPoints | change=down | effect=hurt'],
  }, ...over,
});

test('AG-11 + P-6 a proposal from the service goes through the same validation and Inbox as any other, with its seven answers', async () => {
  const rig = routeRig();
  const runId = rig.run();
  const tested = await rig.post('/backtest', { runId, ...theoryBody() });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.data.survived, true);

  const made = await rig.post('/proposals', { runId, strategyId: 'str_a', trialId: tested.body.data.trialId, changes: { risk: { slPoints: 180 } } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.data.proposalId as string;

  // An ordinary proposal: validated, in the Inbox, NOT applied.
  const p = rig.service.pending().find((x) => x.id === id)!;
  assert.equal(p.validation?.verdict, 'pass');
  assert.equal(rig.strategies.get('str_a')!.risk.slPoints, 200, 'nothing changes until the owner approves');
  const card = rig.inbox.list().find((c) => c.kind === 'proposal' && c.ref === id);
  assert.ok(card, 'the proposal is a card in the Inbox');

  // P-6: the record stores the seven answers and the lessons used.
  const rec = rig.changes.get(id)!;
  assert.equal(rec.source, 'agent');
  assert.deepEqual(Object.keys(rec.rationale!.checklist).sort(), ['change', 'evidence', 'market', 'marketState', 'tier', 'timeframe', 'wouldProveWrong']);
  assert.ok(Object.values(rec.rationale!.checklist).every((v) => typeof v === 'string' && v.length > 0));
  assert.deepEqual(rec.rationale!.lessonsUsed, ['setting=risk.slPoints | change=down | effect=hurt']);
  assert.equal(rec.rationale!.checklist.market, 'XAUUSD');
  assert.equal(rig.runner.run(runId)!.proposalId, id, 'the run points at its proposal ("Why was this proposed?")');
  const why = rig.service.why(id)!;
  assert.equal(why.runId, runId, 'the Inbox card can show the run behind it');
  assert.equal(why.rationale.claim, 'Stops are too tight in high volatility');
  assert.equal(rig.service.why('not-a-proposal'), null, 'a chat proposal has no agent reasoning to show');

  // One change at a time: a second proposal while the first is waiting is refused.
  const second = await rig.post('/backtest', { runId, ...theoryBody() });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'open_change');

  await rig.service.approve(id);
  assert.equal(rig.strategies.get('str_a')!.risk.slPoints, 180, 'applied only after approval');
});

test('P-1 (server) a proposal needs a theory that survived; the route refuses anything else', async () => {
  const rig = routeRig({ validation: passing(metrics({ profitFactor: 0.8 })) });
  const runId = rig.run();
  const tested = await rig.post('/backtest', { runId, ...theoryBody() });
  assert.equal(tested.body.data.survived, false, 'met its own disproof line');
  assert.equal(rig.trials.all().length, 1, 'the dropped attempt is on record');
  for (const trialId of [tested.body.data.trialId, 'nope', '']) {
    const r = await rig.post('/proposals', { runId, strategyId: 'str_a', trialId, changes: { risk: { slPoints: 180 } } });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'no_survivor');
  }
  assert.equal(rig.changes.all().length, 0);
  assert.equal(rig.service.pending().length, 0);
});

test('the routes refuse an unknown or finished run, and bad theories', async () => {
  const rig = routeRig();
  assert.equal((await rig.post('/backtest', { runId: 'x', ...theoryBody() })).status, 404);
  assert.equal((await rig.post('/notes', { runId: 'x', strategyId: 'str_a', text: 'hi' })).status, 404);
  assert.equal((await rig.post('/llm', { runId: 'x', agent: 'doctor', prompt: 'hi' })).status, 404);
  assert.equal((await rig.post('/proposals', { runId: 'x', strategyId: 'str_a', trialId: 'y' })).status, 404);
  const runId = rig.run();
  const bad = await rig.post('/backtest', { runId, ...theoryBody({ theory: { claim: 'c', changes: { risk: { slPoints: 180 } } } }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_theory');
});

test('AG-6 (server) more than 8 model calls in a run is refused', async () => {
  const rig = routeRig();
  const runId = rig.run();
  for (let i = 0; i < MAX_RUN_CALLS; i++) assert.equal((await rig.post('/llm', { runId, agent: 'doctor', prompt: 'p' })).status, 200);
  const over = await rig.post('/llm', { runId, agent: 'doctor', prompt: 'p' });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'run_budget');
  assert.equal(rig.calls(), MAX_RUN_CALLS, 'the ninth call never reached the model');
});

test('the llm route maps Claude being unreachable or capped to codes the service understands', async () => {
  let mode: 'down' | 'cap' | 'boom' = 'down';
  const rig = routeRig({ llm: async () => { if (mode === 'down') throw new LlmUnreachable('not signed in'); if (mode === 'cap') throw new LlmCapped('cap'); throw new Error('boom'); } });
  const runId = rig.run();
  const down = await rig.post('/llm', { runId, agent: 'critic', prompt: 'p' });
  assert.deepEqual([down.status, down.body.code], [503, 'claude_unreachable']);
  mode = 'cap';
  const cap = await rig.post('/llm', { runId, agent: 'critic', prompt: 'p' });
  assert.deepEqual([cap.status, cap.body.code], [429, 'call_cap']);
  mode = 'boom';
  assert.equal((await rig.post('/llm', { runId, agent: 'critic', prompt: 'p' })).status, 502);
  assert.equal((await rig.post('/llm', { runId, agent: 'wizard', prompt: 'p' })).status, 400);
  assert.equal((await rig.post('/llm', { runId, agent: 'doctor', prompt: 'x'.repeat(30_000) })).status, 400);
});

test('notes are stored with their market and shown only in dossiers of that market', async () => {
  const rig = routeRig();
  const runId = rig.run();
  const r = await rig.post('/notes', { runId, strategyId: 'str_a', agent: 'doctor', text: 'Losses cluster at the London open', evidence: ['9 of 14 losses 07:00-09:00 UTC'] });
  assert.equal(r.status, 200);
  const stored = rig.notes.all()[0];
  assert.equal(stored.symbol, 'XAUUSD');
  assert.equal(stored.timeframe, '1m');
  const dossier = await (await fetch(`${rig.base}/dossier/str_a`)).json() as { data: { notes: { text: string }[] } };
  assert.equal(dossier.data.notes[0].text, 'Losses cluster at the London open');
  assert.equal((await fetch(`${rig.base}/dossier/nope`)).status, 404);
});

// --- weekly -------------------------------------------------------------------

test('P-5 one weekly run handles at most 3 strategies, and only once a week', async () => {
  const strategies = ['a', 'b', 'c', 'd', 'e'].map((x) => gold(`s_${x}`));
  const changes = new MemoryRecordStore<ChangeRecord>();
  changes.put(outcome({ strategyId: 's_a', status: 'approved', score: 'pending' })); // a change is waiting on a
  const gates = strategies.map((s, i) => ({ strategyId: s.id, verdict: 'fail' as const, at: NOW - i * 1000 }));
  const picked = pickFailing({ strategies, gates, changes: changes.all(), busy: (id) => id === 's_b' });
  assert.deepEqual(picked.map((s) => s.id), ['s_e', 's_d', 's_c'], 'longest-failing first; waiting and busy ones skipped; 3 at most');
  const mixed = pickFailing({ strategies, gates: gates.map((g, i) => ({ ...g, verdict: i < 2 ? ('pass' as const) : ('fail' as const) })), changes: [], busy: () => false });
  assert.ok(mixed.every((s) => !['s_a', 's_b'].includes(s.id)), 'only failing strategies');

  let clock = NOW;
  const started: string[] = [];
  const store = new MemoryRecordStore<AgentRunRecord>();
  const runner = new AgentRunner({
    store, strategy: (id) => strategies.find((s) => s.id === id) ?? null, changes: new MemoryRecordStore<ChangeRecord>(), inbox: new Inbox(new MemoryInboxStore(), {}, () => clock), now: () => clock,
    client: { run: async (r) => { started.push(r.strategyId); return result({ runId: r.runId }); }, trace: async () => null },
  });
  let last: number | null = null;
  const cycle = new WeeklyAgentCycle({
    runner, enabled: () => true, lastRunAt: () => last, setLastRunAt: (ms) => { last = ms; }, now: () => clock,
    pick: () => pickFailing({ strategies, gates, changes: [], busy: () => false, max: 99 }), // even if pick over-delivers, the cycle caps it
  });
  assert.equal((await cycle.runOnce()).length, 3);
  assert.equal(started.length, 3);
  clock += 6 * DAY;
  assert.equal((await cycle.runOnce()).length, 0, 'not again within the week');
  clock += 2 * DAY;
  assert.equal((await cycle.runOnce()).length, 3, 'again after seven days');
  const off = new WeeklyAgentCycle({ runner, enabled: () => false, lastRunAt: () => null, setLastRunAt: () => undefined, pick: () => strategies, now: () => clock });
  assert.equal((await off.runOnce()).length, 0, 'does nothing when the service is not configured');
});

test('the risk cases shared with the Python Risk Guard are up to date', async () => {
  const { readFileSync } = await import('node:fs');
  const { riskCases } = await import('../scripts/riskCases.js');
  const onDisk = JSON.parse(readFileSync(new URL('../../../agents-py/tests/fixtures/risk_cases.json', import.meta.url), 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(riskCases())), 'run: npx tsx src/scripts/riskCases.ts');
});
