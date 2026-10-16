import type { Broker } from '../broker/types.js';
import { estimateServerOffset } from '../live/daily.js';
import type { Strategy } from '../engine/types.js';
import type { GateData } from './types.js';

/**
 * The gate's data from the connected broker (MT5 through the MCP bridge): the symbol's real
 * candles and real contract spec. Nothing is simulated. Throws if the broker has too little history.
 */
export async function realGateData(broker: Broker, strategy: Strategy, bars = 3000, savedOffsetMs = 0): Promise<GateData> {
  await broker.connect();
  const candles = await broker.getCandles(strategy.symbol, strategy.timeframe, bars);
  if (candles.length < 100) {
    throw new Error(`The broker returned only ${candles.length} candles for ${strategy.symbol} ${strategy.timeframe}, which is too few to test on.`);
  }
  const spec = await broker.getSymbolSpec(strategy.symbol);
  const quote = await broker.getQuote(strategy.symbol);
  return { candles, spec, serverOffsetMs: estimateServerOffset(quote.time, Date.now(), savedOffsetMs) };
}
