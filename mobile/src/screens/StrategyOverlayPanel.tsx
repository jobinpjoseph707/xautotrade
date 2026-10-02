import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import { OverlayChart } from '../components/OverlayChart';
import { Badge, Banner, Button, Card, Chip, Explain, Loading, StatusPill, marketState } from '../components/ui';
import { notify } from '../confirm';
import { useLayout } from '../layout';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { OverlayPreview, Strategy } from '../types';

const BAR_CHOICES = [60, 120, 240];

/**
 * Pick a strategy and see everything it takes into account — the same picture
 * the XATLevels EA draws on the MT5 chart:
 *  - its price indicators as lines (EMA, SMA, WMA, Bollinger bands)
 *  - oscillator values (RSI, MACD, Stochastic, ADX, CCI, ATR) in a panel
 *  - each entry/exit rule, ticked when it is true on the last closed bar
 *  - its open trades' entry, stop and target
 */
export function StrategyOverlayPanel() {
  const { api, strategies, bots, markets, refreshStrategies } = useApp();
  const { wide } = useLayout();
  const [selected, setSelected] = useState<string | null>(null);
  const [parts, setParts] = useState({ indicators: true, rules: true, trades: true, range: false });
  const [bars, setBars] = useState(120);
  const [data, setData] = useState<OverlayPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawn, setDrawn] = useState<Record<string, number>>({});

  // Default to the first running strategy, else the first one.
  useEffect(() => {
    if (selected && strategies.some((s) => s.id === selected)) return;
    const running = strategies.find((s) => bots[s.id]?.status === 'running');
    setSelected((running ?? strategies[0])?.id ?? null);
  }, [strategies, bots, selected]);

  const strategy: Strategy | undefined = strategies.find((s) => s.id === selected);
  const market = strategy ? markets[strategy.symbol.toUpperCase()] : undefined;
  const running = strategy ? bots[strategy.id]?.status === 'running' : false;

  const load = useCallback(
    async (publish = false) => {
      if (!api || !strategy) return;
      setError(null);
      if (publish) setBusy('draw');
      else setLoading(true);
      try {
        const r = await api.strategyOverlay(strategy.id, { publish, bars, ...parts });
        setData(r);
        if (publish && r.published) setDrawn((d) => ({ ...d, [strategy.id]: r.objectCount }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setBusy(null);
      }
    },
    [api, strategy, bars, parts],
  );

  useEffect(() => {
    setData(null);
    void load(false);
  }, [load]);

  // Keep the preview in step with the bot: refresh every 30 s.
  useEffect(() => {
    const t = setInterval(() => void load(false), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const clear = async () => {
    if (!api || !strategy) return;
    setBusy('clear');
    try {
      await api.clearStrategyOverlay(strategy.id);
      setDrawn((d) => ({ ...d, [strategy.id]: 0 }));
    } catch (err) {
      notify('Could not clear', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleLive = async (on: boolean) => {
    if (!api || !strategy) return;
    setBusy('live');
    try {
      await api.updateStrategy(strategy.id, { showOverlays: on });
      await refreshStrategies();
    } catch (err) {
      notify('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const digits = useMemo(() => {
    const last = data?.closes[data.closes.length - 1];
    if (last == null) return 2;
    return last < 10 ? 5 : last < 1000 ? 3 : 2;
  }, [data]);

  if (strategies.length === 0) {
    return (
      <Card style={{ marginTop: space.md }}>
        <Text style={font.body}>Create a strategy first — its indicators and rules are what gets drawn.</Text>
      </Card>
    );
  }

  return (
    <View style={{ marginTop: space.sm, gap: space.md }}>
      {/* Strategy picker ------------------------------------------------ */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
        {strategies.map((s) => (
          <Chip
            key={s.id}
            label={`${bots[s.id]?.status === 'running' ? '● ' : ''}${s.name} · ${s.symbol}`}
            active={s.id === selected}
            tone="accent"
            onPress={() => setSelected(s.id)}
          />
        ))}
      </View>

      {strategy ? (
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.md, alignItems: 'flex-start' }}>
          {/* Left: chart + rules --------------------------------------- */}
          <View style={{ flex: wide ? 2 : undefined, width: wide ? undefined : '100%', gap: space.md }}>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm, flexWrap: 'wrap' }}>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <Text style={font.h3}>{strategy.name}</Text>
                  <Text style={font.small}>
                    {strategy.symbol} · {strategy.timeframe} · last {bars} closed bars
                  </Text>
                </View>
                <StatusPill status={marketState(market)} label={`Market ${marketState(market)}`} />
                {data ? <Badge label={`Signal ${data.signal}`} tone={data.signal === 'none' ? 'neutral' : 'accent'} /> : null}
              </View>
              {error ? <Banner tone="critical">{error}</Banner> : null}
              {loading && !data ? <Loading label="Reading candles from MT5…" /> : null}
              {data ? <OverlayChart times={data.times} closes={data.closes} series={parts.indicators ? data.series : []} digits={digits} /> : null}
              {data && data.series.length === 0 ? (
                <Text style={[font.small, { marginTop: space.sm }]}>
                  This strategy has no price-scale indicators (EMA/SMA/WMA/Bollinger) — its oscillators are listed on the right.
                </Text>
              ) : null}
            </Card>

            {parts.rules && data ? (
              <Card>
                <Text style={[font.h3, { marginBottom: space.xs }]}>Rules on the last closed bar</Text>
                <Text style={[font.small, { marginBottom: space.sm }]}>
                  What the bot checks before it trades. A side trades when its rules pass (all of them for AND, any one for OR).
                </Text>
                {data.rules.length === 0 ? <Text style={font.body}>No rules defined.</Text> : null}
                {data.rules.map((r) => (
                  <View key={r.side} style={{ marginBottom: space.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 4 }}>
                      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>{r.side}</Text>
                      <Text style={font.small}>{r.logic === 'AND' ? 'all must be true' : 'any one is enough'}</Text>
                      <Badge label={r.passed ? 'PASSES' : 'NOT MET'} tone={r.passed ? 'good' : 'neutral'} />
                    </View>
                    {r.conditions.map((c, k) => (
                      <View key={k} style={{ flexDirection: 'row', gap: space.sm, paddingVertical: 3 }}>
                        <Text style={{ width: 18, color: c.ok ? colors.good : colors.muted, fontWeight: '700' }} accessibilityLabel={c.ok ? 'true' : 'false'}>
                          {c.ok ? '✓' : '✗'}
                        </Text>
                        <Text style={{ color: c.ok ? colors.text : colors.textSecondary, fontSize: 13, flex: 1 }}>{c.text}</Text>
                      </View>
                    ))}
                  </View>
                ))}
              </Card>
            ) : null}
          </View>

          {/* Right: controls + values ------------------------------------ */}
          <View style={{ flex: wide ? 1 : undefined, width: wide ? undefined : '100%', gap: space.md, minWidth: wide ? 300 : undefined }}>
            <Card>
              <Text style={[font.h3, { marginBottom: space.sm }]}>Draw on MT5</Text>
              <Text style={[font.small, { marginBottom: space.sm }]}>Show on the chart:</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md }}>
                <Chip label="Indicator lines" active={parts.indicators} tone="accent" onPress={() => setParts((p) => ({ ...p, indicators: !p.indicators }))} />
                <Chip label="Rule checklist" active={parts.rules} tone="accent" onPress={() => setParts((p) => ({ ...p, rules: !p.rules }))} />
                <Chip label="Open trades" active={parts.trades} tone="accent" onPress={() => setParts((p) => ({ ...p, trades: !p.trades }))} />
                <Chip label="Recent high/low" active={parts.range} tone="accent" onPress={() => setParts((p) => ({ ...p, range: !p.range }))} />
              </View>
              <Text style={[font.small, { marginBottom: space.xs }]}>History to draw</Text>
              <View style={{ flexDirection: 'row', gap: space.xs, marginBottom: space.md }}>
                {BAR_CHOICES.map((b) => (
                  <Chip key={b} label={`${b} bars`} active={bars === b} onPress={() => setBars(b)} />
                ))}
              </View>
              <Button title="Draw on MT5 now" icon="✎" loading={busy === 'draw'} onPress={() => void load(true)} />
              <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
                <Button title="Refresh preview" small variant="secondary" style={{ flex: 1 }} loading={loading} onPress={() => void load(false)} />
                <Button title="Clear" small variant="ghost" style={{ flex: 1 }} loading={busy === 'clear'} onPress={() => void clear()} />
              </View>
              {drawn[strategy.id] ? (
                <Text style={[font.small, { marginTop: space.sm, color: colors.good }]}>✓ Drawn: {drawn[strategy.id]} objects written for the EA.</Text>
              ) : null}

              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: space.md }} />
              <Pressable
                onPress={() => void toggleLive(!strategy.showOverlays)}
                accessibilityRole="switch"
                accessibilityState={{ checked: !!strategy.showOverlays }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>Keep it updated while the bot runs</Text>
                  <Text style={font.small}>
                    {running ? 'The bot redraws its indicators, rules and trades every bar.' : 'Takes effect when this bot is started.'}
                  </Text>
                </View>
                <Switch value={!!strategy.showOverlays} onValueChange={(v) => void toggleLive(v)} disabled={busy === 'live'} />
              </Pressable>
            </Card>

            {data ? (
              <Card>
                <Text style={[font.h3, { marginBottom: space.sm }]}>Indicator values</Text>
                {data.panel.map((p) => (
                  <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 5, borderBottomWidth: 1, borderColor: colors.border }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.color }} />
                    <Text style={{ color: colors.textSecondary, fontSize: 13, flex: 1 }}>{p.label}</Text>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{p.value}</Text>
                  </View>
                ))}
              </Card>
            ) : null}

            <Explain title="Nothing on the chart?">
              The drawing is done by the XATLevels EA inside MetaTrader. Indicator lines and the rule panel need version 2: open
              MetaEditor (F4), open XATLevels.mq5, press F7 to compile, then drag XATLevels onto a {strategy.symbol} chart with Algo
              Trading on. Lines are drawn against the chart's time axis, so they line up on any timeframe — they match the candles
              best on {strategy.timeframe}.
            </Explain>
          </View>
        </View>
      ) : null}
      <View style={{ height: 1 }} />
    </View>
  );
}

