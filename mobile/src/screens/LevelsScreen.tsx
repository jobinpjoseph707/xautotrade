import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { SymbolPicker } from '../components/SymbolPicker';
import { Badge, Banner, Button, Card, Chip, Divider, Explain, Row, SectionTitle, Page, PageHeader, Segmented } from '../components/ui';
import { StrategyOverlayPanel } from './StrategyOverlayPanel';
import { confirmAction } from '../confirm';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { LevelsRangeResult, LevelsStatus } from '../types';

const MINUTE_CHOICES = [15, 30, 60, 120, 240];
const TIMEFRAME_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 1, label: '1m' },
  { minutes: 5, label: '5m' },
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
];

/**
 * Draws support and resistance lines onto the MetaTrader chart.
 *
 * The server can't draw on the chart itself — the bridge has no chart-object
 * tools — so it writes a file that the XATLevels EA reads and renders. That
 * split means there are two ways for "nothing appeared" to happen, and the
 * status card below exists specifically to tell them apart.
 */
function RangePanel() {
  const { api, account } = useApp();
  const [symbol, setSymbol] = useState('XAUUSD');
  const [minutes, setMinutes] = useState(30);
  const [tfMinutes, setTfMinutes] = useState(5);

  const [result, setResult] = useState<LevelsRangeResult | null>(null);
  const [status, setStatus] = useState<LevelsStatus | null>(null);
  const [busy, setBusy] = useState<'draw' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    try {
      setStatus(await api.levelsStatus());
    } catch {
      /* status is a nicety; a failure here shouldn't blank the screen */
    }
  }, [api]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const draw = async () => {
    if (!api) return;
    setBusy('draw');
    setError(null);
    try {
      const r = await api.drawRange(symbol, minutes, tfMinutes);
      setResult(r);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const clear = () => {
    confirmAction(
      'Clear the lines?',
      'Removes every line this app drew on your MetaTrader charts.',
      'Clear',
      async () => {
        setBusy('clear');
        try {
          await api!.clearLevels();
          setResult(null);
          await refreshStatus();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(null);
        }
      },
      { destructive: true },
    );
  };

  const isPaper = account?.mode === 'paper';

  return (
    <>

      <Explain title="What are support and resistance?">
        Over any recent stretch of time, price has a highest point and a lowest point. The high is
        called <Text style={{ color: colors.text }}>resistance</Text> — where sellers kept stepping in
        — and the low is <Text style={{ color: colors.text }}>support</Text>, where buyers did. Traders
        watch these because price often stalls or turns there. This screen finds the high and low of
        the last N minutes and draws them as two lines on your chart.
      </Explain>

      {isPaper ? (
        <Banner tone="accent">
          You&apos;re in paper mode, so lines are calculated from simulated prices and there&apos;s no
          real chart to draw on. Switch the server to the MT5 bridge to see them in MetaTrader.
        </Banner>
      ) : null}

      {error ? <Banner tone="critical">{error}</Banner> : null}

      <Card>
        <SymbolPicker value={symbol} onChange={setSymbol} label="Which market" />

        <Text style={[font.label, { marginBottom: space.xs }]}>LOOK BACK OVER</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md }}>
          {MINUTE_CHOICES.map((m) => (
            <Chip
              key={m}
              label={m >= 60 ? `${m / 60}h` : `${m}m`}
              active={minutes === m}
              tone="accent"
              onPress={() => setMinutes(m)}
            />
          ))}
        </View>

        <Text style={[font.label, { marginBottom: space.xs }]}>USING CANDLES OF</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md }}>
          {TIMEFRAME_CHOICES.map((t) => (
            <Chip
              key={t.minutes}
              label={t.label}
              active={tfMinutes === t.minutes}
              onPress={() => setTfMinutes(t.minutes)}
            />
          ))}
        </View>

        <Explain title="Which candle size should I pick?">
          It only changes how precisely the high and low are measured. Smaller candles catch brief
          spikes that bigger ones smooth over. For a 30-minute lookback, 1m or 5m candles are the
          sensible choice — 1h candles can&apos;t measure a 30-minute window at all.
        </Explain>

        <Button
          title={`Draw lines for the last ${minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`}`}
          onPress={draw}
          loading={busy === 'draw'}
        />
      </Card>

      {result ? (
        <>
          <SectionTitle>Lines drawn</SectionTitle>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
              <View style={{ width: 20, height: 3, backgroundColor: colors.critical, marginRight: space.sm }} />
              <Text style={[font.body, { flex: 1, color: colors.text }]}>Resistance (the high)</Text>
              <Text style={[font.h3, { color: colors.criticalText }]}>{result.resistance}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 20, height: 3, backgroundColor: colors.good, marginRight: space.sm }} />
              <Text style={[font.body, { flex: 1, color: colors.text }]}>Support (the low)</Text>
              <Text style={[font.h3, { color: colors.good }]}>{result.support}</Text>
            </View>

            <Divider />
            <Row label="Market" value={result.symbol} />
            <Row label="Range measured" value={`${result.support} — ${result.resistance}`} />
            <Row
              label="Distance between them"
              value={`${(result.resistance - result.support).toFixed(2)}`}
            />
            <Row label="Candles used" value={`${result.barsUsed} × ${result.timeframe}`} />

            <Button
              title="Clear the lines"
              variant="ghost"
              small
              style={{ marginTop: space.md }}
              loading={busy === 'clear'}
              onPress={clear}
            />
          </Card>
        </>
      ) : null}

      {/* The two-process split means "nothing on the chart" has two causes.
          Showing which half succeeded is the whole value of this card. */}
      <SectionTitle>Is it working?</SectionTitle>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
          <Text style={[font.body, { flex: 1 }]}>1. Server wrote the file</Text>
          <Badge
            label={status?.exists ? 'YES' : 'NOT YET'}
            tone={status?.exists ? 'good' : 'neutral'}
          />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[font.body, { flex: 1 }]}>2. MetaTrader drew them</Text>
          <Badge label="CHECK YOUR CHART" tone="accent" />
        </View>

        {status?.exists ? (
          <View style={{ marginTop: space.md }}>
            <Banner tone="good">
              The file is written with {status.levelCount} line{status.levelCount === 1 ? '' : 's'}. If
              your chart is still blank, the problem is on the MetaTrader side — see below.
            </Banner>
          </View>
        ) : null}

        <Explain title="Nothing appeared on my chart">
          Three things have to be true in MetaTrader, and none of them are visible from this app:
          {'\n\n'}1. The <Text style={{ color: colors.text }}>XATLevels</Text> EA is attached to a chart
          of this exact symbol.
          {'\n'}2. The smiley face in the chart&apos;s top-right corner is green, not sad.
          {'\n'}3. Algo Trading is switched on in the toolbar.
          {'\n\n'}If the card above says the file was written, the server did its job — so it&apos;s one
          of those three.
        </Explain>

        <Button
          title="Re-check"
          variant="secondary"
          small
          style={{ marginTop: space.sm }}
          onPress={() => void refreshStatus()}
        />
      </Card>

      <Explain title="Why does this need an EA at all?">
        MetaTrader doesn&apos;t let outside programs draw on its charts. The bridge this app uses can
        read prices and place trades, but it has no way to add a line to a chart. So the server writes
        the levels to a small file, and XATLevels — a tiny program running inside MetaTrader — reads
        that file every 2 seconds and draws them. It only ever draws; it cannot place or close a trade.
      </Explain>
    </>
  );
}

type Mode = 'strategy' | 'range';

/**
 * Chart lines: put what the bots see onto the MetaTrader chart.
 *  - Strategy overlay: a strategy's indicator curves, a live checklist of its
 *    entry/exit rules, and its open trades — drawn once, or kept updated by
 *    the running bot every bar.
 *  - Support & resistance: the recent high/low for any symbol.
 */
export function LevelsScreen() {
  const [mode, setMode] = useState<Mode>('strategy');
  return (
    <Page contentStyle={{ maxWidth: 1100 }}>
      <PageHeader title="Chart lines" subtitle="See on your MT5 chart exactly what each strategy is looking at." />
      <Segmented<Mode>
        value={mode}
        onChange={setMode}
        options={[
          { value: 'strategy', label: 'Strategy overlay' },
          { value: 'range', label: 'Support & resistance' },
        ]}
      />
      {mode === 'strategy' ? <StrategyOverlayPanel /> : <RangePanel />}
    </Page>
  );
}
