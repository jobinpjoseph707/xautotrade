import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emaPullbackScalp, fastScalpTest } from '../engine/presets.js';
import type { Strategy } from '../engine/types.js';
import { extractActions } from './actions.js';
import { routeAgent } from './agents.js';
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
  s.risk = { ...s.risk, maxDailyLossPercent: 3, fixedLot: 0.05, slMode: 'points', slPoints: 200, tpMode: 'points', tpPoints: 200 };
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

test('routing picks the matching agent, and the Strategist when there are no strategies', () => {
  assert.equal(routeAgent('anything', false), 'strategist');
  assert.equal(routeAgent('create a new strategy for gold', true), 'strategist');
  assert.equal(routeAgent('tweak the stop and improve it', true), 'optimizer');
  assert.equal(routeAgent('my bot is not working, why', true), 'doctor');
  assert.equal(routeAgent('reduce my risk and lot size', true), 'guard');
  assert.equal(routeAgent('hello', true), 'doctor');
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
    agent: { id: 'doctor', name: 'Strategy Doctor', tagline: '', role: 'REVIEW things', allowed: ['stop_bot'], keywords: /x/ },
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

test('backtest results reach the prompt only for performance questions and non-Strategist agents', async () => {
  const prompts: string[] = [];
  const { host } = makeHost([existing()]);
  let ran = 0;
  const svc = new ChatService({
    backend: { name: 'fake', complete: async (p) => { prompts.push(p); return 'ok'; } },
    host, bots: () => [], issues: () => [],
    backtests: async (list) => { ran += 1; return list.map((s) => ({ strategyId: s.id, trades: 42, profitFactor: 0.8 })); },
  });
  await svc.chat({ agent: 'doctor', message: 'hello there' });
  assert.equal(ran, 0);
  assert.ok(!prompts[0].includes('just run by the server'));

  await svc.chat({ agent: 'doctor', message: 'backtest them all and remove the bad ones' });
  assert.equal(ran, 1);
  assert.ok(prompts[1].includes('just run by the server') && prompts[1].includes('"profitFactor":0.8'));

  await svc.chat({ agent: 'strategist', message: 'backtest ideas' });
  assert.equal(ran, 1, 'Strategist does not trigger backtests');
});

test('backtest trigger recognises loss/result phrasing, not just the word "backtest"', async () => {
  const { host } = makeHost([existing()]);
  let ran = 0;
  const svc = new ChatService({
    backend: { name: 'fake', complete: async () => 'ok' },
    host, bots: () => [], issues: () => [],
    backtests: async (list) => { ran += 1; return list.map((s) => ({ strategyId: s.id, trades: 25, profitFactor: 0.9 })); },
  });

  // Regression: this exact phrasing reached the Doctor with no backtest data
  // because the trigger regex only matched "profit", not "in loss" or "doing".
  await svc.chat({
    agent: 'doctor',
    message: 'how many current strategies are there? check it in details and see how theyre doing and why are they in loss? how to make it a better scalping strategy?',
  });
  assert.equal(ran, 1, 'this phrasing must trigger a backtest pass');
});
