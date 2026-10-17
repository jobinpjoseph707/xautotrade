/**
 * npm run strategy:youtube -- <url> [SYMBOL] [timeframe]
 * Prints the extracted candidate or the exact gaps needing manual review,
 * then runs the backtest check on candidates against real MT5 history (the
 * broker chosen in .env, through the MCP bridge). No simulated prices.
 * The app's Strategies > From YouTube does the same and sends the result to the Inbox.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Timeframe } from '../engine/types.js';
import { buildBroker } from '../live/manager.js';
import { REAL_DATA_GATE, realGateData, runBacktestGate } from './gate.js';
import { processVideo } from './pipeline.js';

const [url, symbol = 'XAUUSD', timeframe] = process.argv.slice(2);
if (!url) {
  console.error('usage: npm run strategy:youtube -- <youtube-url> [SYMBOL] [timeframe]');
  process.exit(1);
}
const broker = buildBroker();
if (broker.kind === 'paper') {
  console.error('No real broker is configured (BROKER=mt5mcp in .env). This tool only uses real MT5 data.');
  process.exit(1);
}
const r = await processVideo(url, {
  symbol,
  broker,
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
  const data = await realGateData(broker, r.strategy);
  console.log(`\nBacktesting on ${data.candles.length} real ${r.strategy.symbol} ${r.strategy.timeframe} candles from MT5...`);
  const g = await runBacktestGate(r.strategy, REAL_DATA_GATE, data);
  if (!g.passed) {
    console.log(`\nBacktest check FAILED: ${g.reasons.join(' ')}`);
    process.exit(3);
  }
  console.log(`\nBacktest check passed (${g.trades} trades, max DD ${g.maxDrawdownPct.toFixed(1)}%). It is still only an idea: use Strategies > From YouTube to send it to your Inbox.`);
  process.exit(0); // the MT5 bridge process would otherwise keep this open
} catch (err) {
  console.log(`\nBacktest check could not run: ${(err as Error).message}`);
  process.exit(3);
}
