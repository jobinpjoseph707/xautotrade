import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';

import { Badge, Banner, Button, Card, Chip, DataTable, Empty, Field, Page, PageHeader, SectionTitle, Sheet, StatusPill, marketBlocked, marketState, type Column } from '../components/ui';
import { useLayout } from '../layout';
import { SymbolPicker } from '../components/SymbolPicker';
import { confirmAction, notify } from '../confirm';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { Strategy } from '../types';
import { StrategyChatSheet } from './StrategyChatSheet';

export function StrategiesScreen({
  onEdit,
  onBacktest,
  onDetails,
  onNew,
}: {
  onEdit: (s: Strategy) => void;
  onBacktest: (s: Strategy) => void;
  onDetails: (s: Strategy) => void;
  onNew: () => void;
}) {
  const { api, strategies, catalog, bots, markets, refreshStrategies, refresh } = useApp();
  const mk = (s: Strategy) => markets[s.symbol.toUpperCase()];
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [chatting, setChatting] = useState<Strategy | null>(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<string>('ema-pullback');
  const [symbol, setSymbol] = useState('EURUSD');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const { medium } = useLayout();


  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshStrategies();
    setRefreshing(false);
  }, [refreshStrategies]);

  const create = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const s = await api.createStrategy({
        preset: preset === 'blank' ? undefined : preset,
        symbol: symbol.trim().toUpperCase() || 'EURUSD',
        name: name.trim() || undefined,
      });
      await refreshStrategies();
      setCreating(false);
      setName('');
      onEdit(s);
    } catch (err) {
      notify('Could not create', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (s: Strategy) => {
    confirmAction(
      'Delete strategy?',
      `"${s.name}" and its saved backtests will be removed.`,
      'Delete',
      async () => {
        try {
          await api!.deleteStrategy(s.id);
          await refresh();
        } catch (err) {
          notify('Failed', err instanceof Error ? err.message : String(err));
        }
      },
      { destructive: true },
    );
  };

  const toggleBot = async (s: Strategy) => {
    const bot = bots[s.id];
    try {
      if (bot?.status === 'running') await api!.stopBot(s.id);
      else await api!.startBot(s.id);
      await refresh();
    } catch (err) {
      notify('Failed', err instanceof Error ? err.message : String(err));
    }
  };

  const q = query.trim().toLowerCase();
  const shown = q ? strategies.filter((s) => s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q)) : strategies;

  const columns: Column<Strategy>[] = [
    {
      key: 'name',
      title: 'Strategy',
      flex: 2.4,
      render: (s) => (
        <View>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
            {s.name}
          </Text>
          {marketBlocked(mk(s)) ? (
            <Text style={{ color: colors.criticalText, fontSize: 12 }} numberOfLines={2}>
              {mk(s)!.reason}
            </Text>
          ) : (
            <Text style={font.small} numberOfLines={1}>
              {s.indicators.length} indicators · {s.entryLong.conditions.length + s.entryShort.conditions.length} entry rules
            </Text>
          )}
        </View>
      ),
    },
    {
      key: 'market',
      title: 'Market',
      flex: 1.3,
      render: (s) => (
        <View style={{ gap: 3 }}>
          <Text style={{ color: colors.text, fontSize: 13 }}>
            {s.symbol} · {s.timeframe}
          </Text>
          <StatusPill status={marketState(mk(s))} />
        </View>
      ),
    },
    { key: 'status', title: 'Bot', flex: 1, render: (s) => <StatusPill status={bots[s.id]?.status ?? 'stopped'} /> },
    { key: 'size', title: 'Size', flex: 1, render: (s) => describeSize(s) },
    { key: 'sl', title: 'Stop', flex: 1, render: (s) => describeStop(s) },
    { key: 'cap', title: 'Daily cap', flex: 0.9, align: 'right', render: (s) => `${s.risk.maxDailyLossPercent}%` },
    {
      key: 'actions',
      title: '',
      width: 380,
      align: 'right',
      render: (s) => {
        const live = bots[s.id]?.status === 'running';
        return (
          <View style={{ flexDirection: 'row', gap: space.xs }}>
            <Button title="💬" accessibilityLabel={`Chat about ${s.name}`} small variant="ghost" onPress={() => setChatting(s)} />
            <Button title="Details" small variant="ghost" onPress={() => onDetails(s)} />
            <Button title="Backtest" small variant="ghost" onPress={() => onBacktest(s)} />
            <Button
              title={live ? 'Stop' : 'Start'}
              small
              variant={live ? 'secondary' : 'success'}
              disabled={!live && marketBlocked(mk(s))}
              accessibilityLabel={!live && marketBlocked(mk(s)) ? `Can't start: ${s.symbol} is not tradable on this account` : undefined}
              onPress={() => toggleBot(s)}
              style={{ minWidth: 64 }}
            />
            <Button title="✕" accessibilityLabel={`Delete ${s.name}`} small variant="ghost" onPress={() => remove(s)} />
          </View>
        );
      },
    },
  ];

  return (
    <>
      <Page refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}>
        <PageHeader
          title="Strategies"
          subtitle={`${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'} · ${Object.values(bots).filter((b) => b.status === 'running').length} running`}
          right={<Button title="New strategy" icon="+" small onPress={onNew} />}
        />

        {strategies.length > 3 ? (
          <View style={{ marginBottom: space.md, maxWidth: 420 }}>
            <Field label="Search" value={query} onChangeText={setQuery} placeholder="Name or symbol…" />
          </View>
        ) : null}

        {strategies.length === 0 ? (
          <Card>
            <Empty
              title="No strategies yet"
              body="Start from a preset scalping strategy and tune it, or build one from scratch in the rule builder."
              action={<Button title="Create your first strategy" small onPress={onNew} />}
            />
          </Card>
        ) : medium ? (
          <DataTable
            columns={columns}
            rows={shown}
            keyOf={(s) => s.id}
            onRowPress={onEdit}
            rowLabel={(s) => `${s.name}. Open the editor.`}
            empty={<Text style={font.body}>No strategy matches “{query}”.</Text>}
          />
        ) : (
          shown.map((s) => {
            const bot = bots[s.id];
            const live = bot?.status === 'running';
            return (
              <Card key={s.id} style={{ marginBottom: space.sm }}>
                <Pressable onPress={() => onEdit(s)} accessibilityRole="button" accessibilityLabel={`${s.name}. Edit.`}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
                    <View style={{ flex: 1 }}>
                      <Text style={font.h3}>{s.name}</Text>
                      <Text style={font.small}>
                        {s.symbol} · {s.timeframe} · {s.indicators.length} indicators ·{' '}
                        {s.entryLong.conditions.length + s.entryShort.conditions.length} entry rules
                      </Text>
                    </View>
                    <View style={{ gap: 4, alignItems: 'flex-end' }}>
                      <StatusPill status={bot?.status ?? 'stopped'} />
                      <StatusPill status={marketState(mk(s))} />
                    </View>
                  </View>
                  {marketBlocked(mk(s)) ? (
                    <View style={{ marginTop: space.sm }}>
                      <Banner tone="critical">{mk(s)!.reason}</Banner>
                    </View>
                  ) : null}

                  <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.md, flexWrap: 'wrap' }}>
                    <Chip label={`Size ${describeSize(s)}`} />
                    <Chip label={`SL ${describeStop(s)}`} />
                    <Chip label={`Max loss ${s.risk.maxDailyLossPercent}%/day`} />
                  </View>
                </Pressable>

                <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
                  <Button title="💬" accessibilityLabel={`Chat about ${s.name}`} variant="secondary" small onPress={() => setChatting(s)} />
                  <Button title="Details" variant="secondary" small style={{ flex: 1 }} onPress={() => onDetails(s)} />
                  <Button title="Backtest" variant="secondary" small style={{ flex: 1 }} onPress={() => onBacktest(s)} />
                  <Button
                    title={live ? 'Stop' : 'Start'}
                    variant={live ? 'secondary' : 'success'}
                    small
                    style={{ flex: 1 }}
                    disabled={!live && marketBlocked(mk(s))}
                    onPress={() => toggleBot(s)}
                  />
                  <Button title="Delete" variant="ghost" small onPress={() => remove(s)} />
                </View>
              </Card>
            );
          })
        )}
      </Page>
      <StrategyChatSheet strategy={chatting} onClose={() => setChatting(null)} />

      <Sheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="New strategy"
        footer={
          <>
            <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={() => setCreating(false)} />
            <Button title="Create" style={{ flex: 2 }} loading={busy} onPress={create} />
          </>
        }
      >
        <Banner tone="accent">
          Presets are working examples, not advice. Backtest and forward-test on demo before risking money.
        </Banner>

        <SectionTitle>Start from</SectionTitle>
        {(catalog?.presets ?? []).map((p) => (
          <Pressable key={p.key} onPress={() => setPreset(p.key)}>
            <Card
              style={{
                marginBottom: space.sm,
                // A preset carrying a warning is not a strategy — colour it as a
                // caution so it can't be picked up by mistake.
                borderColor: p.warning
                  ? colors.warning
                  : preset === p.key
                    ? colors.accent
                    : colors.border,
                backgroundColor: preset === p.key
                  ? (p.warning ? 'rgba(250,178,25,0.12)' : colors.accentDim)
                  : colors.surface,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Text style={[font.h3, { flex: 1 }]}>{p.label}</Text>
                {p.warning ? <Badge label="TEST ONLY" tone="warning" /> : null}
              </View>
              <Text style={[font.small, { marginTop: 2 }]}>{p.description}</Text>
              {p.warning ? (
                <View style={{ marginTop: space.sm }}>
                  <Banner tone="warning">{p.warning}</Banner>
                </View>
              ) : null}
            </Card>
          </Pressable>
        ))}
        <Pressable onPress={() => setPreset('blank')}>
          <Card
            style={{
              marginBottom: space.lg,
              borderColor: preset === 'blank' ? colors.accent : colors.border,
              backgroundColor: preset === 'blank' ? colors.accentDim : colors.surface,
            }}
          >
            <Text style={font.h3}>Blank strategy</Text>
            <Text style={[font.small, { marginTop: 2 }]}>
              A bare 9/21 EMA crossover you can rebuild entirely in the rule builder.
            </Text>
          </Card>
        </Pressable>

        <SymbolPicker value={symbol} onChange={setSymbol} />
        <Field label="Name (optional)" value={name} onChangeText={setName} placeholder="leave blank to use the preset name" autoCapitalize="sentences" />
      </Sheet>
    </>
  );
}

function describeSize(s: Strategy): string {
  return s.risk.lotMode === 'fixed' ? `${s.risk.fixedLot} lots` : `${s.risk.riskPercent}% risk`;
}

function describeStop(s: Strategy): string {
  if (s.risk.slMode === 'none') return 'off';
  if (s.risk.slMode === 'atr') return `${s.risk.slAtrMult}× ATR`;
  return `${s.risk.slPoints} pts`;
}
