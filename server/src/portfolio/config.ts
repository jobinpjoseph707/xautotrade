/**
 * The risk tiers and their caps. A tier says how much a strategy has actually behaved like a risky one;
 * the cap says how much money may be at risk, to the stop, across everything in that tier at once.
 */
export const TIER_COUNT = 5;
export const TIER_NAMES = ['Safe', 'Cautious', 'Moderate', 'Active', 'Aggressive'] as const;

/** The riskiest tier can never be given more than this share of the budget. */
export const TOP_TIER_MAX_SHARE_PCT = 20;
/** A strategy nobody has measured yet is treated as this tier, and marked provisional. */
export const DEFAULT_TIER = 3;

export interface TierConfig {
  /** Account-wide open risk budget, % of equity. */
  riskBudgetPct: number;
  /** Per tier (index 0 = tier 1), the share of that budget the tier may use, in %. */
  capSharePct: number[];
  /** Markets that move together. Same direction in two of them is one bet. */
  groups: string[][];
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  riskBudgetPct: 3,
  capSharePct: [50, 40, 30, 25, 20],
  groups: [['EURUSD', 'GBPUSD']],
};

/** Throws a plain sentence when the config is not allowed. Used by every writer. */
export function validateTierConfig(c: TierConfig): TierConfig {
  if (!(c.riskBudgetPct > 0 && c.riskBudgetPct <= 10)) throw new Error('The risk budget must be more than 0% and at most 10% of equity.');
  if (c.capSharePct.length !== TIER_COUNT) throw new Error(`There must be exactly ${TIER_COUNT} tier caps.`);
  for (const v of c.capSharePct) {
    if (!(v > 0 && v <= 100)) throw new Error('Each tier cap must be a share between 0% and 100% of the budget.');
  }
  const top = c.capSharePct[TIER_COUNT - 1];
  if (top > TOP_TIER_MAX_SHARE_PCT) throw new Error(`The top tier cannot be set above ${TOP_TIER_MAX_SHARE_PCT}% of the budget (you asked for ${top}%).`);
  for (const g of c.groups) {
    if (!Array.isArray(g) || g.length < 2 || g.some((x) => typeof x !== 'string' || !x)) throw new Error('A group of linked markets needs at least two symbols.');
  }
  return c;
}

/** Open risk allowed for one tier, as % of equity. */
export const capPctOfEquity = (c: TierConfig, tier: number): number => (c.riskBudgetPct * (c.capSharePct[tier - 1] ?? 0)) / 100;

export const tierName = (tier: number): string => TIER_NAMES[tier - 1] ?? `Tier ${tier}`;
