import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Badge, Button, Card } from '../components/ui';
import { outcomeLabel, POLL_MS, RUN_BUTTONS, shouldPoll, stepLine } from '../logic/agentRuns';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { AgentRun, Strategy } from '../types';

/** The agent team on one strategy: start a run, watch its steps appear, see how it ended. */
export function AgentRunPanel({ strategy }: { strategy: Strategy }) {
  const { api } = useApp();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [current, setCurrent] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async () => {
    if (!api) return;
    try {
      const list = await api.agentRuns(strategy.id);
      setRuns(list.slice(0, 3));
    } catch {
      /* the service may simply be off; the buttons say so when pressed */
    }
  }, [api, strategy.id]);

  useEffect(() => {
    void loadList();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loadList]);

  const follow = useCallback(
    (id: string) => {
      if (!api) return;
      const tick = async () => {
        try {
          const run = await api.agentRun(id);
          setCurrent(run);
          if (shouldPoll(run, Date.now())) timer.current = setTimeout(() => void tick(), POLL_MS);
          else void loadList();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      };
      void tick();
    },
    [api, loadList],
  );

  const start = async (kind: 'diagnose' | 'tune') => {
    if (!api || starting) return;
    setStarting(true);
    setError(null);
    try {
      const run = await api.startAgentRun(strategy.id, kind);
      setCurrent(run);
      follow(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const running = current?.status === 'running';
  const shown = current ?? null;
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ gap: space.sm }}>
        <Text style={font.h3}>Agent team</Text>
        <Text style={font.small}>Runs in the background. It cannot trade or change anything: a surviving idea only becomes a card in your Inbox.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {RUN_BUTTONS.map((b) => (
            <Button key={b.kind} title={b.label} accessibilityLabel={`${b.label}: ${b.hint}`} small variant="secondary" loading={starting} disabled={running} onPress={() => void start(b.kind)} />
          ))}
        </View>
        {error ? <Text style={[font.small, { color: colors.criticalText }]}>{error}</Text> : null}
        {shown ? <RunView run={shown} /> : null}
        {!shown && runs.length ? (
          <View style={{ gap: space.xs }}>
            <Text style={font.label}>RECENT RUNS</Text>
            {runs.map((r) => (
              <Text key={r.id} style={font.small}>
                {new Date(r.createdAt).toLocaleString()} · {r.kind} · {outcomeLabel(r.outcome)}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function RunView({ run }: { run: AgentRun }) {
  return (
    <View style={{ gap: space.xs }}>
      <Badge label={run.status === 'running' ? 'Working…' : outcomeLabel(run.outcome)} tone={run.outcome === 'proposal' ? 'good' : run.status === 'running' ? 'accent' : 'neutral'} />
      {run.steps.map((s, i) => (
        <Text key={i} style={font.small}>{stepLine(s)}</Text>
      ))}
      {run.summary ? <Text style={font.body}>{run.summary}</Text> : null}
    </View>
  );
}
