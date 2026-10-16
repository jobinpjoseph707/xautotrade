import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PaperBroker } from '../broker/paper.js';
import type { ChatBackend } from '../chat/backend.js';
import { ChatService } from '../chat/service.js';
import { fastScalpTest } from '../engine/presets.js';
import type { Strategy } from '../engine/types.js';
import { ruleCritic } from './critic.js';
import { demoStatsFromLogs } from './demo.js';
import { Evolver } from './evolve.js';
import type { Lab } from './lab.js';
import { buildNotebook, deriveLessons, notebookLines } from './notebook.js';
import { MemoryRecordStore } from './records.js';
import { scoreboard, scoreDue } from './scoring.js';
import { changeSignatures, describeSignature } from './signature.js';
import type { ChangeRecord, EvolveCandidate, EvolveSettings, MetricsLite, Validation, WindowResult } from './types.js';
import { DEFAULT_EVOLVE } from './types.js';
import { scoreForward, validateOnCandles } from './validate.js';

const DAY = 86_400_000;

function base(): Strategy {
  const s = fastScalpTest('XAUUSD');
  s.id = 'str_a';
  s.risk = { ...s.risk, slMode: 'points', slPoints: 200, tpMode: 'points', tpPoints: 300, fixedLot: 0.05, maxDailyLossPercent: 3 };
  return s;
}

const m = (trades: number, net: number, dd = 2, pf = net > 0 ? 1.3 : 0.8): MetricsLite => ({
  bars: 1000, trades, netProfitPct: net, profitFactor: pf, winRatePct: 50, maxDrawdownPct: dd,
});
const win = (before: MetricsLite | null, after: MetricsLite | null): WindowResult => ({ from: 0, to: 1, before, after });

function record(over: Partial<ChangeRecord>): ChangeRecord {
  return {
    id: Math.random().toString(36).slice(2), createdAt: 1, source: 'chat', agent: 'optimizer', model: 'fake/default',
    actionType: 'update_strategy', strategyId: 'str_a', symbol: 'XAUUSD', timeframe: '1m', summary: 's',
    signatures: ['risk.slPoints:down'], before: null, after: null, warnings: [], status: 'approved', score: 'hurt',
    scoreReasons: [], ...over,
  };
}

// --- signatures -------------------------------------------------------------

test('changeSignatures names each kind of change with its direction', () => {
  const a = base();
  const b = structuredClone(a);
  b.risk.slPoints = 150;
  b.indicators[0].params = { period: 5 };
  b.entryLong = { logic: 'OR', conditions: a.entryLong.conditions };
  const sigs = changeSignatures('update_strategy', a, b);
  assert.ok(sigs.includes('risk.slPoints:down'));
  assert.ok(sigs.includes('ind.ema.period:up'));
  assert.ok(sigs.includes('rules.entry:changed'));
  assert.deepEqual(changeSignatures('delete_strategy', a, null), ['delete']);
  assert.equal(describeSignature('risk.slPoints:down'), 'tightening the stop-loss');
});

// --- validation ---------------------------------------------------------------

test('validation tests on an older window that never overlaps the one the agent saw', async () => {
  const broker = new PaperBroker();
  await broker.connect();
  const candles = await broker.getCandles('XAUUSD', '1m', 3000);
  const spec = await broker.getSymbolSpec('XAUUSD');
  const before = base();
  const v = validateOnCandles({ before, after: before, candles, spec });
  assert.ok(v.inSample && v.outOfSample);
  assert.ok(v.outOfSample!.to < v.inSample!.from, 'unseen window must end before the agent window starts');
  // Identical configs: never "worse", so never a fail.
  assert.notEqual(v.verdict, 'fail');
  assert.deepEqual(v.outOfSample!.before, v.outOfSample!.after);

  const short = validateOnCandles({ before, after: before, candles: candles.slice(-1600), spec });
  assert.equal(short.verdict, 'insufficient');
});

// --- forward scoring --------------------------------------------------------

test('scoreForward: helped / hurt / noise / wait / give up', () => {
  assert.equal(scoreForward('update_strategy', win(m(30, -1), m(30, 1)), 15, false).score, 'helped');
  assert.equal(scoreForward('update_strategy', win(m(30, 1), m(30, -1)), 15, false).score, 'hurt');
  assert.equal(scoreForward('update_strategy', win(m(30, 1), m(30, 1.1)), 15, false).score, 'inconclusive');
  const w = scoreForward('update_strategy', win(m(3, 1), m(4, -1)), 15, false);
  assert.equal(w.score, 'pending');
  assert.ok(w.wait);
  assert.equal(scoreForward('update_strategy', win(m(3, 1), m(4, -1)), 15, true).score, 'inconclusive');
  assert.equal(scoreForward('update_strategy', null, 15, false).wait, true);
  // Deleting a strategy that would have lost = helped.
  assert.equal(scoreForward('delete_strategy', win(m(20, -2), null), 15, false).score, 'helped');
  assert.equal(scoreForward('create_strategy', win(null, m(20, 2, 2, 1.5)), 15, false).score, 'helped');
  assert.equal(scoreForward('start_bot', null, 15, false).score, 'n/a');
  // Risk Guard is judged on drawdown.
  assert.equal(scoreForward('update_strategy', win(m(30, 1, 5), m(30, 0.5, 3)), 15, false, true).score, 'helped');
});

// --- notebooks --------------------------------------------------------------

test('only repeated, consistent results become notebook lessons', () => {
  const two = [record({}), record({})];
  assert.equal(deriveLessons(two).length, 0, 'two results are not proof');
  const four = [record({}), record({}), record({}), record({ score: 'helped' })];
  const lessons = deriveLessons(four);
  assert.ok(lessons.length >= 1);
  assert.match(lessons[0].text, /Tightening the stop-loss on XAUUSD 1m hurt 3 of 4 times/);
  const mixed = [record({}), record({}), record({ score: 'helped' }), record({ score: 'helped' })];
  assert.equal(deriveLessons(mixed).length, 0, '50/50 is not a lesson');
  const nb = buildNotebook('doctor', four, ['Never trade the NFP hour']);
  const lines = notebookLines(nb);
  assert.ok(lines[0].includes('NFP'));
  assert.ok(lines.some((l) => l.startsWith('(learned by optimizer)')), 'hurt lessons are shared with other agents');
});

// --- critic -------------------------------------------------------------------

test('rule critic flags repeats of documented failures, multi-changes and thin evidence', () => {
  const history = [record({}), record({}), record({})];
  const v = ruleCritic(
    { actionType: 'update_strategy', strategyId: 'str_b', summary: 'x', signatures: ['risk.slPoints:down'], changedFields: 3, warnings: [],
      validation: { verdict: 'pass', reasons: [], outOfSample: win(m(10, 0), m(12, 1)) } },
    history,
  );
  assert.equal(v.verdict, 'oppose');
  assert.ok(v.points.some((p) => p.includes('documented failure')));
  assert.ok(v.points.some((p) => p.includes('3 things at once')));
  assert.ok(v.points.some((p) => p.includes('12 trades')));
  const clean = ruleCritic({ actionType: 'create_strategy', strategyId: null, summary: 'x', signatures: ['create'], changedFields: 0, warnings: [],
    validation: { verdict: 'pass', reasons: [], outOfSample: win(null, m(80, 2)) } }, []);
  assert.equal(clean.verdict, 'support');
});

// --- chat service + outcome memory -----------------------------------------

function makeHost(initial: Strategy[]) {
  const db = new Map(initial.map((s) => [s.id, s]));
  return {
    list: () => [...db.values()],
    get: (id: string) => structuredClone(db.get(id) ?? null),
    save: (s: Strategy) => { db.set(s.id, s); return s; },
    remove: (id: string) => { db.delete(id); },
    reload: () => undefined,
    start: async () => undefined,
    stop: () => undefined,
  };
}

const updateReply = (sl: number) =>
  `Tighter stop.\n\`\`\`xat-actions\n${JSON.stringify([{ type: 'update_strategy', id: 'str_a', reason: 'less risk', changes: { risk: { slPoints: sl } } }])}\n\`\`\``;

test('an update that fails on unseen data is held back and recorded, not shown', async () => {
  const changes = new MemoryRecordStore<ChangeRecord>();
  const fail: Validation = { verdict: 'fail', reasons: ['Unseen window: ...', 'Return fell by 2 points on unseen data.'] };
  const svc = new ChatService({
    backend: { name: 'fake', complete: async () => updateReply(150) },
    host: makeHost([base()]), bots: () => [], issues: () => [],
    learning: { changes, validate: async () => ({ validation: fail }), critic: 'rules' },
  });
  const r = await svc.chat({ agent: 'optimizer', message: 'tighten the stop' });
  assert.equal(r.proposals.length, 0);
  assert.match(r.rejected.join(' '), /Held back/);
  const recs = changes.all();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'blocked');
  assert.deepEqual(recs[0].signatures, ['risk.slPoints:down']);
  await assert.rejects(() => svc.approve(recs[0].id), /already blocked/);
});

test('a passing proposal carries validation + critic, and approval writes full outcome metadata', async () => {
  const changes = new MemoryRecordStore<ChangeRecord>();
  const prompts: string[] = [];
  const pass: Validation = { verdict: 'pass', reasons: ['ok'], outOfSample: win(m(40, 0), m(40, 1)) };
  const deps = {
    backend: { name: 'fake', complete: async (p: string) => { prompts.push(p); return updateReply(150); } } as ChatBackend,
    host: makeHost([base()]), bots: () => [], issues: () => [],
    learning: {
      changes, critic: 'rules' as const,
      validate: async () => ({ validation: pass, market: { symbol: 'XAUUSD', timeframe: '1m' as const, bars: 1500, atrPct: 0.05, trendPct: 1, avgSpreadPoints: 30 } }),
      demoStats: (_id: string, from: number, to: number) => ({ from, to, trades: 7, netProfit: -12.5 }),
    },
  };
  const svc = new ChatService(deps);
  const r = await svc.chat({ agent: 'optimizer', message: 'tighten the stop' });
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0];
  assert.equal(p.validation?.verdict, 'pass');
  assert.equal(p.critic?.verdict, 'support');
  assert.equal(p.model, 'fake/default');

  // A "restart": a fresh service over the same store can still approve it.
  const svc2 = new ChatService(deps);
  const approved = await svc2.approve(p.id);
  assert.equal(approved.status, 'approved');
  const rec = changes.get(p.id)!;
  assert.equal(rec.status, 'approved');
  assert.equal(rec.score, 'pending');
  assert.equal(rec.agent, 'optimizer');
  assert.equal(rec.before?.risk.slPoints, 200);
  assert.equal(rec.after?.risk.slPoints, 150);
  assert.equal(rec.market?.avgSpreadPoints, 30);
  assert.equal(rec.demoBefore?.trades, 7);
  assert.ok(prompts[0].includes('HOW PROPOSALS ARE CHECKED'));
});

test('proven lessons and past outcomes reach the agent prompt', async () => {
  const changes = new MemoryRecordStore<ChangeRecord>();
  for (let i = 0; i < 3; i++) changes.put(record({ id: `r${i}`, createdAt: i + 1, summary: `old change ${i}` }));
  const prompts: string[] = [];
  const svc = new ChatService({
    backend: { name: 'fake', complete: async (p) => { prompts.push(p); return 'ok'; } },
    host: makeHost([base()]), bots: () => [], issues: () => [],
    learning: { changes, critic: 'off' },
  });
  await svc.chat({ agent: 'optimizer', message: 'hi' });
  assert.match(prompts[0], /YOUR NOTEBOOK[\s\S]*hurt 3 of 3 times/);
  assert.match(prompts[0], /RECENT CHANGES AND THEIR OUTCOMES[\s\S]*old change 2 → HURT/);
});

test('the critic can be chatted with but can never propose actions', async () => {
  const svc = new ChatService({
    backend: { name: 'fake', complete: async () => updateReply(100) },
    host: makeHost([base()]), bots: () => [], issues: () => [],
  });
  const r = await svc.chat({ agent: 'critic', message: 'review' });
  assert.equal(r.proposals.length, 0);
  assert.match(r.rejected[0], /Critic is not allowed/);
});

// --- scoring loop -------------------------------------------------------------

test('scoreDue waits for age, then scores from the forward window', async () => {
  const changes = new MemoryRecordStore<ChangeRecord>();
  changes.put(record({ id: 'x', score: 'pending', decidedAt: 0, before: base(), after: base() }));
  const lab = { minTrades: 15, forward: async () => win(m(30, -1), m(30, 1)) } as unknown as Lab;
  const early = await scoreDue(changes, lab, { now: DAY, cfg: { minAgeMs: 3 * DAY, maxAgeMs: 21 * DAY } });
  assert.equal(early.scored.length, 0);
  const later = await scoreDue(changes, lab, {
    now: 4 * DAY, cfg: { minAgeMs: 3 * DAY, maxAgeMs: 21 * DAY },
    demoStats: (_i, from, to) => ({ from, to, trades: 5, netProfit: 20 }),
  });
  assert.equal(later.scored.length, 1);
  const rec = changes.get('x')!;
  assert.equal(rec.score, 'helped');
  assert.equal(rec.followUp?.demo?.trades, 5);
});

test('scoreboard reports hit rate per agent and per model, and critic accuracy', () => {
  const recs = [
    record({ score: 'helped', critic: { verdict: 'support', points: [], source: 'rules' } }),
    record({ score: 'hurt', critic: { verdict: 'oppose', points: [], source: 'rules' } }),
    record({ score: 'helped', model: 'gemini/x' }),
    record({ status: 'blocked', score: 'n/a' }),
  ];
  const sb = scoreboard(recs);
  const opt = sb.byAgent.find((r) => r.agent === 'optimizer')!;
  assert.equal(opt.proposed, 4);
  assert.equal(opt.heldBack, 1);
  assert.equal(opt.hitRate, 0.67);
  assert.equal(sb.byModel.length, 2);
  assert.equal(sb.critic.opposedThenHurt, 1);
  assert.equal(sb.critic.supportedThenHelped, 1);
});

test('demo stats sum realised profit from closing log events only', () => {
  const s = demoStatsFromLogs([
    { event: 'entry', data: { profit: 99 } },
    { event: 'position_closed', data: { profit: 10 } },
    { event: 'exit', data: { profit: -4.5 } },
  ], 0, 1);
  assert.deepEqual(s, { from: 0, to: 1, trades: 2, netProfit: 5.5 });
});

// --- auto-evolve ---------------------------------------------------------------

function evolveRig(reply: string, validation: Validation = { verdict: 'pass', reasons: ['ok'] }) {
  let now = 1_000 * DAY;
  let settings: EvolveSettings = { ...DEFAULT_EVOLVE };
  const host = makeHost([base()]);
  const changes = new MemoryRecordStore<ChangeRecord>();
  const candidates = new MemoryRecordStore<EvolveCandidate>();
  const lab = {
    minTrades: 15,
    validate: async () => ({ validation }),
    forward: async () => win(m(30, -1), m(30, 1.5)),
  } as unknown as Lab;
  const ev = new Evolver({
    backend: { name: 'fake', complete: async () => reply }, host, lab, candidates, changes,
    getSettings: () => settings, setSettings: (s) => { settings = s; }, now: () => now,
  });
  return { ev, host, changes, candidates, advance: (ms: number) => { now += ms; }, settings: () => settings };
}

test('auto-evolve is off by default and needs explicit opt-in per strategy', async () => {
  const { ev } = evolveRig(updateReply(150));
  assert.equal(ev.settings().enabled, false);
  assert.equal(ev.isDue(), false);
  const r = await ev.runCycle();
  assert.equal(r.created.length, 0);
  ev.updateSettings({ enabled: true });
  assert.equal(ev.isDue(), false, 'enabled but no strategies opted in');
});

test('auto-evolve: variant → shadow test → winner → one-tap promote', async () => {
  const { ev, host, changes, advance } = evolveRig(updateReply(150));
  ev.updateSettings({ enabled: true, strategyIds: ['str_a'] });
  const r = await ev.runCycle();
  assert.equal(r.created.length, 1);
  assert.equal(host.get('str_a')!.risk.slPoints, 200, 'nothing is applied automatically');
  assert.throws(() => ev.promote(r.created[0].id), /Only finished variants/);
  assert.equal((await ev.runCycle(true)).created.length, 0, 'one variant per strategy at a time');

  advance(3 * DAY);
  assert.equal((await ev.evaluate()).length, 0, 'still inside the test period');
  advance(5 * DAY);
  const done = await ev.evaluate();
  assert.equal(done[0].status, 'winner');

  ev.promote(done[0].id);
  assert.equal(host.get('str_a')!.risk.slPoints, 150);
  const rec = changes.all().find((c) => c.source === 'evolve' && c.status === 'approved')!;
  assert.equal(rec.score, 'pending', 'promoted changes are scored like any other');
});

test('auto-evolve never keeps a variant that loosens risk or fails unseen data', async () => {
  const loosen = `x\n\`\`\`xat-actions\n${JSON.stringify([{ type: 'update_strategy', id: 'str_a', changes: { risk: { fixedLot: 0.5 } } }])}\n\`\`\``;
  const a = evolveRig(loosen);
  a.ev.updateSettings({ enabled: true, strategyIds: ['str_a'] });
  const r1 = await a.ev.runCycle();
  assert.equal(r1.created.length, 0);
  assert.match(r1.skipped.join(' '), /raises fixedLot/);

  const b = evolveRig(updateReply(150), { verdict: 'fail', reasons: ['worse on unseen data'] });
  b.ev.updateSettings({ enabled: true, strategyIds: ['str_a'] });
  const r2 = await b.ev.runCycle();
  assert.equal(r2.created.length, 0);
  assert.equal(b.changes.all()[0].status, 'blocked');
});
