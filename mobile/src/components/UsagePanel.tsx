import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { ChatUsage } from '../types';
import { agentLabel, capLine, capTone, dayLabel, groupLine, USAGE_NOTE, USAGE_PERIODS, USAGE_TITLE } from '../logic/usage';
import { Card, Row, SectionTitle, Segmented } from './ui';

const TONE_COLOR = { critical: colors.criticalText, warning: colors.warning, neutral: undefined } as const;

/** Settings: how much Claude was used, by day and by agent, and the daily limit on automatic calls. */
export function UsagePanel() {
  const { api } = useApp();
  const [period, setPeriod] = useState<ChatUsage['period']>('7d');
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!api) return;
    api
      .chatUsage(period)
      .then((u) => alive && (setUsage(u), setFailed(false)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [api, period]);

  return (
    <View style={{ gap: space.sm, marginBottom: space.md }} accessibilityLabel="Claude use">
      <SectionTitle>{USAGE_TITLE}</SectionTitle>
      <Segmented value={period} onChange={setPeriod} options={USAGE_PERIODS.map((p) => ({ value: p.id, label: p.label }))} />
      <Card>
        {failed || !usage ? (
          <Text style={font.body}>{failed ? 'Usage is not available right now.' : 'Loading…'}</Text>
        ) : (
          <View style={{ gap: space.sm }}>
            <Text style={[font.h3, { color: TONE_COLOR[capTone(usage.unattended)] ?? colors.text }]}>{capLine(usage.unattended)}</Text>
            <Row label="Total" value={groupLine({ calls: usage.calls, totalTokens: usage.totalTokens, costUsd: usage.costUsd })} />
            {usage.byAgent.length > 0 && <Text style={[font.label, { marginTop: space.sm }]}>BY AGENT</Text>}
            {usage.byAgent.map((a) => (
              <Row key={a.agent} label={agentLabel(a.agent)} value={groupLine(a)} />
            ))}
            {usage.byDay.length > 0 && <Text style={[font.label, { marginTop: space.sm }]}>BY DAY</Text>}
            {usage.byDay.map((d) => (
              <Row key={d.day} label={dayLabel(d.day)} value={groupLine(d)} />
            ))}
            <Text style={font.small}>{USAGE_NOTE}</Text>
          </View>
        )}
      </Card>
    </View>
  );
}
