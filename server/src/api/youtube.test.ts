import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PaperBroker } from '../broker/paper.js';
import type { Candle, Timeframe } from '../engine/types.js';
import { generateCandles } from '../engine/synthetic.js';
import { ChatService } from '../chat/service.js';
import { fakeBackend, makeHost } from '../testkit/index.js';
import { createYoutubeRouter } from './youtube.js';

// The router is wired exactly as in production, except the broker is a stub that serves fixed candles
// (so the test never depends on the clock) and the transcript fetcher never touches the network.
// YT-1 proves the backtest reads the broker's candles, which in production are real MT5 history.

const FIXED_END = Date.UTC(2026, 0, 8, 18, 0, 0);
const CLEAR =
  "In this video I'm trading gold on the 5 minute chart. Buy when the 14 period RSI drops below 30. " +
  'Sell when RSI(14) rises above 70. I use a 2% stop loss and I risk 1% of my account per trade.';
const VAGUE = "Today I'm looking at gold. I buy whenever the setup looks strong and the momentum is there, and I sell when it feels right. Trust your gut.";
const URL_OK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

class StubBroker extends PaperBroker {
  asked: { symbol: string; timeframe: Timeframe; limit: number }[] = [];
  available = 4000;
  override async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    this.asked.push({ symbol, timeframe, limit });
    return generateCandles({ count: Math.min(limit, this.available), timeframe, startPrice: 2000, volatility: 0.0006, seed: 7, endTime: FIXED_END });
  }
}

let server: Server;
let base = '';
let transcript = CLEAR;
const broker = new StubBroker();
const { host, db } = makeHost();
const service = new ChatService({ backend: fakeBackend(''), host, bots: () => [], issues: () => [], learning: undefined });

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/youtube',
    createYoutubeRouter({ broker: () => broker, propose: (s, i) => service.proposeStrategy(s, i), fetcher: async () => transcript }),
  );
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}/api/youtube${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; data?: any } };
};

test('YT-1 a clear transcript becomes a candidate, backtested on the broker candles, and nothing is saved', async () => {
  transcript = CLEAR;
  broker.asked.length = 0;
  const r = await post('/extract', { url: URL_OK, symbol: 'xauusd' });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'candidate');
  assert.match(r.json.data.candidateId, /^yt_/);
  assert.equal(r.json.data.strategy.symbol, 'XAUUSD');
  assert.equal(r.json.data.strategy.timeframe, '5m');
  assert.equal(broker.asked.length, 1, 'candles came from the broker, once');
  assert.deepEqual({ symbol: broker.asked[0].symbol, timeframe: broker.asked[0].timeframe }, { symbol: 'XAUUSD', timeframe: '5m' });
  assert.equal(r.json.data.gate.bars, 3000);
  assert.equal(typeof r.json.data.gate.passed, 'boolean');
  assert.equal(db.size, 0, 'extracting saves nothing');
});

test('YT-2 proposing puts a pending proposal in front of the owner; only Approve saves it', async () => {
  transcript = CLEAR;
  const e = await post('/extract', { url: URL_OK, symbol: 'XAUUSD' });
  const p = await post('/propose', { candidateId: e.json.data.candidateId });
  assert.equal(p.status, 200);
  const proposal = p.json.data.proposal;
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.action.type, 'create_strategy');
  assert.equal(proposal.action.strategy.isTest, false, 'never a test rig');
  assert.ok(proposal.warnings.some((w: string) => /real MT5 backtest|FAILED the real-data backtest/i.test(w)), 'the real-data result is shown before Approve');
  assert.equal(db.size, 0, 'nothing saved before approval');

  const approved = await service.approve(proposal.id);
  assert.equal(approved.status, 'approved');
  assert.equal(db.size, 1);
});

test('YT-3 a vague transcript is sent for manual review with exact gaps and no candidate', async () => {
  transcript = VAGUE;
  const r = await post('/extract', { url: URL_OK });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'needs_review');
  assert.equal(r.json.data.candidateId, null);
  assert.equal(r.json.data.strategy, null);
  assert.ok(r.json.data.gaps.length > 0);
  const p = await post('/propose', { candidateId: 'yt_nope' });
  assert.equal(p.status, 404);
});

test('YT-4 bad input is refused with a readable message, and a candidate can only be proposed once', async () => {
  assert.equal((await post('/extract', { url: '' })).status, 400);
  const bad = await post('/extract', { url: 'https://example.com/video' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error!, /Not a recognisable YouTube URL/);
  assert.equal((await post('/extract', { url: URL_OK, timeframe: '7m' })).status, 400);

  transcript = CLEAR;
  const e = await post('/extract', { url: URL_OK });
  assert.equal((await post('/propose', { candidateId: e.json.data.candidateId })).status, 200);
  const again = await post('/propose', { candidateId: e.json.data.candidateId });
  assert.equal(again.status, 404);
  assert.match(again.json.error!, /expired/);
});

test('YT-5 too little broker history fails the gate with the reason instead of guessing', async () => {
  transcript = CLEAR;
  broker.available = 50;
  try {
    const r = await post('/extract', { url: URL_OK });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.gate.passed, false);
    assert.match(r.json.data.gate.reasons[0], /only 50 candles/);
  } finally {
    broker.available = 4000;
  }
});
