import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emaPullbackScalp, fastScalpTest } from '../engine/presets.js';
import type { Strategy } from '../engine/types.js';
import { extractActions } from './actions.js';
import { CHAT_BUTTONS } from './agents.js';
import { parseCliOutput, parseCliUsage, type ChatBackend } from './backend.js';
import { buildPrompt } from './prompt.js';
import { ChatService } from './service.js';
import { makeHost } from '../testkit/index.js';

function service(reply: string, initial: Strategy[] = []) {
  const { host, db, calls } = makeHost(initial);
  const backend: ChatBackend = { name: 'fake', complete: async () => reply };
  const svc = new ChatService({ backend, host, bots: () => [], issues: () => [] });
  return { svc, db, calls };
}

const block = (actions: unknown) => `Sure.\n\n\`\`\`xat-actions\n${JSON.stringify(actions)}\n\`\`\``;

function existing(): Strategy {
  const s = fastScalpTest('XAUUSD');
  s.id = 'str_test1';
  s.risk = { ...s.risk, maxDailyLossPercent: 3, fixedLot: 0.05, slMode: 'points', slPoints: 200, tpMode: 'points', tpPoints: 300 };
  return s;
}

test('extractActions splits the reply from the action block and reports bad JSON', () => {
  const r = extractActions('Hello there.\n```xat-actions\n[{"type":"stop_bot","id":"a"}]\n```');
  assert.equal(r.reply, 'Hello there.');
  assert.equal(r.raw.length, 1);
  const bad = extractActions('x\n```xat-actions\n{not json}\n```');
  assert.equal(bad.raw.length, 0);
  assert.match(bad.parseError ?? '', /Could not read/);
  assert.equal(extractActions('just text').raw.length, 0);
});

test('a proposed new strategy is validated, then only saved after approval', async () => {
  const strat = { name: 'Chat RSI', symbol: 'EURUSD', timeframe: '5m',
    indicators: [{ id: 'rsi', type: 'rsi', params: { period: 14 } }],
    entryLong: { logic: 'AND', conditions: [{ left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 30 } }] },
    entryShort: { logic: 'AND', conditions: [] },
    risk: { fixedLot: 0.01, slMode: 'points', slPoints: 100, tpMode: 'points', tpPoints: 150 } };
  const { svc, db } = service(block([{ type: 'create_strategy', reason: 'test', strategy: strat }]));
  const r = await svc.chat({ agent: 'strategist', message: 'make an RSI strategy' });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.rejected.length, 0);
  assert.equal(db.size, 0, 'nothing saved before approval');

  const p = await svc.approve(r.proposals[0].id);
  assert.equal(p.status, 'approved');
  assert.equal(db.size, 1);
  assert.equal([...db.values()][0].risk.maxDailyLossPercent, 3, 'defaults filled in');
  await assert.rejects(() => svc.approve(p.id), /already approved/);
});

test('rejecting a proposal changes nothing', async () => {
  const { svc, calls } = service(block([{ type: 'stop_bot', id: 'str_test1' }]), [existing()]);
  const r = await svc.chat({ agent: 'doctor', message: 'stop it' });
  svc.reject(r.proposals[0].id);
  assert.deepEqual(calls, []);
  assert.equal(svc.pending().length, 0);
});

test('invalid or disallowed actions are refused with a reason', async () => {
  const bad = { name: 'x', symbol: 'EURUSD', timeframe: '5m', indicators: [{ id: 'v', type: 'vwap', params: {} }],
    entryLong: { logic: 'AND', conditions: [] }, entryShort: { logic: 'AND', conditions: [] }, risk: {} };
  const { svc } = service(block([
    { type: 'create_strategy', strategy: bad },
    { type: 'delete_strategy', id: 'str_test1' }, // strategist may not delete
    { type: 'update_strategy', id: 'nope', changes: { name: 'z' } },
  ]), [existing()]);
  const r = await svc.chat({ agent: 'strategist', message: 'do things' });
  assert.equal(r.proposals.length, 0);
  assert.equal(r.rejected.length, 2 + 1);
  assert.ok(r.rejected.some((x) => /Unsupported indicator/.test(x)));
  assert.ok(r.rejected.some((x) => /not allowed to delete/.test(x)));
});

test('update merges risk fields, and approval re-merges onto the current version', async () => {
  const { svc, db, calls } = service(block([{ type: 'update_strategy', id: 'str_test1', changes: { risk: { slPoints: 150 } } }]), [existing()]);
  const r = await svc.chat({ agent: 'optimizer', message: 'tighten the stop' });
  assert.match(r.proposals[0].summary, /risk\.slPoints: 200 → 150/);
  // The user renames the strategy before approving; that edit must survive.
  db.set('str_test1', { ...db.get('str_test1')!, name: 'Renamed' });
  const p = await svc.approve(r.proposals[0].id);
  assert.equal(p.status, 'approved');
  assert.equal(db.get('str_test1')!.risk.slPoints, 150);
  assert.equal(db.get('str_test1')!.name, 'Renamed');
  assert.ok(calls.includes('reload:str_test1'));
});

test('Risk Guard can tighten but never loosen; other agents get a warning', async () => {
  const loosen = block([{ type: 'update_strategy', id: 'str_test1', changes: { risk: { fixedLot: 0.5 } } }]);
  const guard = await service(loosen, [existing()]).svc.chat({ agent: 'guard', message: 'x' });
  assert.equal(guard.proposals.length, 0);
  assert.match(guard.rejected[0], /only tighten/);

  const opt = await service(loosen, [existing()]).svc.chat({ agent: 'optimizer', message: 'x' });
  assert.equal(opt.proposals.length, 1);
  assert.ok(opt.proposals[0].warnings.some((w) => /loosens/.test(w)));

  const tighten = block([{ type: 'update_strategy', id: 'str_test1', changes: { risk: { fixedLot: 0.01, maxDailyLossPercent: 2 } } }]);
  const ok = await service(tighten, [existing()]).svc.chat({ agent: 'guard', message: 'x' });
  assert.equal(ok.proposals.length, 1);
});

test('delete, start and stop call the right host methods only after approval', async () => {
  const { svc, db, calls } = service(block([
    { type: 'delete_strategy', id: 'str_test1', reason: 'broken' },
  ]), [existing()]);
  const r = await svc.chat({ agent: 'doctor', message: 'remove it' });
  assert.deepEqual(calls, []);
  await svc.approve(r.proposals[0].id);
  assert.deepEqual(calls, ['remove:str_test1']);
  assert.equal(db.size, 0);

  const s2 = service(block([{ type: 'start_bot', id: 'str_test1' }, { type: 'stop_bot', id: 'str_test1' }]), [existing()]);
  const r2 = await s2.svc.chat({ agent: 'optimizer', message: 'start' });
  assert.equal(r2.proposals.length, 1, 'optimizer may start but not stop');
  await s2.svc.approve(r2.proposals[0].id);
  assert.deepEqual(s2.calls, ['start:str_test1']);
});

test('the prompt carries the role, format reference, current strategies and history', () => {
  const s = existing();
  const p = buildPrompt({
    agent: { id: 'doctor', name: 'Strategy Doctor', tagline: '', role: 'REVIEW things', allowed: ['stop_bot'] },
    message: 'why no trades?', history: [{ role: 'user', text: 'hi' }, { role: 'agent', text: 'hello' }],
    strategies: [s], bots: [], issues: [{ ts: 0, level: 'error', strategyId: s.id, message: 'AutoTrading disabled' }],
  });
  for (const needle of ['Strategy Doctor', 'xat-actions', s.id, 'AutoTrading disabled', 'why no trades?', 'User: hi', 'You: hello', 'STRATEGY FORMAT']) {
    assert.ok(p.includes(needle), `missing ${needle}`);
  }
});

test('CLI output parsing: result text, error flag, and garbage', () => {
  assert.equal(parseCliOutput(JSON.stringify({ type: 'result', is_error: false, result: 'hi' })), 'hi');
  assert.throws(() => parseCliOutput(JSON.stringify({ is_error: true, result: 'Not logged in' })), /Not logged in/);
  assert.equal(parseCliOutput(JSON.stringify([{ type: 'system' }, { type: 'result', result: 'arr' }])), 'arr');
  assert.equal(parseCliOutput('not json'), null);
  assert.equal(parseCliOutput(''), null);
});

test('CLI usage parsing: token counts and cost, missing/garbage fields degrade to null', () => {
  const u = parseCliUsage(
    JSON.stringify({
      type: 'result', is_error: false, result: 'hi', total_cost_usd: 0.0123, duration_ms: 900,
      usage: { input_tokens: 120, output_tokens: 340, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
    }),
  );
  assert.deepEqual(u, { inputTokens: 120, outputTokens: 340, cacheCreationInputTokens: 0, cacheReadInputTokens: 50, costUsd: 0.0123, durationMs: 900 });
  // An array payload: usage comes from the last `result` message, same as parseCliOutput.
  const u2 = parseCliUsage(JSON.stringify([{ type: 'system' }, { type: 'result', result: 'arr', usage: { input_tokens: 5, output_tokens: 6 } }]));
  assert.deepEqual(u2, { inputTokens: 5, outputTokens: 6, cacheCreationInputTokens: undefined, cacheReadInputTokens: undefined, costUsd: undefined, durationMs: undefined });
  assert.equal(parseCliUsage(JSON.stringify({ type: 'result', result: 'hi' })), null); // no usage field at all
  assert.equal(parseCliUsage('not json'), null);
  assert.equal(parseCliUsage(''), null);
});

test('a real preset round-trips through the create validator', async () => {
  const p = emaPullbackScalp('EURUSD');
  const { id: _id, ...rest } = p;
  const { svc } = service(block([{ type: 'create_strategy', strategy: rest }]));
  const r = await svc.chat({ agent: 'strategist', message: 'x' });
  assert.equal(r.proposals.length, 1, r.rejected.join('|'));
});

// --- task 1.2: agents cannot create or update a strategy that breaks the rules -----

import { validStrategy } from '../testkit/index.js';

test('R-19 an agent proposal that breaks any rule is refused with the reason', async () => {
  const bad = (risk: Record<string, unknown>) => ({
    name: 'Bad', symbol: 'EURUSD', timeframe: '5m',
    indicators: [{ id: 'rsi', type: 'rsi', params: { period: 14 } }],
    entryLong: { logic: 'AND', conditions: [{ left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 30 } }] },
    entryShort: { logic: 'AND', conditions: [] },
    risk: { fixedLot: 0.01, ...risk },
  });
  // create: target smaller than 1.5 x the stop
  const create = service(block([{ type: 'create_strategy', strategy: bad({ slMode: 'points', slPoints: 100, tpMode: 'points', tpPoints: 100 }) }]));
  const c = await create.svc.chat({ agent: 'strategist', message: 'make one' });
  assert.equal(c.proposals.length, 0);
  assert.match(c.rejected[0], /smaller than 1\.5/);
  // create: no stop
  const noStop = service(block([{ type: 'create_strategy', strategy: bad({ slMode: 'none', tpMode: 'points', tpPoints: 100 }) }]));
  assert.match((await noStop.svc.chat({ agent: 'strategist', message: 'x' })).rejected[0], /No stop-loss/);
  // update: a valid strategy edited into a bad one
  const e = validStrategy('XAUUSD', 'str_valid');
  const update = service(block([{ type: 'update_strategy', id: 'str_valid', changes: { risk: { tpPoints: 250 } } }]), [e]);
  const u = await update.svc.chat({ agent: 'optimizer', message: 'x' });
  assert.equal(u.proposals.length, 0);
  assert.match(u.rejected[0], /smaller than 1\.5/);
  assert.equal(update.db.get('str_valid')!.risk.tpPoints, 300, 'nothing changed');
});

test('an agent cannot mark its own strategy as a test rig or start it at a later stage', async () => {
  const s = {
    name: 'Sneaky', symbol: 'EURUSD', timeframe: '5m', isTest: true, gate: 'live', tier: 1, pausedBy: 'owner',
    indicators: [{ id: 'rsi', type: 'rsi', params: { period: 14 } }],
    entryLong: { logic: 'AND', conditions: [{ left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 30 } }] },
    entryShort: { logic: 'AND', conditions: [] },
    risk: { fixedLot: 0.01, slMode: 'points', slPoints: 100, tpMode: 'points', tpPoints: 100 }, // 1:1, only legal for a test rig
  };
  const { svc } = service(block([{ type: 'create_strategy', strategy: s }]));
  const r = await svc.chat({ agent: 'strategist', message: 'x' });
  assert.equal(r.proposals.length, 0, 'isTest from an agent is ignored, so the 1:1 target is refused');
  const good = { ...s, risk: { ...s.risk, tpPoints: 150 } };
  const ok = await service(block([{ type: 'create_strategy', strategy: good }])).svc.chat({ agent: 'strategist', message: 'x' });
  const created = (ok.proposals[0].action as { strategy: { isTest: boolean; gate: string; tier?: number; pausedBy?: string } }).strategy;
  assert.equal(created.isTest, false);
  assert.equal(created.gate, 'backtest');
  assert.equal(created.tier, undefined);
  assert.equal(created.pausedBy, undefined);
});

test('Risk Guard may not lower the minimum reward:risk, widen the spread ratio or loosen the flat rules', async () => {
  const e = validStrategy('XAUUSD', 'str_valid');
  e.risk = { ...e.risk, minRewardRisk: 2, tpPoints: 400 };
  for (const change of [{ minRewardRisk: 1.5 }, { maxSpreadToStopRatio: 0.2 }, { flatBeforeWeekend: false }, { flatAtUTC: '23:00' }]) {
    const out = await service(block([{ type: 'update_strategy', id: 'str_valid', changes: { risk: { ...change, maxSpreadToStopRatio: change.maxSpreadToStopRatio ?? 0.1 } } }]), [e]).svc.chat({ agent: 'guard', message: 'x' });
    assert.equal(out.proposals.length, 0, JSON.stringify(change));
    assert.match(out.rejected[0], /only tighten/, JSON.stringify(change));
  }
  const tighter = await service(block([{ type: 'update_strategy', id: 'str_valid', changes: { risk: { flatAtUTC: '20:00', maxSpreadToStopRatio: 0.1 } } }]), [e]).svc.chat({ agent: 'guard', message: 'x' });
  assert.equal(tighter.proposals.length, 1);
});

// --- task 1.5: chat on each strategy -----------------------------------------------

import { whatIfLine } from './service.js';

/** A service whose fake backend records every call, with a separate answer for the router. */
function chatRig(opts: { reply?: string; router?: string | Error; strategies?: Strategy[]; backtests?: (list: Strategy[]) => Promise<{ strategyId: string; trades?: number; profitFactor?: number; netProfitPct?: number; error?: string }[]> } = {}) {
  const { host, db, calls } = makeHost(opts.strategies ?? [existing()]);
  const sent: { prompt: string; tag?: string; model?: string }[] = [];
  const backtestCalls: Strategy[][] = [];
  const svc = new ChatService({
    backend: {
      name: 'fake',
      complete: async (prompt, o) => {
        sent.push({ prompt, tag: o?.tag, model: o?.model });
        if (o?.tag === 'router') {
          if (opts.router instanceof Error) throw opts.router;
          return opts.router ?? '{"agent":"doctor"}';
        }
        return opts.reply ?? 'ok';
      },
    },
    host, bots: () => [], issues: () => [],
    backtests: async (list) => {
      backtestCalls.push(list);
      return opts.backtests ? opts.backtests(list) : list.map((s) => ({ strategyId: s.id, trades: 42, profitFactor: 0.8, netProfitPct: -1 }));
    },
  });
  return { svc, db, calls, sent, backtestCalls };
}
const agentCalls = (r: { sent: { prompt: string; tag?: string }[] }) => r.sent.filter((c) => c.tag !== 'router');

// H-1
test('H-1 each button picks its agent: Tune, Diagnose, Tighten risk, Critique', async () => {
  const expected = { tune: 'optimizer', diagnose: 'doctor', tighten: 'guard', critique: 'critic' } as const;
  assert.deepEqual({ ...CHAT_BUTTONS }, expected);
  for (const [button, agent] of Object.entries(expected)) {
    const rig = chatRig();
    const r = await rig.svc.chat({ strategyId: 'str_test1', button });
    assert.equal(r.agent, agent, button);
    assert.equal(rig.sent.filter((c) => c.tag === 'router').length, 0, 'a button never calls the router');
  }
  await assert.rejects(() => chatRig().svc.chat({ strategyId: 'str_test1', button: 'launch' }), /Unknown button/);
});

// H-2
test('H-2 free text is routed by the router answer', async () => {
  for (const agent of ['optimizer', 'guard', 'critic', 'doctor']) {
    const rig = chatRig({ router: `{"agent":"${agent}"}` });
    const r = await rig.svc.chat({ strategyId: 'str_test1', message: 'something in my own words' });
    assert.equal(r.agent, agent);
    const router = rig.sent.find((c) => c.tag === 'router')!;
    assert.equal(router.model, 'haiku', 'a cheap model decides');
    assert.match(router.prompt, /something in my own words/);
  }
  // The Strategist is not offered inside one strategy's chat, and is refused if named.
  const rig = chatRig({ router: '{"agent":"strategist"}' });
  assert.equal((await rig.svc.chat({ strategyId: 'str_test1', message: 'x' })).agent, 'doctor');
  await assert.rejects(() => chatRig().svc.chat({ strategyId: 'str_test1', agent: 'strategist', message: 'x' }), /Agents tab/);
  // With no strategies at all, the Strategist answers and the router is not called.
  const empty = chatRig({ strategies: [], router: '{"agent":"guard"}' });
  assert.equal((await empty.svc.chat({ message: 'hello' })).agent, 'strategist');
  assert.equal(empty.sent.filter((c) => c.tag === 'router').length, 0);
});

// H-3
test('H-3 if the router fails or answers nonsense, the doctor answers', async () => {
  for (const router of ['I think the optimizer', '{"agent":"root"}', '{"agent":"strategist"}', '{bad json}', '', new Error('timeout')]) {
    const r = await chatRig({ router }).svc.chat({ strategyId: 'str_test1', message: 'help' });
    assert.equal(r.agent, 'doctor', String(router));
  }
});

// H-4
test('H-4 each strategy has its own conversation', async () => {
  const a = existing();
  const b = { ...existing(), id: 'str_other', name: 'Other strategy' };
  const rig = chatRig({ strategies: [a, b] });
  await rig.svc.chat({ strategyId: 'str_test1', agent: 'doctor', message: 'ONLY-ABOUT-A please' });
  await rig.svc.chat({ strategyId: 'str_other', agent: 'doctor', message: 'second question for B' });
  const second = agentCalls(rig)[1].prompt;
  assert.ok(!second.includes('ONLY-ABOUT-A'), "A's messages are not in B's prompt");
  // A's own next message does see A's earlier turn, even if the app sends no history.
  await rig.svc.chat({ strategyId: 'str_test1', agent: 'doctor', message: 'follow up on A', history: [{ role: 'user', text: 'INJECTED-BY-CLIENT' }] });
  const third = agentCalls(rig)[2].prompt;
  assert.ok(third.includes('ONLY-ABOUT-A'));
  assert.ok(!third.includes('INJECTED-BY-CLIENT'), 'the server keeps the history, not the client');
});

// H-5
test('H-5 the prompt for a strategy chat contains that strategy only', async () => {
  const a = existing();
  const b = { ...existing(), id: 'str_other', name: 'Zebra Breakout' };
  const rig = chatRig({ strategies: [a, b] });
  await rig.svc.chat({ strategyId: 'str_test1', button: 'diagnose' });
  const prompt = agentCalls(rig)[0].prompt;
  assert.ok(prompt.includes('str_test1'));
  assert.ok(!prompt.includes('str_other') && !prompt.includes('Zebra Breakout'));
  assert.match(prompt, /THIS CHAT IS ABOUT ONE STRATEGY/);
  assert.deepEqual(rig.backtestCalls[0].map((s) => s.id), ['str_test1'], 'only that strategy is backtested');
  // The Agents tab (no strategyId) still sees everything.
  await rig.svc.chat({ agent: 'doctor', message: 'all of them' });
  assert.ok(agentCalls(rig)[1].prompt.includes('Zebra Breakout'));
});

const whatif = (changes: unknown, id = 'str_test1') => `Let me test that.\n\n\`\`\`xat-whatif\n${JSON.stringify({ id, reason: 'wider stop', changes })}\n\`\`\``;

// H-6
test('H-6 a what-if runs one backtest call and returns a proposal with before and after numbers', async () => {
  const rig = chatRig({
    reply: whatif({ risk: { slPoints: 250, tpPoints: 400 } }),
    backtests: async (list) => list.map((s) => (s.id.endsWith('~whatif') ? { strategyId: s.id, trades: 40, profitFactor: 1.3, netProfitPct: 2.5 } : { strategyId: s.id, trades: 42, profitFactor: 0.8, netProfitPct: -1 })),
  });
  const r = await rig.svc.chat({ strategyId: 'str_test1', button: 'tune' });
  // One call for the "reply" look at the data, one for the what-if pair.
  assert.equal(rig.backtestCalls.length, 2);
  assert.deepEqual(rig.backtestCalls[1].map((s) => s.id), ['str_test1', 'str_test1~whatif']);
  assert.equal(rig.backtestCalls[1][1].risk.slPoints, 250, 'the second strategy carries the change');
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0];
  assert.equal(p.whatIf?.before.profitFactor, 0.8);
  assert.equal(p.whatIf?.after.profitFactor, 1.3);
  assert.match(p.reason ?? '', /profit factor 0\.8 → 1\.3/);
  assert.equal(rig.db.get('str_test1')!.risk.slPoints, 200, 'nothing is saved until approval');
  await rig.svc.approve(p.id);
  assert.equal(rig.db.get('str_test1')!.risk.slPoints, 250);
  assert.ok(!r.reply.includes('xat-whatif'), 'the block is not shown to the user');
});

// H-7
test('H-7 a what-if that breaks the target rule returns the reason and no proposal', async () => {
  const rig = chatRig({ reply: whatif({ risk: { tpPoints: 250 } }, 'str_valid'), strategies: [validStrategy('XAUUSD', 'str_valid')] }); // 250 < 1.5 x 200
  const r = await rig.svc.chat({ strategyId: 'str_valid', button: 'tune' });
  assert.equal(r.proposals.length, 0);
  assert.match(r.rejected.join(' '), /What-if not run: .*smaller than 1\.5/);
  assert.equal(rig.backtestCalls.length, 1, 'no extra backtest was spent on a refused change');
  // Another strategy's id inside one strategy's chat is refused too.
  const other = await chatRig({ reply: whatif({ risk: { slPoints: 250, tpPoints: 400 } }, 'str_other'), strategies: [existing(), { ...existing(), id: 'str_other' }] }).svc.chat({ strategyId: 'str_test1', button: 'tune' });
  assert.equal(other.proposals.length, 0);
  assert.match(other.rejected.join(' '), /different one/);
});

// H-8
test('H-8 a performance question gets backtest numbers without any keyword', async () => {
  const rig = chatRig();
  // Regression: this exact sentence once reached the Doctor with no backtest data because a regex missed it.
  await rig.svc.chat({
    agent: 'doctor',
    message: 'how many current strategies are there? check it in details and see how theyre doing and why are they in loss? how to make it a better scalping strategy?',
  });
  assert.equal(rig.backtestCalls.length, 1, 'this phrasing gets a backtest pass');
  assert.ok(agentCalls(rig)[0].prompt.includes('just run by the server'));
  // Words do not matter any more: a greeting gets the numbers too, and the Strategist still gets none.
  await rig.svc.chat({ agent: 'optimizer', message: 'hello there' });
  assert.equal(rig.backtestCalls.length, 2);
  await rig.svc.chat({ agent: 'strategist', message: 'backtest ideas' });
  assert.equal(rig.backtestCalls.length, 2, 'the Strategist does not trigger backtests');
});

// H-9
test('H-9 the critic still cannot propose actions, including a what-if', async () => {
  const rig = chatRig({ reply: block([{ type: 'stop_bot', id: 'str_test1' }]) + '\n' + whatif({ risk: { slPoints: 250, tpPoints: 400 } }) });
  const r = await rig.svc.chat({ strategyId: 'str_test1', button: 'critique' });
  assert.equal(r.agent, 'critic');
  assert.equal(r.proposals.length, 0);
  assert.ok(r.rejected.some((x) => /not allowed to stop bot/.test(x)));
  assert.ok(r.rejected.some((x) => /What-if not run: .*not allowed to update strategy/.test(x)));
});

test('a what-if from Risk Guard that loosens a limit is refused like any other proposal', async () => {
  const rig = chatRig({ reply: whatif({ risk: { fixedLot: 0.5 } }) });
  const r = await rig.svc.chat({ strategyId: 'str_test1', button: 'tighten' });
  assert.equal(r.proposals.length, 0);
  assert.match(r.rejected.join(' '), /only tighten/);
});

test('deleting a strategy forgets its conversation', async () => {
  const rig = chatRig({ reply: block([{ type: 'delete_strategy', id: 'str_test1', reason: 'broken' }]) });
  const r = await rig.svc.chat({ strategyId: 'str_test1', agent: 'doctor', message: 'MEMORY-TEST' });
  await rig.svc.approve(r.proposals[0].id);
  rig.db.set('str_test1', existing());
  await rig.svc.chat({ strategyId: 'str_test1', agent: 'doctor', message: 'again' });
  assert.ok(!agentCalls(rig)[1].prompt.includes('MEMORY-TEST'));
});

test('whatIfLine compares the two runs, and says when one failed', () => {
  assert.match(whatIfLine({ strategyId: 'a', trades: 10, profitFactor: 1 }, { strategyId: 'a', trades: 12, profitFactor: 1.4 }), /trades 10 → 12, profit factor 1 → 1\.4/);
  assert.match(whatIfLine({ strategyId: 'a', error: 'no candles' }, { strategyId: 'a' }), /failed: no candles/);
});
