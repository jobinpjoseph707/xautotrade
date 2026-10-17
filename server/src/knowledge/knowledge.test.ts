/**
 * The knowledge layer. Test IDs K-1 to K-8 are from docs/plan/xautotrade-test-plan.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { prepareProposals } from '../chat/actions.js';
import { buildPrompt } from '../chat/prompt.js';
import { macdMomentumScalp } from '../engine/presets.js';
import { buildLedger } from '../learning/ledger.js';
import type { ChangeRecord, MarketSnapshot } from '../learning/types.js';
import { getAgent } from '../chat/agents.js';
import { copiesText, ingestBookPaste, MAX_CONCEPT_CHARS, MAX_CONCEPTS_PER_PASTE } from './books.js';
import { addCompetitionMethod } from './competition.js';
import { KnowledgeGraph } from './graph.js';
import { addIdea, ideaStatus, knowledgeForPrompt, MAX_PROMPT_ITEMS, recordVideoIdea, statusOfIdea, statusText, type OutcomeLike } from './ideas.js';

let clock = 1000;
const fresh = () => {
  clock = 1000;
  return new KnowledgeGraph(new Database(':memory:'), () => clock);
};
const idea = (g: KnowledgeGraph, title: string, symbol = 'XAUUSD') => addIdea(g, { title, source: 'youtube', origin: title, symbol, entry: 'Buy when RSI(14) drops below 30.' });

test('K-1 neighbours and two-step paths are found', () => {
  const g = fresh();
  idea(g, 'A');
  g.addNode({ id: 's1', kind: 'strategy', title: 'S1', source: 'youtube' });
  g.addNode({ id: 'c1', kind: 'concept', title: 'Risk first', source: 'book', data: { book: 'B', page: 3 } });
  g.link('idea_youtube_a-a', 's1', 'built_as');
  g.link('c1', 'idea_youtube_a-a', 'about');
  assert.deepEqual(g.neighbours('idea_youtube_a-a').map((n) => n.id).sort(), ['c1', 's1']);
  assert.deepEqual(g.neighbours('idea_youtube_a-a', { rel: 'built_as' }).map((n) => n.id), ['s1']);
  assert.deepEqual(g.paths('c1', 's1'), [['c1', 'idea_youtube_a-a', 's1']], 'two steps, through the idea');
  assert.deepEqual(g.paths('c1', 's1', { maxHops: 1 }), [], 'not found within one step');
  assert.throws(() => g.link('c1', 'ghost', 'about'), /must exist/);
});

test('K-2 a contradicted link is closed, not deleted', () => {
  const g = fresh();
  idea(g, 'A');
  g.addNode({ id: 's1', kind: 'strategy', title: 'S1', source: 'youtube' });
  const e = g.link('idea_youtube_a-a', 's1', 'built_as');
  clock = 2000;
  g.contradict(e.id, 'two scored changes hurt');
  assert.deepEqual(g.neighbours('idea_youtube_a-a'), [], 'no longer holds now');
  assert.deepEqual(g.neighbours('idea_youtube_a-a', { at: 1500 }).map((n) => n.id), ['s1'], 'it held before it was closed');
  const h = g.history('idea_youtube_a-a');
  assert.equal(h.length, 1, 'still in the history');
  assert.equal(h[0].validUntil, 2000);
  assert.match(h[0].note, /Closed: two scored changes hurt/);
  g.contradict(e.id, 'again');
  assert.equal(g.edge(e.id)!.validUntil, 2000, 'closing twice changes nothing');
  assert.equal(g.link('idea_youtube_a-a', 's1', 'built_as').id !== e.id, true, 'a new link can be made later; the old one stays closed');
});

test('K-3 a video strategy arrives as an idea with a source tag, linked to a strategy created at the backtest stage', () => {
  const g = fresh();
  const s = { ...macdMomentumScalp('XAUUSD'), id: 'yt_abc', name: 'YouTube vid1', symbol: 'XAUUSD', timeframe: '5m' as const };
  const n = recordVideoIdea(g, s, 'vid1');
  assert.equal(n.source, 'youtube');
  assert.equal(n.data.origin, 'vid1');
  assert.deepEqual(g.neighbours(n.id, { rel: 'built_as' }).map((x) => x.id), ['yt_abc']);

  // The strategy itself can only be created through the proposal path, which forces the first stage and the app's own settings.
  const host = { get: () => null, list: () => [] } as never;
  const sneaky = { ...s, gate: 'live', isTest: true, tier: 5, risk: { ...s.risk, fixedLot: 0.01 } };
  const prepared = prepareProposals([{ type: 'create_strategy', strategy: sneaky }], getAgent('strategist')!, host, () => 'id12345678');
  const made = (prepared.proposals[0].action as { strategy: { gate?: string; isTest?: boolean; tier?: number } }).strategy;
  assert.equal(made.gate, 'backtest');
  assert.equal(made.isTest, false);
  assert.equal(made.tier, undefined);
});

test('K-5 a book note keeps the concept and the page number, not the paragraph', async () => {
  const g = fresh();
  const pasted = 'Chapter 4. A trader who risks too much on one idea will not survive long enough to learn whether the idea was any good, because the arithmetic of drawdown is unforgiving. '.repeat(5);
  const copy = 'A trader who risks too much on one idea will not survive long enough to learn whether the idea was any good';
  const out = await ingestBookPaste(g, { book: 'Trading Basics', page: 41, pasted }, async () => ['Size positions so a losing run cannot end the account.', copy, 'x'.repeat(500)]);
  assert.equal(out.kept.length, 2);
  assert.ok(out.kept.every((n) => n.title.length <= MAX_CONCEPT_CHARS));
  assert.ok(out.kept.every((n) => n.data.page === 41 && n.data.book === 'Trading Basics'));
  assert.equal(out.dropped.length, 1);
  assert.match(out.dropped[0], /copies the book's own words/);

  // Nothing of the pasted text is in the database.
  const stored = JSON.stringify(g.nodes());
  assert.ok(!copiesText(stored, pasted), 'no 40-character run of the paste is stored');
  assert.ok(!stored.includes('arithmetic of drawdown'));

  const lots = await ingestBookPaste(g, { book: 'Trading Basics', page: 50, pasted: 'short chapter' }, async () => Array.from({ length: 12 }, (_, i) => `note ${i}`));
  assert.equal(lots.kept.length, MAX_CONCEPTS_PER_PASTE);
  await assert.rejects(() => ingestBookPaste(g, { book: '', page: 1, pasted: 'x' }, async () => []), /which book/);
  await assert.rejects(() => ingestBookPaste(g, { book: 'B', page: 0, pasted: 'x' }, async () => []), /page number/);
  await assert.rejects(() => ingestBookPaste(g, { book: 'B', page: 1, pasted: 'x'.repeat(70_000) }, async () => []), /too long/);
});

test('competition methods keep the entry idea and throw the sizing away', () => {
  const g = fresh();
  const n = addCompetitionMethod(g, { competition: 'Summer Cup', name: 'Breakout 1', symbol: 'xauusd', entry: 'Buy a break of the Asian high.', sizing: 'risk 20% per trade, 5 lots' });
  assert.equal(n.data.symbol, 'XAUUSD');
  assert.ok(!JSON.stringify(g.nodes()).includes('20%'), 'the sizing is nowhere in the database');
  assert.throws(() => addCompetitionMethod(g, { competition: '', name: 'x', entry: 'y' }), /Give the competition/);
});

const out = (over: Partial<OutcomeLike>): OutcomeLike => ({ strategyId: 's1', status: 'approved', score: 'helped', ...over });
const mine = new Set(['s1']);

test('K-6 an idea\'s status comes from measured outcomes only', () => {
  assert.equal(statusText(ideaStatus([], mine)), 'untested');
  assert.equal(statusText(ideaStatus([out({})], mine)), 'supported by 1 outcome');
  assert.equal(statusText(ideaStatus([out({}), out({})], mine)), 'supported by 2 outcomes');
  assert.equal(statusText(ideaStatus([out({ score: 'hurt' })], mine)), 'untested', 'one bad result is not a verdict');
  assert.equal(statusText(ideaStatus([out({ score: 'hurt' }), out({ score: 'hurt' })], mine)), 'contradicted by 2 outcomes');
  assert.equal(statusText(ideaStatus([out({}), out({ score: 'hurt' })], mine)), 'untested', 'mixed stays untested');
  // Things that are not measured outcomes of this idea's strategies count for nothing.
  const noise = [out({ strategyId: 'other' }), out({ status: 'rejected' }), out({ score: 'pending' }), out({ score: 'inconclusive' }), out({ strategyId: null })];
  assert.equal(statusText(ideaStatus(noise, mine)), 'untested');
});

test('K-6 status follows the link: only strategies built from the idea count, and a closed link stops counting', () => {
  const g = fresh();
  const n = idea(g, 'A');
  g.addNode({ id: 's1', kind: 'strategy', title: 'S1', source: 'youtube' });
  const e = g.link(n.id, 's1', 'built_as');
  assert.equal(statusText(statusOfIdea(g, n, [out({})])), 'supported by 1 outcome');
  g.contradict(e.id, 'withdrawn');
  assert.equal(statusText(statusOfIdea(g, n, [out({})])), 'untested');
});

function record(over: Partial<ChangeRecord>): ChangeRecord {
  const market: MarketSnapshot = { symbol: 'XAUUSD', timeframe: '1m', bars: 500, atrPct: 0.02, trendPct: 0.5, avgSpreadPoints: 20 };
  const at = Date.UTC(2026, 9, 1);
  return {
    id: `r${Math.random()}`, createdAt: at, source: 'chat', agent: 'optimizer', model: 'fake', actionType: 'update_strategy', strategyId: 's1', symbol: 'XAUUSD', timeframe: '1m',
    summary: 's', signatures: ['risk.slPoints:down'], before: null, after: null, warnings: [], status: 'approved', score: 'hurt', scoreReasons: [], market, decidedAt: at, scoredAt: at,
    followUp: { measuredAt: at, demo: { from: 0, to: 1, trades: 30, netProfit: -5 } }, ...over,
  };
}

test('K-7 a book can never change a lesson\'s score', async () => {
  const history = Array.from({ length: 6 }, () => record({}));
  const before = JSON.stringify(buildLedger(history, Date.UTC(2026, 9, 2)));
  const g = fresh();
  await ingestBookPaste(g, { book: 'B', page: 2, pasted: 'chapter' }, async () => ['Widen stops in quiet markets.', 'Tighter stops always help.']);
  idea(g, 'A');
  assert.equal(JSON.stringify(buildLedger(history, Date.UTC(2026, 9, 2))), before, 'the same lessons with the same scores');

  // And the wall is structural: nothing in learning/ can even read the knowledge layer.
  const dir = new URL('../learning/', import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    assert.ok(!/knowledge\//.test(readFileSync(join(dir, f), 'utf8')), `learning/${f} must not import the knowledge layer`);
  }
});

test('K-8 at most five knowledge items reach a prompt, and only the right market', async () => {
  const g = fresh();
  for (let i = 0; i < 9; i++) idea(g, `Gold idea ${i}`);
  for (let i = 0; i < 4; i++) idea(g, `Euro idea ${i}`, 'EURUSD');
  await ingestBookPaste(g, { book: 'B', page: 2, pasted: 'chapter' }, async () => ['a', 'b', 'c', 'd', 'e']);
  const lines = knowledgeForPrompt(g, [], { symbols: ['XAUUSD'] });
  assert.equal(lines.length, MAX_PROMPT_ITEMS);
  assert.ok(lines.every((l) => !/Euro idea/.test(l)), 'a EURUSD idea does not reach a gold prompt');
  assert.ok(lines.every((l) => l.length <= 260));
  assert.ok(lines.every((l) => /Status: untested/.test(l)), 'each idea says what has been measured');

  const few = fresh();
  idea(few, 'Only one');
  await ingestBookPaste(few, { book: 'B', page: 7, pasted: 'chapter' }, async () => ['Keep risk small.']);
  const mixed = knowledgeForPrompt(few, [], { symbols: ['XAUUSD'] });
  assert.equal(mixed.length, 2);
  assert.match(mixed[1], /book note, not evidence/);

  // The prompt shows the section only when there is something to show.
  const base = { agent: getAgent('strategist')!, message: 'hi', history: [], strategies: [], bots: [], issues: [] };
  assert.ok(!buildPrompt(base).includes('IDEAS AND BOOK NOTES'));
  assert.ok(buildPrompt({ ...base, knowledge: mixed }).includes('IDEAS AND BOOK NOTES'));
});
