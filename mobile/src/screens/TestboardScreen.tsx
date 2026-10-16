import React, { useCallback, useEffect, useState } from 'react';
import { Text, View, Pressable } from 'react-native';

import { Badge, Button, Card, Empty, Loading, Page, PageHeader } from '../components/ui';
import { notify } from '../confirm';
import {
  canRunTest,
  daysLabel,
  EMPTY_BODY,
  EMPTY_TITLE,
  progressLabel,
  reasonsToShow,
  STAGE_LABEL,
  STAGES,
  stageState,
  TESTBOARD_SUBTITLE,
  verdictLine,
  verdictTone,
} from '../logic/testboard';
import { useApp } from '../store';
import { colors, font, radius, space } from '../theme';
import type { GateStage, TestboardEntry } from '../types';

function StagePill({ stage, current }: { stage: GateStage; current: GateStage }) {
  const state = stageState(current, stage);
  const locked = state === 'locked';
  const active = state === 'current';
  const label = locked ? `🔒 ${STAGE_LABEL[stage]}` : STAGE_LABEL[stage];
  return (
    <Pressable
      disabled
      accessibilityRole="text"
      accessibilityLabel={locked ? 'Live stage, locked' : `${STAGE_LABEL[stage]} stage, ${state === 'done' ? 'finished' : active ? 'current' : 'not reached'}`}
      accessibilityState={{ disabled: true, selected: active }}
      style={{
        paddingHorizontal: space.md,
        paddingVertical: 6,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.surfaceHover : 'transparent',
        opacity: state === 'later' || locked ? 0.7 : 1,
      }}
    >
      <Text style={[font.small, { color: active ? colors.text : colors.muted }]}>{state === 'done' ? `✓ ${label}` : label}</Text>
    </Pressable>
  );
}

export function TestboardScreen() {
  const { api } = useApp();
  const [rows, setRows] = useState<TestboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setRows(await api.testboard());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (e: TestboardEntry) => {
    if (!api) return;
    setBusy(e.strategyId);
    try {
      const r = await api.testboardRun(e.strategyId);
      if (r.refused) notify('Not tested yet', r.reason ?? 'It cannot be tested again yet.');
    } catch (err) {
      notify('Could not run the test', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await load();
    }
  };

  return (
    <Page>
      <PageHeader title="Testboard" subtitle={TESTBOARD_SUBTITLE} />
      {error ? <Text style={[font.body, { color: colors.criticalText }]}>Could not load the Testboard: {error}</Text> : null}
      {rows === null && !error ? <Loading label="Loading the Testboard" /> : null}
      {rows && rows.length === 0 ? <Empty title={EMPTY_TITLE} body={EMPTY_BODY} /> : null}
      <View style={{ gap: space.md }}>
        {(rows ?? []).map((e) => {
          const progress = progressLabel(e);
          const days = daysLabel(e);
          return (
            <Card key={e.strategyId}>
              <View style={{ gap: space.sm }}>
                <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text style={font.h3}>{e.name}</Text>
                  <Text style={font.small}>{e.symbol}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                  {STAGES.map((st) => (
                    <StagePill key={st} stage={st} current={e.stage} />
                  ))}
                </View>
                {progress ? (
                  <View style={{ flexDirection: 'row', gap: space.md, flexWrap: 'wrap' }}>
                    <Text style={font.body}>{progress}</Text>
                    {days ? <Text style={font.small}>{days}</Text> : null}
                  </View>
                ) : null}
                <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge label={verdictLine(e)} tone={verdictTone(e) === 'neutral' ? 'neutral' : verdictTone(e)} />
                </View>
                {reasonsToShow(e).map((r, i) => (
                  <Text key={i} style={font.small}>• {r}</Text>
                ))}
                {canRunTest(e) ? (
                  <View style={{ flexDirection: 'row' }}>
                    <Button small variant="secondary" title="Test now" loading={busy === e.strategyId} disabled={busy !== null} onPress={() => void run(e)} />
                  </View>
                ) : null}
              </View>
            </Card>
          );
        })}
      </View>
    </Page>
  );
}
