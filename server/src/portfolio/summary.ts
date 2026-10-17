import type { Strategy } from '../engine/types.js';
import { TIER_COUNT, capPctOfEquity, tierName, type TierConfig } from './config.js';
import { positionRisk, type RiskPosition } from './openRisk.js';
import type { TierRecord } from './store.js';
import { DEFAULT_TIER } from './config.js';

export interface TierSummary {
  tier: number;
  name: string;
  /** Open risk allowed in this tier, % of equity. */
  capPct: number;
  /** Open risk right now, % of equity. Null when the broker could not be asked. */
  openRiskPct: number | null;
  strategies: { id: string; name: string; provisional: boolean }[];
}

/** One entry per tier, always five, with who is in it and how much of the cap is used. */
export function tierSummary(input: {
  config: TierConfig;
  strategies: Pick<Strategy, 'id' | 'name' | 'isTest'>[];
  records: TierRecord[];
  open: RiskPosition[] | null;
  equity: number;
}): TierSummary[] {
  const rec = new Map(input.records.map((r) => [r.strategyId, r]));
  const out: TierSummary[] = [];
  for (let tier = 1; tier <= TIER_COUNT; tier++) {
    out.push({
      tier,
      name: tierName(tier),
      capPct: capPctOfEquity(input.config, tier),
      openRiskPct: input.open && input.equity > 0 ? (input.open.filter((p) => p.tier === tier).reduce((a, p) => a + positionRisk(p), 0) / input.equity) * 100 : null,
      strategies: [],
    });
  }
  for (const s of input.strategies) {
    if (s.isTest) continue;
    const r = rec.get(s.id);
    const tier = r?.state.tier ?? DEFAULT_TIER;
    out[tier - 1].strategies.push({ id: s.id, name: s.name, provisional: r?.provisional ?? true });
  }
  return out;
}
