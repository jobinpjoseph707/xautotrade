import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chosenBroker } from '../config.js';

// B-1
test('B-1 no broker setting means no broker is chosen, so the server refuses to start instead of using fake data', () => {
  assert.equal(chosenBroker({}), null);
  assert.equal(chosenBroker({ BROKER: '' }), null);
  assert.equal(chosenBroker({ BROKER: 'nonsense' }), null);
  assert.equal(chosenBroker({ METAAPI_TOKEN: 'x' }), null, 'half a MetaApi login is not a choice');
});

// B-2
test('B-2 a broker written down on purpose is respected, case and spaces aside', () => {
  assert.equal(chosenBroker({ BROKER: 'mt5mcp' }), 'mt5mcp');
  assert.equal(chosenBroker({ BROKER: ' MT5MCP ' }), 'mt5mcp');
  assert.equal(chosenBroker({ BROKER: 'paper' }), 'paper');
  assert.equal(chosenBroker({ BROKER: 'metaapi' }), 'metaapi');
});

// B-3
test('B-3 credentials alone still select a broker, as before', () => {
  assert.equal(chosenBroker({ METAAPI_TOKEN: 't', METAAPI_ACCOUNT_ID: 'a' }), 'metaapi');
  assert.equal(chosenBroker({ MT5MCP_URL: 'http://localhost:8000' }), 'mt5mcp');
});
