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
