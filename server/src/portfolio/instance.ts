import { settings } from '../store.js';
import { DEFAULT_TIER_CONFIG, validateTierConfig, type TierConfig } from './config.js';
import { SqliteTierStore, tierOfStrategy } from './store.js';

/** The one tier history for the running server. */
export const tierStore = new SqliteTierStore();

const KEY = 'tierConfig';

/** The saved caps, or the defaults. A saved value that is no longer allowed is ignored, never trusted. */
export function loadTierConfig(): TierConfig {
  const saved = settings.get<Partial<TierConfig> | null>(KEY, null);
  if (!saved) return DEFAULT_TIER_CONFIG;
  try {
    return validateTierConfig({ ...DEFAULT_TIER_CONFIG, ...saved });
  } catch {
    return DEFAULT_TIER_CONFIG;
  }
}

/** Save new caps. Throws a plain sentence if they are not allowed (for example a top tier above 20%). */
export function saveTierConfig(c: TierConfig): TierConfig {
  validateTierConfig(c);
  settings.set(KEY, c);
  return c;
}

export const tierOf = (strategyId: string): number => tierOfStrategy(tierStore, strategyId).tier;
