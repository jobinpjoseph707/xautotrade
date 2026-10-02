import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryAgentStore } from '../agents/store.js';
import { PaperBroker } from '../broker/paper.js';
import { generateCandles } from '../engine/synthetic.js';
import type { SymbolSpec } from '../engine/types.js';
import { extractStrategy } from './extract.js';
import { EligibleStrategy, GateFailedError, runBacktestGate, type GateData } from './gate.js';
import { mapToStrategy, UnsupportedIndicatorError, type MapContext } from './map.js';
import { processTranscript, submitToRotation } from './pipeline.js';
import { fetchTranscript, parseVideoId } from './transcript.js';

const CLEAR =
  "In this video I'm trading gold on the 5 minute chart. Buy when the 14 period RSI drops below 30. " +
  'Sell when RSI(14) rises above 70. I use a 2% stop loss and I risk 1% of my account per trade.';

const VAGUE =
  "Today I'm looking at gold. I buy whenever the setup looks strong and the momentum is there, " +
  'and I sell when it feels right. Trust your gut and you will be fine.';

async function makeCtx(): Promise<{ ctx: MapContext; data: GateData }> {
  const broker = new PaperBroker();
  await broker.connect();
  const spec: SymbolSpec = await broker.getSymbolSpec('XAUUSD');
  const ctx: MapContext = { symbol: 'XAUUSD', spec, referencePrice: 2000, name: 'test' };
  const candles = generateCandles({ count: 6000, timeframe: '5m', startPrice: 2000, volatility: 0.0006, seed: 7, spreadPoints: spec.spreadPoints, digits: spec.digits });
  return { ctx, data: { candles, spec } };
}

test('clear transcript with explicit RSI thresholds and a % stop maps to the right config', async () => {
  const { ctx } = await makeCtx();
  const r = processTranscript(CLEAR, ctx);
  assert.equal(r.status, 'candidate');
  const s = r.strategy!;
  assert.equal(s.timeframe, '5m');
  assert.deepEqual(s.indicators, [{ id: 'rsi_14', type: 'rsi', source: 'close', params: { period: 14 } }]);
  assert.deepEqual(s.entryLong.conditions, [
    { left: { kind: 'indicator', id: 'rsi_14' }, op: 'lt', right: { kind: 'const', value: 30 } },
  ]);
  assert.deepEqual(s.entryShort.conditions, [
    { left: { kind: 'indicator', id: 'rsi_14' }, op: 'gt', right: { kind: 'const', value: 70 } },
  ]);
  // 2% of 2000 = 40 price units = 4000 points at point 0.01
  assert.equal(s.risk.slMode, 'points');
  assert.equal(s.risk.slPoints, 4000);
  assert.equal(s.risk.lotMode, 'percentRisk');
  assert.equal(s.risk.riskPercent, 1);
  assert.ok(r.notes.some((n) => n.includes('2% converted')));
  assert.equal(r.gaps.filter((g) => g.severity === 'blocking').length, 0);
});

test('a vague transcript is flagged for manual review, with no best-guess config', async () => {
  const { ctx } = await makeCtx();
  const r = processTranscript(VAGUE, ctx);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.strategy, null);
  const codes = r.gaps.map((g) => g.code);
  assert.ok(codes.includes('VAGUE_RULE'));
  assert.ok(codes.includes('NO_ENTRY_RULE'));
  assert.ok(codes.includes('NO_TIMEFRAME'));
  assert.ok(r.gaps.find((g) => g.code === 'VAGUE_RULE')!.evidence!.includes('looks strong'));
});

test('missing or ambiguous timeframe blocks, and an operator override resolves it', async () => {
  const { ctx } = await makeCtx();
  const noTf = 'Buy when RSI(14) drops below 30. Sell when RSI(14) rises above 70. Use a 50 point stop loss.';
  const a = processTranscript(noTf, ctx);
  assert.equal(a.status, 'needs_review');
  assert.ok(a.gaps.some((g) => g.code === 'NO_TIMEFRAME'));
  const b = processTranscript(noTf, { ...ctx, timeframe: '15m' });
  assert.equal(b.status, 'candidate');
  assert.equal(b.strategy!.timeframe, '15m');
  assert.equal(b.strategy!.risk.slPoints, 50);

  const multi = processTranscript('On the 1 hour chart find the trend, then on the 5 minute chart buy when RSI(14) drops below 30.', ctx);
  assert.ok(multi.gaps.some((g) => g.code === 'MULTIPLE_TIMEFRAMES'));
});

test('a missing stop is an explicit assumption, and a missing RSI period is flagged not silent', async () => {
  const { ctx } = await makeCtx();
  const r = processTranscript('On the 5 minute chart buy when RSI drops below 30.', ctx);
  assert.equal(r.status, 'candidate');
  const codes = r.gaps.map((g) => g.code);
  assert.ok(codes.includes('NO_STOP_LOSS'));
  assert.ok(codes.includes('RSI_PERIOD'));
  assert.ok(r.gaps.every((g) => g.severity === 'assumed'));
});

test('an indicator the engine lacks fails loudly at mapping time', async () => {
  const { ctx } = await makeCtx();
  const text = 'On the 15 minute chart buy when price closes above the vwap and the 14 period RSI is below 30.';
  const extracted = extractStrategy(text);
  assert.throws(() => mapToStrategy(extracted, ctx), UnsupportedIndicatorError);
  // Hand-built extraction referencing an unknown indicator also throws, not a silent config.
  const bad = { ...extractStrategy(CLEAR), entryLong: [[{ kind: 'unsupported' as const, name: 'ichimoku', evidence: 'x' }]] };
  assert.throws(() => mapToStrategy(bad, ctx), /ichimoku/);
  // The pipeline turns it into an explicit needs-review report.
  const r = processTranscript(text, ctx);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.gaps.some((g) => g.code === 'UNSUPPORTED_INDICATOR' && g.message.includes('vwap')));
});

test('MA cross, MACD and Bollinger rules reuse engine indicators', async () => {
  const { ctx } = await makeCtx();
  const r = processTranscript(
    'On the 1 hour chart buy when the 9 ema crosses above the 21 ema. Sell when MACD crosses below the signal line. Stop loss 300 points.',
    ctx,
  );
  assert.equal(r.status, 'candidate');
  const types = r.strategy!.indicators.map((i) => i.type).sort();
  assert.deepEqual(types, ['ema', 'ema', 'macd']);
  assert.equal(r.strategy!.entryLong.conditions[0].op, 'crossesAbove');
  assert.equal(r.strategy!.entryShort.conditions[0].op, 'crossesBelow');
  assert.ok(r.gaps.some((g) => g.code === 'MACD_PARAMS'));
});

test('gate: a passing strategy becomes eligible; the same strategy fails a stricter gate', async () => {
  const { ctx, data } = await makeCtx();
  const strategy = processTranscript(CLEAR, ctx).strategy!;
  const lenient = { minTrades: 5, maxDrawdownPct: 100, minProfitFactor: 0 };
  const e = await EligibleStrategy.fromGate(strategy, lenient, data);
  assert.ok(e.gate.trades >= 5);

  const strict = { ...lenient, minProfitFactor: 100 };
  const g = await runBacktestGate(strategy, strict, data);
  assert.equal(g.passed, false);
  await assert.rejects(() => EligibleStrategy.fromGate(strategy, strict, data), GateFailedError);
});

test('integration: a strategy that fails backtesting never reaches the rotation store', async () => {
  const { ctx, data } = await makeCtx();
  // RSI below 0 can never happen: zero trades, so the gate must refuse it.
  const never = processTranscript('On the 5 minute chart buy when RSI(14) drops below 0. Use a 50 point stop loss.', ctx);
  assert.equal(never.status, 'candidate');

  const store = new MemoryAgentStore();
  await assert.rejects(
    () => submitToRotation(store, never.strategy!, 10_000, new Date('2026-09-14'), { data }),
    (err: unknown) => err instanceof GateFailedError && /Only 0 trades/.test(err.message),
  );
  assert.equal(store.getActive(), null);
  assert.equal(store.allRecords().length, 0);

  // A strategy that passes the gate does reach it.
  const good = processTranscript(CLEAR, ctx).strategy!;
  const agent = await submitToRotation(store, good, 10_000, new Date('2026-09-14'), {
    data,
    criteria: { minTrades: 5, maxDrawdownPct: 100, minProfitFactor: 0 },
  });
  assert.equal(store.getActive()?.agentId, agent.agentId);
});

test('transcript helpers: video ids and empty transcripts', async () => {
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s'), 'dQw4w9WgXcQ');
  assert.equal(parseVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.throws(() => parseVideoId('https://example.com/x'), /recognisable/);
  assert.equal(await fetchTranscript('dQw4w9WgXcQ', async () => '  hello   world '), 'hello world');
  await assert.rejects(() => fetchTranscript('dQw4w9WgXcQ', async () => '   '), /empty/);
});
