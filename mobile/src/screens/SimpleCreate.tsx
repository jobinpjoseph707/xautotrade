import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { SymbolPicker } from '../components/SymbolPicker';
import { Badge, Banner, Button, Card, Chip, Explain, Row, SectionTitle } from '../components/ui';
import { notify } from '../confirm';
import { useApp } from '../store';
import { colors, font, radius, space } from '../theme';
import type { RiskConfig, Strategy } from '../types';

/**
 * Guided strategy creation.
 *
 * The full editor exposes ~25 settings across three tabs. That is the right
 * tool once you know what a stop loss and an ATR multiple are, and the wrong
 * one when you don't — the burden lands before any understanding does.
 *
 * This asks three questions in plain language, derives everything else from
 * them, and shows exactly what it decided so the mapping stays visible rather
 * than magic. The full editor is one tap away and unchanged.
 */

type Style = 'careful' | 'balanced' | 'active';

const STYLES: {
  key: Style;
  label: string;
  blurb: string;
  detail: string;
  preset: string;
}[] = [
  {
    key: 'careful',
    label: 'Careful',
    blurb: 'Waits for stronger signals. Fewer trades.',
    detail: 'Only trades when price is trending clearly. You may go hours without a trade.',
    preset: 'ema-pullback',
  },
  {
    key: 'balanced',
    label: 'Balanced',
    blurb: 'A middle setting. Moderate number of trades.',
    detail: 'Follows momentum shifts. A reasonable starting point if you are unsure.',
    preset: 'macd-momentum',
  },
  {
    key: 'active',
    label: 'Active',
    blurb: 'Trades more often. More trades, more cost.',
    detail: 'Buys dips and sells spikes in quiet markets. More trades means more spread paid.',
    preset: 'bollinger-fade',
  },
];

const RISK_CHOICES: { percent: number; label: string; note: string }[] = [
  { percent: 0.25, label: 'Very small', note: 'a quarter of 1% per trade' },
  { percent: 0.5, label: 'Small', note: 'half of 1% per trade' },
  { percent: 1, label: 'Medium', note: '1% per trade' },
  { percent: 2, label: 'Large', note: '2% per trade — a bad run hurts fast' },
];

export function SimpleCreate({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: Strategy, openEditor: boolean) => void;
}) {
  const { api, account, refreshStrategies } = useApp();
  const [symbol, setSymbol] = useState('XAUUSD');
  const [style, setStyle] = useState<Style>('balanced');
  const [riskPercent, setRiskPercent] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = STYLES.find((s) => s.key === style)!;
  const balance = account?.balance ?? 0;
  const perTrade = (balance * riskPercent) / 100;

  const create = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createStrategy({ preset: chosen.preset, symbol });

      // The preset supplies the rules; these are the three answers applied on
      // top, plus guard rails a beginner should not have to know to ask for.
      const risk: Partial<RiskConfig> = {
        lotMode: 'percentRisk',
        riskPercent,
        maxDailyLossPercent: Math.max(2, riskPercent * 4),
        maxDailyTrades: style === 'active' ? 12 : 8,
        maxOpenPositions: 1,
      };

      const saved = await api.updateStrategy(created.id, {
        name: `${chosen.label} ${symbol}`,
        risk: { ...created.risk, ...risk } as RiskConfig,
        showLevels: true,
        levelsMinutes: 30,
      });

      await refreshStrategies();
      onCreated(saved, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, width: '100%', maxWidth: 820, alignSelf: 'center' as const }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
        <Pressable
          onPress={onClose}
          hitSlop={16}
          style={{ marginRight: space.sm, paddingVertical: space.sm, paddingRight: space.md, minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>‹ Back</Text>
        </Pressable>
        <Text style={[font.h2, { flex: 1 }]}>New strategy</Text>
      </View>

      {error ? <Banner tone="critical">{error}</Banner> : null}

      {/* 1 ------------------------------------------------------------- */}
      <SectionTitle>1. What do you want to trade?</SectionTitle>
      <Card>
        <SymbolPicker value={symbol} onChange={setSymbol} label="Market" />
      </Card>

      {/* 2 ------------------------------------------------------------- */}
      <SectionTitle>2. How should it behave?</SectionTitle>
      {STYLES.map((s) => {
        const active = style === s.key;
        return (
          <Pressable key={s.key} onPress={() => setStyle(s.key)}>
            <Card
              style={{
                marginBottom: space.sm,
                borderColor: active ? colors.accent : colors.border,
                backgroundColor: active ? colors.accentDim : colors.surface,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[font.h3, { flex: 1 }]}>{s.label}</Text>
                {active ? <Badge label="CHOSEN" tone="accent" /> : null}
              </View>
              <Text style={[font.body, { marginTop: 2 }]}>{s.blurb}</Text>
              {active ? <Text style={[font.small, { marginTop: space.sm }]}>{s.detail}</Text> : null}
            </Card>
          </Pressable>
        );
      })}

      {/* 3 ------------------------------------------------------------- */}
      <SectionTitle>3. How much per trade?</SectionTitle>
      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md }}>
          {RISK_CHOICES.map((r) => (
            <Chip
              key={r.percent}
              label={r.label}
              active={riskPercent === r.percent}
              tone={r.percent >= 2 ? 'warning' : 'accent'}
              onPress={() => setRiskPercent(r.percent)}
            />
          ))}
        </View>

        <View style={st.callout}>
          <Text style={font.label}>WHAT THIS MEANS</Text>
          <Text style={[font.h2, { marginTop: 4 }]}>
            about {perTrade.toFixed(2)} {account?.currency ?? ''} at risk per trade
          </Text>
          <Text style={[font.small, { marginTop: 4 }]}>
            {riskPercent}% of your {balance.toFixed(2)} balance. If the trade goes wrong, that is
            roughly what you lose.
          </Text>
        </View>

        <Explain title="Why a percentage instead of a lot size?">
          Lot size means different amounts of money on different markets — 0.01 lots of gold is not
          the same risk as 0.01 lots of EURUSD. Choosing a percentage lets the app work out the lot
          size for you, so the money at risk stays the same whatever you trade.
          {'\n\n'}Most people start too large. If you are unsure, pick <Text style={{ color: colors.text }}>Small</Text>.
        </Explain>
      </Card>

      {/* Summary ------------------------------------------------------- */}
      <SectionTitle>What will be set up</SectionTitle>
      <Card>
        <Row label="Market" value={symbol} />
        <Row label="Style" value={chosen.label} />
        <Row label="Risk per trade" value={`${riskPercent}%  (~${perTrade.toFixed(2)})`} />
        <Row label="Stop trading if you lose" value={`${Math.max(2, riskPercent * 4)}% in a day`} />
        <Row label="Most trades per day" value={String(style === 'active' ? 12 : 8)} />
        <Row label="Trades at once" value="1" />
        <Row label="Draw lines on MT5 chart" value="yes, last 30 min" />

        <Explain title="What am I not being asked?">
          Stop loss distance, take profit, trailing stops, session hours, indicator settings and
          spread limits are all set to sensible defaults for the style you picked. Every one of them
          is editable afterwards — open the strategy and you get the full editor.
          {'\n\n'}Nothing is hidden permanently; it is just not asked up front.
        </Explain>
      </Card>

      <Banner tone="warning">
        Whatever you create here, backtest it before running it. A strategy that has not been tested
        is a guess, however it was set up.
      </Banner>

      <Button
        title={busy ? 'Creating…' : 'Create this strategy'}
        onPress={create}
        loading={busy}
        disabled={!symbol}
      />
      <Button
        title="I know what I am doing — full editor"
        variant="ghost"
        style={{ marginTop: space.sm }}
        onPress={async () => {
          if (!api) return;
          setBusy(true);
          try {
            const created = await api.createStrategy({ preset: chosen.preset, symbol });
            await refreshStrategies();
            onCreated(created, true);
          } catch (err) {
            notify('Could not create', err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </ScrollView>
  );
}

const st = {
  callout: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: space.md,
    marginBottom: space.sm,
  },
};
