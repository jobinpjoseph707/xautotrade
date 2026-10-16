import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../app.js';
import { config } from '../config.js';

let server: Server;
let base = '';
const KEY = 'test-key-0123456789abcdef01234567';

before(async () => {
  config.apiKey = KEY;
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
});

// T-0.5
test('every /api route except /health refuses a missing or wrong key', async () => {
  for (const path of ['/api/strategies', '/api/inbox', '/api/testboard', '/api/tiers', '/api/journal']) {
    const none = await fetch(base + path);
    assert.equal(none.status, 401, `${path} without a key`);
    const wrong = await fetch(base + path, { headers: { 'x-api-key': 'nope' } });
    assert.equal(wrong.status, 401, `${path} with a wrong key`);
  }
  const health = await fetch(base + '/api/health');
  assert.notEqual(health.status, 401);
});

test('the key is accepted in the x-api-key header', async () => {
  const res = await fetch(base + '/api/strategies', { headers: { 'x-api-key': KEY } });
  assert.equal(res.status, 200);
});

// F-5
test('the inbox and testboard routers are mounted behind the key and start empty; tiers shows five empty tiers', async () => {
  for (const name of ['inbox', 'testboard']) {
    const res = await fetch(`${base}/api/${name}`, { headers: { 'x-api-key': KEY } });
    assert.equal(res.status, 200, name);
    assert.deepEqual(await res.json(), { ok: true, data: [] });
  }
  const tiers = (await (await fetch(`${base}/api/tiers`, { headers: { 'x-api-key': KEY } })).json()) as { ok: boolean; data: { tier: number; name: string; capPct: number; strategies: unknown[] }[] };
  assert.equal(tiers.ok, true);
  assert.deepEqual(tiers.data.map((t) => t.name), ['Safe', 'Cautious', 'Moderate', 'Active', 'Aggressive']);
  assert.equal(tiers.data[4].capPct, 0.6, 'the top tier is 20% of the 3% budget');
  assert.ok(tiers.data.every((t) => t.strategies.length === 0));
});

test('PUT /api/tiers/config refuses a top tier above 20%', async () => {
  const headers = { 'x-api-key': KEY, 'content-type': 'application/json' };
  const bad = await fetch(`${base}/api/tiers/config`, { method: 'PUT', headers, body: JSON.stringify({ capSharePct: [50, 40, 30, 25, 21] }) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /cannot be set above 20%/);
  const ok = await fetch(`${base}/api/tiers/config`, { method: 'PUT', headers, body: JSON.stringify({ riskBudgetPct: 3 }) });
  assert.equal(ok.status, 200);
});

// I-7
import { inbox as realInbox } from '../inbox/instance.js';

test('GET /api/inbox returns open items; POST /api/inbox/:id/act acts on one', async () => {
  const headers = { 'x-api-key': KEY, 'content-type': 'application/json' };
  const { item } = realInbox.raise({ kind: 'losing_streak', title: 'Bot: 5 losing trades in a row', strategyId: 'bot1', dedupeKey: 'streak:bot1' });

  const list = (await (await fetch(`${base}/api/inbox`, { headers })).json()) as { ok: boolean; data: { id: string; status: string; actions: string[] }[] };
  assert.equal(list.ok, true);
  const row = list.data.find((i) => i.id === item.id);
  assert.ok(row, 'the open item is listed');
  assert.deepEqual(row!.actions, ['dismiss']);

  const bad = await fetch(`${base}/api/inbox/${item.id}/act`, { method: 'POST', headers, body: JSON.stringify({ action: 'launch' }) });
  assert.equal(bad.status, 400);
  const wrongButton = await fetch(`${base}/api/inbox/${item.id}/act`, { method: 'POST', headers, body: JSON.stringify({ action: 'approve' }) });
  assert.equal(wrongButton.status, 400, 'a button that is not on the card');

  const acted = await fetch(`${base}/api/inbox/${item.id}/act`, { method: 'POST', headers, body: JSON.stringify({ action: 'dismiss' }) });
  assert.equal(acted.status, 200);
  assert.equal(((await acted.json()) as { data: { status: string } }).data.status, 'dismissed');

  const again = await fetch(`${base}/api/inbox/${item.id}/act`, { method: 'POST', headers, body: JSON.stringify({ action: 'dismiss' }) });
  assert.equal(again.status, 409);

  const after = (await (await fetch(`${base}/api/inbox`, { headers })).json()) as { data: { id: string }[] };
  assert.ok(!after.data.some((i) => i.id === item.id));
  const dismissed = (await (await fetch(`${base}/api/inbox?status=dismissed`, { headers })).json()) as { data: { id: string }[] };
  assert.ok(dismissed.data.some((i) => i.id === item.id));
});

test('the e2e seed route is closed unless E2E_SEED=1', async () => {
  const r = await fetch(`${base}/api/inbox/_seed`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 404);
});

test('the API key is accepted in the header only, not in the address', async () => {
  const viaAddress = await fetch(`${base}/api/inbox?key=${KEY}`);
  assert.equal(viaAddress.status, 401);
  const viaHeader = await fetch(`${base}/api/inbox`, { headers: { 'x-api-key': KEY } });
  assert.equal(viaHeader.status, 200);
});

test('a web page from another site gets no CORS permission', async () => {
  const bad = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example.com' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const good = await fetch(`${base}/api/health`, { headers: { origin: 'http://localhost:8081' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:8081');
});

// AG-10
test('AG-10 the agent key works on the five agent routes and nothing else', async () => {
  config.agentKey = 'agent-key-0123456789abcdef0123456789';
  const headers = { 'x-agent-key': config.agentKey, 'content-type': 'application/json' };
  const call = (method: string, path: string) => fetch(base + path, { method, headers, body: method === 'GET' ? undefined : '{}' });

  for (const [method, path] of [
    ['GET', '/api/agent/dossier/none'],
    ['POST', '/api/agent/backtest'],
    ['POST', '/api/agent/llm'],
    ['POST', '/api/agent/notes'],
    ['POST', '/api/agent/proposals'],
  ]) {
    const res = await call(method, path);
    assert.ok(res.status !== 401 && res.status !== 403, `${method} ${path} is open to the agent key (got ${res.status})`);
  }

  for (const [method, path] of [
    ['POST', '/api/bots/str_x/start'],
    ['POST', '/api/chat/proposals/p1/approve'],
    ['POST', '/api/chat/proposals/p1/reject'],
    ['PUT', '/api/strategies/str_x'],
    ['DELETE', '/api/strategies/str_x'],
    ['POST', '/api/strategies'],
    ['POST', '/api/panic'],
    ['POST', '/api/agent-runs'],
    ['GET', '/api/strategies'],
    ['GET', '/api/inbox'],
    ['GET', '/api/agent'],
    ['DELETE', '/api/agent/notes'],
    ['GET', '/api/agent/llm'],
  ]) {
    const res = await call(method, path);
    assert.equal(res.status, 403, `${method} ${path} must be refused to the agent key`);
  }

  const wrong = await fetch(base + '/api/agent/notes', { method: 'POST', headers: { 'x-agent-key': 'nope', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(wrong.status, 401);
  config.agentKey = '';
  const off = await fetch(base + '/api/agent/notes', { method: 'POST', headers: { 'x-agent-key': '', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(off.status, 401, 'with no agent key configured nothing is accepted');
  const owner = await fetch(base + '/api/strategies', { headers: { 'x-api-key': KEY } });
  assert.equal(owner.status, 200, 'the owner key still opens everything');
});
