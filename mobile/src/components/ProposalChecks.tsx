import React from 'react';
import { Text, View } from 'react-native';

import { colors, font, radius, space } from '../theme';
import type { CriticVerdict, MetricsLite, Validation } from '../types';
import { Badge } from './ui';

const VTONE = { pass: 'good', fail: 'critical', insufficient: 'warning', skipped: 'neutral', error: 'warning' } as const;
const VLABEL = { pass: 'HELD UP ON UNSEEN DATA', fail: 'FAILED ON UNSEEN DATA', insufficient: 'UNPROVEN', skipped: 'NOT TESTED', error: 'CHECK FAILED' } as const;
const CTONE = { support: 'good', caution: 'warning', oppose: 'critical' } as const;

export function fmtMetrics(m: MetricsLite | null | undefined): string {
  if (!m) return '—';
  return `${m.trades} trades · ${m.netProfitPct >= 0 ? '+' : ''}${m.netProfitPct}% · PF ${m.profitFactor} · DD ${m.maxDrawdownPct}%`;
}

/** Unseen-data check and critic verdict, shown on a proposal card before Approve. */
export function ProposalChecks({ validation, critic }: { validation?: Validation; critic?: CriticVerdict }) {
  if (!validation && !critic) return null;
  const oos = validation?.outOfSample;
  return (
    <View style={{ gap: space.sm, marginTop: space.xs, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surfaceAlt }}>
      {validation ? (
        <View style={{ gap: 2 }}>
          <Badge label={VLABEL[validation.verdict]} tone={VTONE[validation.verdict]} />
          {oos ? (
            <>
              {oos.before ? <Text style={font.small}>Before: {fmtMetrics(oos.before)}</Text> : null}
              <Text style={font.small}>{oos.before ? 'After:  ' : 'Result: '}{fmtMetrics(oos.after)}</Text>
            </>
          ) : null}
          {validation.reasons.slice(oos ? 1 : 0, 3).map((r, i) => (
            <Text key={i} style={font.small}>{r}</Text>
          ))}
        </View>
      ) : null}
      {critic ? (
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', gap: space.xs, alignItems: 'center' }}>
            <Text style={font.label}>CRITIC</Text>
            <Badge label={critic.verdict.toUpperCase()} tone={CTONE[critic.verdict]} />
          </View>
          {critic.points.map((p, i) => (
            <Text key={i} style={{ color: colors.textSecondary, fontSize: 12 }}>• {p}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
