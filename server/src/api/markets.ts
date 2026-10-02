import type { MarketStatus } from '../broker/types.js';
import { manager } from '../live/manager.js';

const cache = new Map<string, MarketStatus>();
const TTL = 30_000;

/** Is a symbol offered / tradable / open right now? Cached 30 s per symbol (the MT5 bridge is serial). */
export async function marketStatus(symbol: string): Promise<MarketStatus> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.checkedAt < TTL) return hit;
  await manager.broker.connect();
  const b = manager.broker;
  const st: MarketStatus = b.getMarketStatus
    ? await b.getMarketStatus(symbol)
    : { symbol, available: true, tradeMode: null, open: null, lastTickAt: null, bid: null, ask: null, spreadPoints: null, description: null, reason: null, checkedAt: Date.now() };
  cache.set(key, st);
  return st;
}
