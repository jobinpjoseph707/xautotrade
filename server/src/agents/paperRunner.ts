import { PaperBroker } from '../broker/paper.js';
import { runBacktest } from '../engine/backtest.js';
import { TIMEFRAME_MS } from '../engine/types.js';
import type { ActiveAgent, WeekOutcome } from './types.js';

/**
 * Run one agent-week against the PAPER broker's simulated market. This never
 * touches a live or demo MT5 account; it is the only runner wired up today.
 * The paper broker serves its most recent bars, so "the week" is the latest
 * seven days of the simulated series.
 */
export async function runWeekOnPaper(agent: ActiveAgent): Promise<WeekOutcome> {
  const broker = new PaperBroker(agent.startingBalance);
  await broker.connect();
  const spec = await broker.getSymbolSpec(agent.strategy.symbol);
  const bars = Math.floor((7 * 86_400_000) / TIMEFRAME_MS[agent.strategy.timeframe]);
  const candles = await broker.getCandles(agent.strategy.symbol, agent.strategy.timeframe, bars);
  const result = runBacktest(agent.strategy, candles, {
    initialBalance: agent.startingBalance,
    spec,
    maxEquityPoints: 1_000_000,
  });
  await broker.disconnect();
  return {
    startingBalance: agent.startingBalance,
    endingBalance: result.metrics.finalBalance,
    equityCurve: result.equity.map((e) => ({ time: e.time, equity: e.equity })),
    tradeCount: result.trades.length,
    trades: result.trades,
    gateBlocks: result.gateBlocks,
  };
}
