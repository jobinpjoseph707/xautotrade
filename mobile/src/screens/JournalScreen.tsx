import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';

import { EquityChart } from '../components/EquityChart';
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  DataTable,
  Empty,
  Field,
  KpiRow,
  Loading,
  Page,
  PageHeader,
  Pnl,
  Row,
  Select,
  Sheet,
  StatTile,
  Sticky,
  type Column,
} from '../components/ui';
import { useLayout } from '../layout';
import { useApp } from '../store';
import { colors, font, money, pnlColor, radius, space } from '../theme';
import { istDateTime, istFull } from '../logic/time';
import type { ExitReason, JournalResponse, JournalTrade } from '../types';

type Period = 'today' | '7d' | '30d' | 'all' | 'custom';
type OutcomeFilter = 'all' | 'win' | 'loss' | 'breakeven' | 'open';
type SideFilter = 'all' | 'long' | 'short';
type ReasonFilter = 'all' | 'tp' | 'sl' | 'bot' | 'manual' | 'panic';
type SortKey = 'newest' | 'oldest' | 'best' | 'worst' | 'longest';

const DAY = 86_400_000;
const PAGE = 100;

const REASON_LABEL: Record<ExitReason, string> = {
  tp: 'Take-profit',
  sl: 'Stop-loss',
  stop_out: 'Stop-out',
  exit_rule: 'Exit rule',
  opposite: 'Opposite signal',
  panic: 'Stop-all',
  manual: 'Closed manually',
  bot: 'Closed by bot',
  unknown: 'Closed',
};
const reasonTone = (r: ExitReason | null) =>
  r === 'tp' ? 'good' : r === 'sl' || r === 'stop_out' ? 'critical' : r === 'panic' ? 'warning' : 'neutral';

function utcDayStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function parseDay(v: string): number | null {
  if (!v.trim()) return null;
  const t = new Date(`${v.trim()}T00:00:00`).getTime();
  return Number.isNaN(t) ? null : t;
}
export function held(ms: number | null): string {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const when = (ts: number | null) =>
  ts ? istDateTime(ts) : '—';
const px = (v: number | null) => (v == null ? '—' : String(v));

export interface JournalStats {
  closed: number;
  open: number;
  wins: number;
  losses: number;
  net: number;
  grossWin: number;
  grossLoss: number;
  winRate: number | null;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  best: number | null;
  worst: number | null;
  avgHoldMs: number | null;
  floating: number;
}

export function journalStats(trades: JournalTrade[]): JournalStats {
  const closed = trades.filter((t) => t.status === 'closed' && t.profit != null);
  const wins = closed.filter((t) => t.outcome === 'win');
  const losses = closed.filter((t) => t.outcome === 'loss');
  const grossWin = wins.reduce((a, t) => a + t.profit!, 0);
  const grossLoss = losses.reduce((a, t) => a + t.profit!, 0);
  const holds = closed.map((t) => t.durationMs).filter((x): x is number => x != null);
  return {
    closed: closed.length,
    open: trades.filter((t) => t.status === 'open').length,
    wins: wins.length,
    losses: losses.length,
    net: closed.reduce((a, t) => a + t.profit!, 0),
    grossWin,
    grossLoss,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : null,
    profitFactor: grossLoss < 0 ? grossWin / -grossLoss : wins.length ? Infinity : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    best: closed.length ? Math.max(...closed.map((t) => t.profit!)) : null,
    worst: closed.length ? Math.min(...closed.map((t) => t.profit!)) : null,
    avgHoldMs: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    floating: trades.filter((t) => t.status === 'open').reduce((a, t) => a + (t.profit ?? 0), 0),
  };
}

/**
 * Trade journal: every trade the bots took, filterable the way trading
 * platforms do (period, winners/losers, buy/sell, how it closed, bot, symbol),
 * with the numbers for whatever is filtered and a detail view per trade.
 */
export function JournalScreen() {
  const { api } = useApp();
  const { medium, wide } = useLayout();
  const [data, setData] = useState<JournalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [period, setPeriod] = useState<Period>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [side, setSide] = useState<SideFilter>('all');
  const [reason, setReason] = useState<ReasonFilter>('all');
  const [bot, setBot] = useState<string>('all');
  const [symbol, setSymbol] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [shown, setShown] = useState(PAGE);
  const [detail, setDetail] = useState<JournalTrade | null>(null);

  const range = useMemo(() => {
    const now = Date.now();
    if (period === 'today') return { from: utcDayStart(now), to: undefined };
    if (period === '7d') return { from: now - 7 * DAY, to: undefined };
    if (period === '30d') return { from: now - 30 * DAY, to: undefined };
    if (period === 'custom') {
      const f = parseDay(customFrom);
      const t = parseDay(customTo);
      return { from: f ?? 1, to: t ? t + DAY : undefined };
    }
    return { from: 1, to: undefined };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo]);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setError(null);
      setData(await api.journal(range.from, range.to));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, range]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  // Open trades' floating P&L moves; closed details keep filling in from MT5.
  useEffect(() => {
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const all = data?.trades ?? [];
  const bots = useMemo(() => [...new Map(all.map((t) => [t.strategyId ?? t.strategyName, t.strategyName])).entries()], [all]);
  const symbols = useMemo(() => [...new Set(all.map((t) => t.symbol))].sort(), [all]);
  // Trade counts per bot/symbol, shown as a hint in their dropdowns so picking
  // one isn't a guess — e.g. two bots sharing a name are still told apart.
  const botCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of all) {
      const k = t.strategyId ?? t.strategyName;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [all]);
  const symbolCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of all) m.set(t.symbol, (m.get(t.symbol) ?? 0) + 1);
    return m;
  }, [all]);

  // Everything except the outcome filter, so the outcome chips can show counts.
  const base = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (t) =>
        (side === 'all' || t.side === side) &&
        (bot === 'all' || (t.strategyId ?? t.strategyName) === bot) &&
        (symbol === 'all' || t.symbol === symbol) &&
        (reason === 'all' ||
          (reason === 'bot' ? t.exitReason === 'exit_rule' || t.exitReason === 'opposite' || t.exitReason === 'bot' : reason === 'sl' ? t.exitReason === 'sl' || t.exitReason === 'stop_out' : t.exitReason === reason)) &&
        (!q || t.strategyName.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.positionId.includes(q)),
    );
  }, [all, side, bot, symbol, reason, query]);

  const counts = useMemo(() => {
    const c: Record<OutcomeFilter, number> = { all: base.length, win: 0, loss: 0, breakeven: 0, open: 0 };
    for (const t of base) if (t.outcome in c) c[t.outcome as OutcomeFilter]++;
    return c;
  }, [base]);

  const filtered = useMemo(() => {
    const list = base.filter((t) => outcome === 'all' || t.outcome === outcome);
    const time = (t: JournalTrade) => t.openTime ?? t.closeTime ?? 0;
    const sorters: Record<SortKey, (a: JournalTrade, b: JournalTrade) => number> = {
      newest: (a, b) => time(b) - time(a),
      oldest: (a, b) => time(a) - time(b),
      best: (a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity),
      worst: (a, b) => (a.profit ?? Infinity) - (b.profit ?? Infinity),
      longest: (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0),
    };
    return [...list].sort(sorters[sort]);
  }, [base, outcome, sort]);

  useEffect(() => setShown(PAGE), [filtered.length, sort]);

  const stats = useMemo(() => journalStats(filtered), [filtered]);
  const curve = useMemo(() => {
    const closed = filtered
      .filter((t) => t.status === 'closed' && t.profit != null && t.closeTime)
      .sort((a, b) => a.closeTime! - b.closeTime!);
    let run = 0;
    return closed.map((t) => {
      run += t.profit!;
      return { time: t.closeTime!, equity: Math.round(run * 100) / 100, balance: run, drawdownPct: 0 };
    });
  }, [filtered]);

  const byBot = useMemo(() => {
    const m = new Map<string, JournalTrade[]>();
    for (const t of filtered) m.set(t.strategyName, [...(m.get(t.strategyName) ?? []), t]);
    return [...m.entries()].map(([name, ts]) => ({ name, key: ts[0].strategyId ?? name, ...journalStats(ts) })).sort((a, b) => b.net - a.net);
  }, [filtered]);

  const exportCsv = () => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const head = ['position', 'bot', 'symbol', 'side', 'lots', 'opened', 'closed', 'held_min', 'entry', 'exit', 'stop', 'target', 'exit_reason', 'profit', 'status'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = filtered.map((t) =>
      [
        t.positionId, t.strategyName, t.symbol, t.side, t.volume,
        t.openTime ? new Date(t.openTime).toISOString() : '', t.closeTime ? new Date(t.closeTime).toISOString() : '',
        t.durationMs != null ? Math.round(t.durationMs / 60_000) : '', t.openPrice, t.closePrice, t.stopLoss, t.takeProfit,
        t.exitReason ? REASON_LABEL[t.exitReason] : '', t.profit, t.status,
      ].map(esc).join(','),
    );
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `xautotrade-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const clearFilters = () => {
    setOutcome('all');
    setSide('all');
    setReason('all');
    setBot('all');
    setSymbol('all');
    setQuery('');
  };
  const anyFilter = outcome !== 'all' || side !== 'all' || reason !== 'all' || bot !== 'all' || symbol !== 'all' || !!query;

  const columns: Column<JournalTrade>[] = [
    { key: 'open', title: 'Opened', flex: 1.2, render: (t) => <Text style={{ color: colors.text, fontSize: 13 }}>{when(t.openTime)}</Text> },
    {
      key: 'bot',
      title: 'Bot',
      flex: 1.7,
      render: (t) => (
        <View>
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
            {t.strategyName}
          </Text>
          <Text style={font.small}>{t.symbol}</Text>
        </View>
      ),
    },
    { key: 'side', title: 'Side', width: 64, render: (t) => (t.side ? <Badge label={t.side === 'long' ? 'BUY' : 'SELL'} tone={t.side === 'long' ? 'good' : 'critical'} /> : '—') },
    { key: 'lots', title: 'Lots', flex: 0.6, align: 'right', render: (t) => px(t.volume) },
    { key: 'entry', title: 'Entry', flex: 1, align: 'right', render: (t) => px(t.openPrice) },
    { key: 'exit', title: 'Exit', flex: 1, align: 'right', render: (t) => (t.status === 'open' ? <Text style={{ color: colors.muted, fontSize: 13 }}>{px(t.currentPrice)} now</Text> : px(t.closePrice)) },
    { key: 'sl', title: 'Stop', flex: 1, align: 'right', render: (t) => px(t.stopLoss) },
    { key: 'tp', title: 'Target', flex: 1, align: 'right', render: (t) => px(t.takeProfit) },
    { key: 'held', title: 'Held', flex: 0.8, align: 'right', render: (t) => held(t.durationMs) },
    {
      key: 'reason',
      title: 'Result',
      flex: 1.3,
      render: (t) => (
        <View style={{ flexDirection: 'row' }}>
          {t.status === 'open' ? <Badge label="OPEN" tone="accent" /> : t.status === 'unrecorded' ? <Badge label="NOT RECORDED" tone="warning" /> : <Badge label={REASON_LABEL[t.exitReason ?? 'unknown'].toUpperCase()} tone={reasonTone(t.exitReason) as any} />}
        </View>
      ),
    },
    { key: 'pnl', title: 'P&L', flex: 1, align: 'right', render: (t) => (t.profit == null ? <Text style={{ color: colors.muted }}>—</Text> : <Pnl value={t.profit} />) },
  ];

  const botColumns: Column<(typeof byBot)[number]>[] = [
    { key: 'name', title: 'Bot', flex: 2, render: (b) => <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }} numberOfLines={1}>{b.name}</Text> },
    { key: 'n', title: 'Trades', flex: 0.8, align: 'right', render: (b) => String(b.closed + b.open) },
    { key: 'wr', title: 'Win rate', flex: 1, align: 'right', render: (b) => (b.winRate == null ? '—' : `${Math.round(b.winRate * 100)}%`) },
    { key: 'pf', title: 'PF', flex: 0.7, align: 'right', render: (b) => (b.profitFactor == null ? '—' : b.profitFactor === Infinity ? '∞' : b.profitFactor.toFixed(2)) },
    { key: 'net', title: 'Net P&L', flex: 1, align: 'right', render: (b) => <Pnl value={b.net} /> },
  ];

  const pageRows = filtered.slice(0, shown);

  return (
    <Page refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}>
      <PageHeader
        title="Trade journal"
        subtitle={data ? `${all.length} trade${all.length === 1 ? '' : 's'} in this period · ${filtered.length} shown` : 'Every trade your bots took'}
        right={
          <>
            <Button title="Refresh" icon="↻" small variant="secondary" loading={refreshing} onPress={() => void onRefresh()} />
            {Platform.OS === 'web' ? <Button title="Export CSV" icon="⇩" small variant="secondary" disabled={!filtered.length} onPress={exportCsv} /> : null}
          </>
        }
      />

      {error ? <Banner tone="critical">{error}</Banner> : null}
      {data && !data.brokerOk ? <Banner tone="warning">MT5 isn't reachable — showing what the bots logged; exact exit prices and reasons fill in when it's back.</Banner> : null}
      {data && data.pendingDetails > 0 ? (
        <Banner tone="accent">Fetching exact details for {data.pendingDetails} more closed trade{data.pendingDetails === 1 ? '' : 's'} from MT5 — they fill in on the next refresh.</Banner>
      ) : null}

      {/* Filters — pinned to the top of the scroll area and kept to one dense
          strip. This tab exists to filter the trade list, so the filter bar
          itself should cost as little screen space as possible and should
          never have to be scrolled back into view to change it. */}
      <Sticky style={{ marginBottom: space.lg }}>
        <Card padded={false} style={{ paddingVertical: space.sm, paddingHorizontal: space.md }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs }}>
            {(['today', '7d', '30d', 'all', 'custom'] as Period[]).map((p) => (
              <Chip key={p} label={{ today: 'Today', '7d': '7d', '30d': '30d', all: 'All time', custom: 'Custom' }[p]} active={period === p} tone="accent" onPress={() => setPeriod(p)} />
            ))}
            <FilterSep />
            <Chip label={`All ${counts.all}`} active={outcome === 'all'} tone="accent" onPress={() => setOutcome('all')} />
            <Chip label={`▲ ${counts.win}`} active={outcome === 'win'} tone="good" onPress={() => setOutcome('win')} />
            <Chip label={`▼ ${counts.loss}`} active={outcome === 'loss'} tone="critical" onPress={() => setOutcome('loss')} />
            <Chip label={`BE ${counts.breakeven}`} active={outcome === 'breakeven'} onPress={() => setOutcome('breakeven')} />
            <Chip label={`Open ${counts.open}`} active={outcome === 'open'} tone="accent" onPress={() => setOutcome('open')} />
            <FilterSep />
            <Select
              compact
              label="Side"
              value={side}
              onChange={setSide}
              options={[
                { value: 'all', label: 'Buy & sell' },
                { value: 'long', label: 'Buy' },
                { value: 'short', label: 'Sell' },
              ]}
            />
            <Select
              compact
              label="Closed by"
              value={reason}
              onChange={setReason}
              options={[
                { value: 'all', label: 'Anything' },
                { value: 'tp', label: 'Take-profit' },
                { value: 'sl', label: 'Stop-loss' },
                { value: 'bot', label: 'Bot exit' },
                { value: 'manual', label: 'Manual' },
                { value: 'panic', label: 'Stop-all' },
              ]}
            />
            {bots.length > 1 ? (
              <Select
                compact
                label="Bot"
                value={bot}
                onChange={setBot}
                options={[
                  { value: 'all', label: 'All bots', hint: String(all.length) },
                  ...bots.map(([key, name]) => ({ value: key, label: name, hint: String(botCounts.get(key) ?? 0) })),
                ]}
              />
            ) : null}
            {symbols.length > 1 ? (
              <Select
                compact
                label="Symbol"
                value={symbol}
                onChange={setSymbol}
                options={[
                  { value: 'all', label: 'All', hint: String(all.length) },
                  ...symbols.map((sy) => ({ value: sy, label: sy, hint: String(symbolCounts.get(sy) ?? 0) })),
                ]}
              />
            ) : null}
            <Select
              compact
              label="Sort"
              value={sort}
              onChange={setSort}
              emphasizeChange={false}
              options={[
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
                { value: 'best', label: 'Biggest win' },
                { value: 'worst', label: 'Biggest loss' },
                { value: 'longest', label: 'Longest held' },
              ]}
            />
            <FilterSep />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search bot, symbol, ticket…"
              placeholderTextColor={colors.muted}
              style={{
                height: 32,
                minWidth: 150,
                flexGrow: 1,
                maxWidth: 240,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.pill,
                backgroundColor: colors.bg,
                color: colors.text,
                paddingHorizontal: space.md,
                fontSize: 13,
              }}
            />
            {anyFilter ? <Button title="Clear" small variant="ghost" onPress={clearFilters} /> : null}
          </View>
          {period === 'custom' ? (
            <View style={{ flexDirection: 'row', gap: space.sm, maxWidth: 480, marginTop: space.sm }}>
              <View style={{ flex: 1 }}>
                <Field label="From" value={customFrom} onChangeText={setCustomFrom} placeholder="YYYY-MM-DD" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="To" value={customTo} onChangeText={setCustomTo} placeholder="YYYY-MM-DD" />
              </View>
            </View>
          ) : null}
        </Card>
      </Sticky>

      {loading && !data ? <Loading label="Loading trades…" /> : null}

      {data ? (
        <>
          {/* Numbers for what's filtered ---------------------------------------- */}
          <KpiRow>
            <StatTile hero minWidth={medium ? 240 : 200} label="Net P&L (closed)" value={money(stats.net)} valueColor={pnlColor(stats.net)} sub={`${stats.closed} closed${stats.open ? ` · ${stats.open} open (${money(stats.floating)} floating)` : ''}`} />
            <StatTile label="Win rate" value={stats.winRate == null ? '—' : `${Math.round(stats.winRate * 100)}%`} sub={`${stats.wins} won · ${stats.losses} lost`} />
            <StatTile label="Profit factor" value={stats.profitFactor == null ? '—' : stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)} sub={`${money(stats.grossWin)} / ${money(stats.grossLoss)}`} />
            <StatTile label="Avg win / loss" value={`${stats.avgWin == null ? '—' : money(stats.avgWin)}`} sub={`avg loss ${stats.avgLoss == null ? '—' : money(stats.avgLoss)}`} valueColor={stats.avgWin ? colors.good : undefined} />
            <StatTile label="Best / worst" value={stats.best == null ? '—' : money(stats.best)} valueColor={stats.best ? pnlColor(stats.best) : undefined} sub={`worst ${stats.worst == null ? '—' : money(stats.worst)} · avg held ${held(stats.avgHoldMs)}`} />
          </KpiRow>

          {curve.length > 1 ? (
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.lg, marginBottom: space.lg }}>
              <Card style={{ flex: wide ? 1.4 : undefined }}>
                <EquityChart data={curve} initialBalance={0} title="Cumulative P&L" height={220} />
              </Card>
              {byBot.length > 1 ? (
                <View style={{ flex: wide ? 1 : undefined }}>
                  <Text style={[font.h2, { marginBottom: space.sm }]}>By bot</Text>
                  <DataTable columns={botColumns} rows={byBot} keyOf={(b) => b.key} onRowPress={(b) => setBot(b.key)} rowLabel={(b) => `Show only ${b.name}`} />
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Trades ----------------------------------------------------------------- */}
          <Text style={[font.h2, { marginBottom: space.sm }]}>Trades</Text>
          {filtered.length === 0 ? (
            <Card>
              <Empty title={all.length ? 'No trades match these filters' : 'No trades in this period'} body={all.length ? 'Try a wider period or clear the filters.' : 'Trades appear here as soon as a bot opens one.'} action={anyFilter ? <Button title="Clear filters" small onPress={clearFilters} /> : undefined} />
            </Card>
          ) : medium ? (
            <DataTable columns={columns} rows={pageRows} keyOf={(t) => t.positionId} onRowPress={setDetail} rowLabel={(t) => `${t.strategyName} ${t.symbol} trade, open details`} />
          ) : (
            pageRows.map((t) => (
              <Pressable key={t.positionId} onPress={() => setDetail(t)} accessibilityRole="button">
                <Card style={{ marginBottom: space.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                    {t.side ? <Badge label={t.side === 'long' ? 'BUY' : 'SELL'} tone={t.side === 'long' ? 'good' : 'critical'} /> : null}
                    <Text style={[font.h3, { flex: 1 }]} numberOfLines={1}>
                      {t.symbol} · {px(t.volume)}
                    </Text>
                    {t.profit == null ? null : <Pnl value={t.profit} size={15} />}
                  </View>
                  <Text style={[font.small, { marginTop: 4 }]} numberOfLines={1}>
                    {t.strategyName} · {when(t.openTime)} · held {held(t.durationMs)}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 6 }}>
                    <Text style={[font.small, { flex: 1 }]}>
                      {px(t.openPrice)} → {t.status === 'open' ? `${px(t.currentPrice)} now` : px(t.closePrice)}
                    </Text>
                    {t.status === 'open' ? <Badge label="OPEN" tone="accent" /> : t.status === 'unrecorded' ? <Badge label="NOT RECORDED" tone="warning" /> : <Badge label={REASON_LABEL[t.exitReason ?? 'unknown'].toUpperCase()} tone={reasonTone(t.exitReason) as any} />}
                  </View>
                </Card>
              </Pressable>
            ))
          )}
          {filtered.length > shown ? (
            <Button title={`Show ${Math.min(PAGE, filtered.length - shown)} more (${filtered.length - shown} left)`} variant="secondary" style={{ marginTop: space.md }} onPress={() => setShown((n) => n + PAGE)} />
          ) : null}
        </>
      ) : null}

      <Sheet visible={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.side === 'long' ? 'BUY' : detail.side === 'short' ? 'SELL' : ''} ${detail.symbol} · ${px(detail.volume)} lots` : ''}>
        {detail ? <TradeDetail t={detail} /> : null}
      </Sheet>
    </Page>
  );
}

/** A thin vertical rule between groups in the dense filter strip. */
function FilterSep() {
  return <View style={{ width: 1, height: 20, backgroundColor: colors.border }} />;
}

function TradeDetail({ t }: { t: JournalTrade }) {
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.md }}>
        {t.profit != null ? <Pnl value={t.profit} size={26} weight="700" /> : <Text style={font.h2}>—</Text>}
        <View style={{ flex: 1 }} />
        {t.status === 'open' ? <Badge label="OPEN" tone="accent" /> : t.status === 'unrecorded' ? <Badge label="NOT RECORDED" tone="warning" /> : <Badge label={REASON_LABEL[t.exitReason ?? 'unknown'].toUpperCase()} tone={reasonTone(t.exitReason) as any} />}
      </View>
      {t.status === 'unrecorded' ? (
        <Banner tone="warning">This trade was opened but its close was never recorded and MT5 has no history for it (paper mode, or the ticket is older than the broker keeps).</Banner>
      ) : null}
      <Row label="Bot" value={t.strategyName} />
      <Row label="Symbol" value={t.symbol} />
      <Row label="Side" value={t.side === 'long' ? 'Buy (long)' : t.side === 'short' ? 'Sell (short)' : '—'} />
      <Row label="Lots" value={px(t.volume)} />
      <Row label="Opened" value={t.openTime ? istFull(t.openTime) : '—'} />
      <Row label={t.status === 'open' ? 'Open for' : 'Closed'} value={t.status === 'open' ? held(t.durationMs) : t.closeTime ? istFull(t.closeTime) : '—'} />
      {t.status !== 'open' ? <Row label="Held" value={held(t.durationMs)} /> : null}
      <Row label="Entry price" value={px(t.openPrice)} />
      <Row label={t.status === 'open' ? 'Price now' : 'Exit price'} value={px(t.status === 'open' ? t.currentPrice : t.closePrice)} />
      <Row label="Stop-loss" value={px(t.stopLoss)} valueColor={t.stopLoss ? colors.criticalText : undefined} />
      <Row label="Take-profit" value={px(t.takeProfit)} valueColor={t.takeProfit ? colors.good : undefined} />
      <Row label="Planned reward : risk" value={t.plannedRR == null ? '—' : `${t.plannedRR} : 1`} />
      <Row label="Spread at entry" value={t.spreadPoints == null ? '—' : `${t.spreadPoints} pts`} />
      {t.commission ? <Row label="Commission" value={money(t.commission)} /> : null}
      {t.swap ? <Row label="Swap" value={money(t.swap)} /> : null}
      <Row label="Closed by" value={t.exitReason ? REASON_LABEL[t.exitReason] : t.status === 'open' ? 'Still open' : '—'} />
      <Row label="MT5 ticket" value={t.positionId} />
      <Text style={[font.small, { marginTop: space.md }]}>
        {t.source === 'broker' ? 'Prices and P&L confirmed from MetaTrader’s deal history (includes commission and swap).' : 'From the bot’s own log; exact MT5 details not available for this trade.'}
      </Text>
    </View>
  );
}
