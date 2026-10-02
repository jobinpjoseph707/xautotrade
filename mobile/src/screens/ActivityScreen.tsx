import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { Badge, Card, Chip, DataTable, Empty, Field, Page, PageHeader, type Column } from '../components/ui';
import { useLayout } from '../layout';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { LogEntry } from '../types';

const LEVELS = ['all', 'trade', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];
const LEVEL_LABEL: Record<Level, string> = { all: 'Everything', trade: 'Trades', info: 'Info', warn: 'Warnings', error: 'Errors' };
const toneOf = (l: string) => (l === 'error' ? 'critical' : l === 'warn' ? 'warning' : l === 'trade' ? 'good' : 'accent');

export function ActivityScreen() {
  const { logs, strategies } = useApp();
  const { medium } = useLayout();
  const [level, setLevel] = useState<Level>('all');
  const [query, setQuery] = useState('');

  const names = useMemo(() => new Map(strategies.map((s) => [s.id, s.name])), [strategies]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: logs.length };
    for (const l of logs) c[l.level] = (c[l.level] ?? 0) + 1;
    return c;
  }, [logs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter(
      (l) =>
        (level === 'all' || l.level === level) &&
        (!q || l.message.toLowerCase().includes(q) || l.event.toLowerCase().includes(q) || (names.get(l.strategyId ?? '') ?? '').toLowerCase().includes(q)),
    );
  }, [logs, level, query, names]);

  const columns: Column<LogEntry>[] = [
    {
      key: 'time',
      title: 'Time',
      width: 150,
      render: (l) => (
        <View>
          <Text style={{ color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] }}>{new Date(l.ts).toLocaleTimeString()}</Text>
          <Text style={font.small}>{new Date(l.ts).toLocaleDateString()}</Text>
        </View>
      ),
    },
    { key: 'level', title: 'Type', width: 100, render: (l) => <Badge label={l.level.toUpperCase()} tone={toneOf(l.level) as any} /> },
    { key: 'bot', title: 'Bot', flex: 1.2, render: (l) => (l.strategyId ? names.get(l.strategyId) ?? l.strategyId : 'System') },
    { key: 'event', title: 'Event', flex: 0.9, render: (l) => <Text style={font.small}>{l.event}</Text> },
    {
      key: 'msg',
      title: 'Message',
      flex: 4,
      render: (l) => (
        <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }} numberOfLines={3}>
          {l.message}
        </Text>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader title="Activity" subtitle={`Live feed of what the bots did · last ${logs.length} events`} />

      <View style={{ flexDirection: medium ? 'row' : 'column', gap: space.md, alignItems: medium ? 'flex-end' : 'stretch', marginBottom: space.md }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, flex: 1 }}>
          {LEVELS.map((l) => (
            <Chip
              key={l}
              label={`${LEVEL_LABEL[l]} ${counts[l] ?? 0}`}
              active={level === l}
              tone={l === 'all' ? 'accent' : (toneOf(l) as any)}
              onPress={() => setLevel(l)}
            />
          ))}
        </View>
        <View style={{ width: medium ? 320 : '100%', marginBottom: -space.md }}>
          <Field label="Search" value={query} onChangeText={setQuery} placeholder="Message, event or bot…" />
        </View>
      </View>

      {filtered.length === 0 ? (
        <Card>
          <Empty
            title={logs.length ? 'No matching events' : 'Nothing here yet'}
            body={logs.length ? 'Try another filter or clear the search.' : 'Bot activity, orders and errors show up here as they happen.'}
          />
        </Card>
      ) : medium ? (
        <DataTable columns={columns} rows={filtered} keyOf={(l) => String(l.id ?? `${l.ts}-${l.event}`)} />
      ) : (
        <Card padded={false}>
          {filtered.map((l, i) => (
            <View
              key={l.id ?? `${l.ts}-${i}`}
              style={{ flexDirection: 'row', gap: space.md, padding: space.md, borderTopWidth: i ? 1 : 0, borderColor: colors.border }}
            >
              <View style={{ width: 62 }}>
                <Badge label={l.level.toUpperCase()} tone={toneOf(l.level) as any} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 14, lineHeight: 19 }}>{l.message}</Text>
                <Text style={[font.small, { marginTop: 2 }]}>
                  {new Date(l.ts).toLocaleTimeString()} · {l.strategyId ? names.get(l.strategyId) ?? l.strategyId : 'System'} · {l.event}
                </Text>
              </View>
            </View>
          ))}
        </Card>
      )}
    </Page>
  );
}
