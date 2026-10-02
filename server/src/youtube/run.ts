/**
 * npm run strategy:youtube -- <url> [SYMBOL] [timeframe]
 * Prints the extracted candidate or the exact gaps needing manual review,
 * then runs the backtest gate on candidates.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Timeframe } from '../engine/types.js';
import { EligibleStrategy } from './gate.js';
import { processVideo } from './pipeline.js';

const [url, symbol = 'XAUUSD', timeframe] = process.argv.slice(2);
if (!url) {
  console.error('usage: npm run strategy:youtube -- <youtube-url> [SYMBOL] [timeframe]');
  process.exit(1);
}
const r = await processVideo(url, {
  symbol,
  timeframe: timeframe as Timeframe | undefined,
  onTranscript: (text) => {
    // Saved so you can read what the extractor actually saw.
    mkdirSync('data', { recursive: true });
    writeFileSync('data/last-transcript.txt', text);
    console.log(`Transcript: ${text.length} characters saved to data/last-transcript.txt`);
  },
});
for (const g of r.gaps) console.log(`[${g.severity}] ${g.code}: ${g.message}${g.evidence ? `  ("${g.evidence}")` : ''}`);
for (const n of r.notes) console.log(`note: ${n}`);
if (r.status === 'needs_review') {
  console.log('\nNEEDS MANUAL REVIEW - no config produced.');
  process.exit(2);
}
console.log('\nCandidate strategy:\n' + JSON.stringify(r.strategy, null, 2));
try {
  const e = await EligibleStrategy.fromGate(r.strategy);
  console.log(`\nBacktest gate PASSED (${e.gate.trades} trades, max DD ${e.gate.maxDrawdownPct.toFixed(1)}%). Eligible for agent rotation.`);
} catch (err) {
  console.log(`\nBacktest gate FAILED: ${(err as Error).message}\nNot eligible for agent rotation.`);
  process.exit(3);
}
