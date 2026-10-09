// Usage (from server/, MT5 open and the bridge reachable):  npm run rank
// Backtests every non-test strategy under the current rules and prints a ranked table.
import { runBacktest } from '../src/engine/backtest.js';
import { validateStrategy } from '../src/engine/rules.js';
import { estimateServerOffset } from '../src/live/daily.js';
import { manager } from '../src/live/manager.js';
import { formatRank, rankStrategies, type RankInput } from '../src/scripts/rank.js';
import { settings, strategies } from '../src/store.js';

const BARS = Number(process.env.RANK_BARS ?? 5000);

const inputs: RankInput[] = [];
await manager.broker.connect();
for (const s of strategies.list().filter((x) => !x.isTest)) {
  const base = { id: s.id, name: s.name, symbol: s.symbol, timeframe: s.timeframe };
  const problems = validateStrategy(s);
  if (problems.length) {
    inputs.push({ ...base, refused: problems.join(' ') });
    continue;
  }
  try {
    const candles = await manager.broker.getCandles(s.symbol, s.timeframe, BARS);
    const spec = await manager.broker.getSymbolSpec(s.symbol);
    const quote = await manager.broker.getQuote(s.symbol);
    const serverOffsetMs = estimateServerOffset(quote.time, Date.now(), settings.get<number>('serverOffsetMs', 0));
    const r = runBacktest(s, candles, { initialBalance: 10_000, spec, serverOffsetMs });
    inputs.push({ ...base, trades: r.metrics.totalTrades, profitFactor: r.metrics.profitFactor, netProfitPct: r.metrics.netProfitPct, maxDrawdownPct: r.metrics.maxDrawdownPct });
  } catch (err) {
    inputs.push({ ...base, refused: `could not backtest: ${err instanceof Error ? err.message : String(err)}` });
  }
}
for (const line of formatRank(rankStrategies(inputs))) console.log(line);
process.exit(0);
