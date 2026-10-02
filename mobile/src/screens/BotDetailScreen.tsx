import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, Text, View } from 'react-native';

import { Badge, Banner, Card, Chip, DataTable, Field, KpiRow, Page, PageHeader, Pnl, SectionTitle, StatTile, StatusPill, marketBlocked, marketState, type Column } from '../components/ui';
import { useLayout } from '../layout';
import { useApp } from '../store';
import { colors, font, money, pnlColor, space } from '../theme';
import type { LogEntry, Strategy, StrategyTrades } from '../types';

type TradeRangeMode = 'today' | 'all' | 'custom';

/** Parses "YYYY-MM-DD" in local time; returns null for empty/unparseable input. */
function parseDateInput(v: string): Date | null {
  if (!v.trim()) return null;
  const d = new Date(`${v.trim()}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The bots' trading day starts at 00:00 UTC (daily trade limits and the daily
 * loss cap reset then), so "Today" here uses the same boundary as the
 * dashboard and the server — otherwise the two screens count different trades.
 */
function tradingDayStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const CLOSE_EVENTS = new Set(['position_closed', 'exit', 'panic_close']);
/** Normal waiting states (cooldown, max positions…) are not problems. */
const ROUTINE = /^(Max open positions|Cooling down|Outside the configured|Waiting for history)/;

/**
 * Trades, running P&L, and current status for one bot. Every number in the
 * header comes from the server's /strategies/:id/trades answer for the SAME
 * range as the list below, so they always agree — whether the bot is running,
 * stopped, or was restarted today.
 */
export function BotDetailScreen({ strategy, onClose }: { strategy: Strategy; onClose: () => void }) {
  const { api, bots, markets } = useApp();
  const market = markets[strategy.symbol.toUpperCase()];
  const { medium } = useLayout();
  const bot = bots[strategy.id];

  const [data, setData] = useState<StrategyTrades | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rangeMode, setRangeMode] = useState<TradeRangeMode>('today');
  const [rangeFrom, setRangeFrom] = useState(''); // YYYY-MM-DD
  const [rangeTo, setRangeTo] = useState(''); // YYYY-MM-DD

  // Bounds for the selected range.
  let rangeStart: number | undefined;
  let rangeEndExclusive: number | undefined;
  let rangeError: string | null = null;
  if (rangeMode === 'today') {
    rangeStart = tradingDayStart();
  } else if (rangeMode === 'all') {
    rangeStart = 1; // the server treats 0/empty as "today"
  } else {
    const from = parseDateInput(rangeFrom);
    const to = parseDateInput(rangeTo);
    if ((rangeFrom && !from) || (rangeTo && !to)) rangeError = 'Use YYYY-MM-DD, e.g. 2026-09-01.';
    rangeStart = from ? from.getTime() : 1;
    if (to) {
      const end = new Date(to);
      end.setDate(end.getDate() + 1); // inclusive of the "to" day
      rangeEndExclusive = end.getTime();
    }
  }

  const reqId = useRef(0);
  const load = useCallback(async () => {
    if (!api || rangeError) return;
    const mine = ++reqId.current;
    try {
      const r = await api.strategyTrades(strategy.id, rangeStart, rangeEndExclusive);
      if (mine === reqId.current) {
        setData(r);
        setLoadError(null);
      }
    } catch (err) {
      if (mine === reqId.current) setLoadError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, strategy.id, rangeStart, rangeEndExclusive, rangeError]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  // Stay current while the screen is open: refetch when the bot trades, and every 15 s.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot?.tradesToday, bot?.realisedToday, bot?.openPositions.length]);
  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Live floating comes from the running bot (4 s refresh) when there is one,
  // otherwise from the broker positions the server returned for this strategy.
  const openPositions = bot?.status === 'running' ? bot.openPositions : data?.openPositions ?? [];
  const floating = openPositions.reduce((a, p) => a + p.profit, 0);

  const rangeWord =
    rangeMode === 'today' ? 'today' : rangeMode === 'all' ? 'all time' : rangeFrom || rangeTo ? 'in range' : 'all time';
  const dayStartLocal = new Date(tradingDayStart()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const events: LogEntry[] = data?.events ?? [];
  const historyColumns: Column<LogEntry>[] = [
    {
      key: 'time',
      title: 'Time',
      width: 170,
      render: (l) => (
        <Text style={{ color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] }}>
          {new Date(l.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </Text>
      ),
    },
    {
      key: 'kind',
      title: 'Type',
      width: 90,
      render: (l) => (CLOSE_EVENTS.has(l.event) ? <Badge label="CLOSE" tone="neutral" /> : <Badge label="OPEN" tone="accent" />),
    },
    { key: 'msg', title: 'Details', flex: 4, render: (l) => <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={2}>{l.message}</Text> },
    {
      key: 'pnl',
      title: 'P&L',
      flex: 1,
      align: 'right',
      render: (l) => {
        const p = (l.data as { profit?: number } | undefined)?.profit;
        return CLOSE_EVENTS.has(l.event) && typeof p === 'number' ? <Pnl value={p} /> : <Text style={{ color: colors.muted }}>—</Text>;
      },
    },
  ];

  return (
    <Page refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}>
      <PageHeader
        onBack={onClose}
        title={strategy.name}
        subtitle={`${strategy.symbol} · ${strategy.timeframe}${bot?.startedAt ? ` · running since ${new Date(bot.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`}
        right={<View style={{ flexDirection: 'row', gap: space.xs }}><StatusPill status={marketState(market)} label={`Market: ${({ open: 'open', closed: 'closed', unavailable: 'not offered', close_only: 'close only', unknown: 'checking' } as Record<string, string>)[marketState(market)]}`} /><StatusPill status={bot?.error ? 'error' : bot?.status === 'running' && bot?.blockedReason && !ROUTINE.test(bot.blockedReason) ? 'blocked' : bot?.status ?? 'stopped'} /></View>}
      />
      {market && (marketBlocked(market) || market.open === false) && market.reason ? (
        <Banner tone={marketBlocked(market) ? 'critical' : 'accent'}>{market.reason}</Banner>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.sm }}>
        <Chip label="Today" active={rangeMode === 'today'} onPress={() => setRangeMode('today')} />
        <Chip label="All time" active={rangeMode === 'all'} onPress={() => setRangeMode('all')} />
        <Chip label="Custom range" active={rangeMode === 'custom'} onPress={() => setRangeMode('custom')} />
      </View>
      {rangeMode === 'today' ? (
        <Text style={[font.small, { marginBottom: space.sm }]}>
          Trading day since {dayStartLocal} your time (00:00 UTC) — when daily limits reset.
        </Text>
      ) : null}
      {rangeMode === 'custom' ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
          <View style={{ flex: 1 }}>
            <Field label="From" value={rangeFrom} onChangeText={setRangeFrom} placeholder="YYYY-MM-DD" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="To" value={rangeTo} onChangeText={setRangeTo} placeholder="YYYY-MM-DD (optional)" />
          </View>
        </View>
      ) : null}
      {rangeError ? (
        <View style={{ marginBottom: space.sm }}>
          <Banner tone="warning">{rangeError}</Banner>
        </View>
      ) : null}
      {loadError ? (
        <View style={{ marginBottom: space.sm }}>
          <Banner tone="critical">{loadError}</Banner>
        </View>
      ) : null}
      {data && !data.brokerOk ? (
        <View style={{ marginBottom: space.sm }}>
          <Banner tone="warning">Broker not reachable — showing the trade log only; closes that happened in MT5 may be missing.</Banner>
        </View>
      ) : null}

      <KpiRow>
        <StatTile label={`Trades ${rangeWord}`} value={data ? String(data.opened) : '—'} sub={data ? `${data.closed} closed · ${data.wins} won · ${data.losses} lost` : undefined} />
        <StatTile
          label={`Realised ${rangeWord}`}
          value={data ? money(data.realised) : '—'}
          valueColor={data ? pnlColor(data.realised) : undefined}
          sub={data && data.closed ? `Win rate ${Math.round((data.wins / data.closed) * 100)}%` : undefined}
        />
        <StatTile label="Floating" value={money(floating)} valueColor={pnlColor(floating)} sub={`${openPositions.length} open`} />
        <StatTile label="Last signal" value={bot?.status === 'running' ? bot?.lastSignal ?? '—' : '—'} sub={bot?.lastBarTime ? `bar ${new Date(bot.lastBarTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'not running'} />
      </KpiRow>
      {bot?.error ? <Banner tone="critical">{bot.error}</Banner> : null}
      {!bot?.error && bot?.status === 'running' && bot?.blockedReason ? (
        ROUTINE.test(bot.blockedReason) ? (
          <Text style={[font.small, { marginBottom: space.sm }]}>Now: {bot.blockedReason}</Text>
        ) : (
          <Banner tone="warning">{bot.blockedReason}</Banner>
        )
      ) : null}

      {openPositions.length > 0 ? (
        <>
          <SectionTitle>Open now</SectionTitle>
          {openPositions.map((p) => (
            <Card key={p.id} style={{ marginBottom: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Badge label={p.side === 'long' ? 'BUY' : 'SELL'} tone={p.side === 'long' ? 'good' : 'critical'} />
                <Text style={[font.body, { flex: 1 }]}>
                  {p.volume} @ {p.openPrice} → {p.currentPrice}
                </Text>
                <Text style={[font.h3, { color: pnlColor(p.profit) }]}>{money(p.profit)}</Text>
              </View>
            </Card>
          ))}
        </>
      ) : null}

      <SectionTitle>Trade history</SectionTitle>
      {loading && !data ? (
        <Text style={font.body}>Loading…</Text>
      ) : events.length === 0 ? (
        <Text style={font.body}>{rangeMode === 'today' ? 'No trades yet today.' : 'No trades in this range.'}</Text>
      ) : (
        medium ? (
          <DataTable
            columns={historyColumns}
            rows={events}
            keyOf={(l) => String(l.id ?? `${l.ts}-${l.event}`)}
          />
        ) : (
          events.map((l, i) => {
            const pnl = (l.data as { profit?: number } | undefined)?.profit;
            const isClose = CLOSE_EVENTS.has(l.event);
            return (
              <Card key={l.id ?? i} style={{ marginBottom: space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
                  <Badge label={isClose ? 'CLOSE' : 'OPEN'} tone={isClose ? 'neutral' : 'accent'} />
                  <Text style={[font.body, { flex: 1 }]}>{l.message}</Text>
                  {isClose && typeof pnl === 'number' ? <Pnl value={pnl} /> : null}
                </View>
                <Text style={[font.small, { marginTop: 2 }]}>{new Date(l.ts).toLocaleString()}</Text>
              </Card>
            );
          })
        )
      )}
    </Page>
  );
}
