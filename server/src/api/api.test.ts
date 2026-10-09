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
test('the inbox, testboard and tiers routers are mounted behind the key and start empty', async () => {
  for (const name of ['inbox', 'testboard', 'tiers']) {
    const res = await fetch(`${base}/api/${name}`, { headers: { 'x-api-key': KEY } });
    assert.equal(res.status, 200, name);
    assert.deepEqual(await res.json(), { ok: true, data: [] });
  }
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
