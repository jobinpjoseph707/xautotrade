import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { TierSummary } from '../types';
import { capLabel, strategyLine, TIERS_NOTE, TIERS_TITLE, usageLabel, usageTone } from '../logic/tiers';
import { KpiRow, SectionTitle, StatTile } from './ui';

const TONE_COLOR = { critical: colors.criticalText, warning: colors.warning, neutral: undefined } as const;

/** Five tiles, safest to riskiest: how much of each tier's cap is in use, and who is in it. */
export function TierTiles() {
  const { api } = useApp();
  const [tiers, setTiers] = useState<TierSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!api) return;
      try {
        const t = await api.tiers();
        if (alive) setTiers(t);
      } catch {
        /* the tiles are informational; the rest of the Dashboard works without them */
      }
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api]);

  if (!tiers) return null;
  return (
    <View style={{ gap: space.sm }} accessibilityLabel="Risk tiers">
      <SectionTitle>{TIERS_TITLE}</SectionTitle>
      <KpiRow>
        {tiers.map((t) => (
          <StatTile
            key={t.tier}
            minWidth={140}
            label={`${t.tier} · ${t.name}`}
            value={usageLabel(t)}
            valueColor={TONE_COLOR[usageTone(t)]}
            sub={`${capLabel(t)} · ${strategyLine(t)}`}
          />
        ))}
      </KpiRow>
      <Text style={font.small}>{TIERS_NOTE}</Text>
    </View>
  );
}
