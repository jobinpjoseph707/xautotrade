/** Pure risk-tier presentation rules (no React Native imports) so they can be unit-tested. */
import type { TierSummary } from '../types';

export const TIERS_TITLE = 'Risk tiers';
export const TIERS_NOTE = 'Open risk to the stop, as a share of equity. A full tier stops new orders only; nothing open is closed.';

const pct = (n: number) => `${n.toFixed(2)}%`;

export const capLabel = (t: Pick<TierSummary, 'capPct'>): string => `cap ${pct(t.capPct)}`;

/** "0.20% of 0.60%" or, when the broker could not be asked, just the cap. */
export function usageLabel(t: Pick<TierSummary, 'openRiskPct' | 'capPct'>): string {
  return t.openRiskPct == null ? 'open risk not available' : `${pct(t.openRiskPct)} of ${pct(t.capPct)}`;
}

/** Share of the cap in use, 0 to 1+ (null when unknown). */
export const usedShare = (t: Pick<TierSummary, 'openRiskPct' | 'capPct'>): number | null =>
  t.openRiskPct == null || t.capPct <= 0 ? null : t.openRiskPct / t.capPct;

export function usageTone(t: Pick<TierSummary, 'openRiskPct' | 'capPct'>): 'critical' | 'warning' | 'neutral' {
  const u = usedShare(t);
  return u == null ? 'neutral' : u >= 1 ? 'critical' : u >= 0.8 ? 'warning' : 'neutral';
}

/** Names for a tier's strategies, with "(provisional)" where the tier comes from a backtest. */
export const strategyLine = (t: Pick<TierSummary, 'strategies'>): string =>
  t.strategies.length === 0 ? 'No strategies' : t.strategies.map((s) => (s.provisional ? `${s.name} (provisional)` : s.name)).join(', ');
