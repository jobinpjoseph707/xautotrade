import type { Broker } from '../broker/types.js';
import type { SymbolSpec } from '../engine/types.js';
import { DEFAULT_TIER, type TierConfig } from './config.js';
import { checkOrder, stopPointsOf, type OrderCheck, type RiskPosition } from './openRisk.js';

export interface GuardArgs {
  broker: Broker;
  strategyId: string;
  symbol: string;
  side: 'long' | 'short';
  lots: number;
  /** Price of the stop this order will carry. */
  slPrice: number | null;
  /** Price the stop distance is measured from. */
  entryRef: number;
  spec: SymbolSpec;
  equity: number;
}

export interface GuardDeps {
  config: () => TierConfig;
  tierOf: (strategyId: string) => number;
  /** Which strategy opened a position, from its comment tag. Null for a manual trade. */
  strategyIdOf: (comment: string | undefined) => string | null;
}

/** Builds the check the bot runner makes before every order. It only ever answers allowed or not: it closes nothing. */
export function createGuard(deps: GuardDeps): (a: GuardArgs) => Promise<OrderCheck> {
  return async (a) => {
    const specs = new Map<string, SymbolSpec>([[a.symbol, a.spec]]);
    const open: RiskPosition[] = [];
    for (const p of await a.broker.getPositions()) {
      let spec = specs.get(p.symbol);
      if (!spec) {
        spec = await a.broker.getSymbolSpec(p.symbol);
        specs.set(p.symbol, spec);
      }
      const owner = deps.strategyIdOf(p.comment);
      // A trade opened by hand with no stop has no risk we can measure to a stop, so it is left out of the caps
      // rather than counted as unlimited (which would silently stop every bot). One with a stop is counted.
      if (!owner && p.stopLoss == null) continue;
      open.push({
        strategyId: owner,
        symbol: p.symbol,
        side: p.side,
        lots: p.volume,
        stopPoints: stopPointsOf(p.openPrice, p.stopLoss, spec.point),
        pointValuePerLot: spec.pointValuePerLot,
        // A manual trade belongs to no strategy: count it in the middle tier rather than ignore it.
        tier: owner ? deps.tierOf(owner) : DEFAULT_TIER,
      });
    }
    const newRisk = a.lots * stopPointsOf(a.entryRef, a.slPrice, a.spec.point) * a.spec.pointValuePerLot;
    return checkOrder({ equity: a.equity, tier: deps.tierOf(a.strategyId), newRisk, symbol: a.symbol, side: a.side, open, config: deps.config() });
  };
}
