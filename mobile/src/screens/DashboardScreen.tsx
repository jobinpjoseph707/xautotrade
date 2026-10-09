import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';

import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  Empty,
  KpiRow,
  Page,
  PageHeader,
  Pnl,
  StatTile,
  StatusPill,
  marketBlocked,
  marketState,
  type Column,
} from '../components/ui';
import { confirmAction, notify } from '../confirm';
import { useLayout } from '../layout';
import { dashboardTotals, tagOf } from '../logic/totals';
import { useApp } from '../store';
import { colors, font, money, pnlColor, radius, space } from '../theme';
import type { BotSnapshot, BrokerPosition, MarketStatus, Strategy } from '../types';

function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
/** Normal waiting states, not problems: shown quietly, never as alerts. */
const ROUTINE = /^(Max open positions|Cooling down|Outside the configured|Waiting for history)/;
const needsAttention = (reason: string | null | undefined) => !!reason && !ROUTINE.test(reason);

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

interface BotRow {
  strategy: Strategy;
  market: MarketStatus | undefined;
  bot: BotSnapshot | undefined;
  running: boolean;
  floating: number;
  realised: number;
  trades: number;
  open: number;
}

export function DashboardScreen({
  onOpenStrategies,
  onOpenBot,
  onOpenActivity,
}: {
  onOpenStrategies: () => void;
  onOpenBot: (s: Strategy) => void;
  onOpenActivity: () => void;
}) {
  const { api, account, accountAt, bots, strategies, markets, refresh, socketUp, error } = useApp();
  const { wide, medium } = useLayout();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  // Every strategy is a potential bot: show them all so a bot can be started from here.
  const rows: BotRow[] = useMemo(() => {
    const list = strategies.map((st) => {
      const bot = bots[st.id];
      const running = bot?.status === 'running';
      const positions = running ? bot!.openPositions : [];
      return {
        strategy: st,
        market: markets[st.symbol.toUpperCase()],
        bot,
        running,
        floating: positions.reduce((a, p) => a + p.profit, 0),
        realised: bot?.realisedToday ?? 0,
        trades: bot?.tradesToday ?? 0,
        open: positions.length,
      };
    });
    return list.sort((a, b) => Number(b.running) - Number(a.running) || Math.abs(b.realised + b.floating) - Math.abs(a.realised + a.floating) || a.strategy.name.localeCompare(b.strategy.name));
  }, [strategies, bots, markets]);

  const byTag = useMemo(() => new Map(strategies.map((st) => [tagOf(st.id), st])), [strategies]);
  // Several bots on one symbol can report the same broker position: dedupe by ticket.
  const positions: BrokerPosition[] = useMemo(
    () => [...new Map(Object.values(bots).filter((b) => b.status === 'running').flatMap((b) => b.openPositions).map((p) => [p.id, p])).values()],
    [bots],
  );
  // Test strategies (isTest) stay in the list but never count in any total.
  const totals = useMemo(() => dashboardTotals(rows, positions, strategies), [rows, positions, strategies]);
  const { floating, realised: realisedToday, trades: tradesToday, openCount } = totals;
  const running = rows.filter((r) => r.running).length;
  const dayStart = Object.values(bots).find((b) => b.dayStartEquity)?.dayStartEquity ?? null;
  const dayChange = account && dayStart ? account.equity - dayStart : null;
  // Problems worth interrupting for: a symbol the broker can't trade (even for a
  // stopped strategy — it could never run), bot errors, and real blocks.
  const alerts = rows
    .map((r) =>
      marketBlocked(r.market)
        ? { r, tone: 'critical' as const, text: r.market!.reason ?? `${r.strategy.symbol} can't be traded on this account.` }
        : r.bot?.error
          ? { r, tone: 'critical' as const, text: r.bot.error }
          : r.running && needsAttention(r.bot?.blockedReason)
            ? { r, tone: 'warning' as const, text: r.bot!.blockedReason! }
            : null,
    )
    .filter((a): a is { r: BotRow; tone: 'critical' | 'warning'; text: string } => !!a);

  const toggle = async (r: BotRow) => {
    if (!api) return;
    setBusy(r.strategy.id);
    try {
      if (r.running) await api.stopBot(r.strategy.id);
      else await api.startBot(r.strategy.id);
      await refresh();
    } catch (err) {
      notify(r.running ? 'Could not stop' : 'Could not start', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const doPanic = () =>
    confirmAction(
      'Stop everything?',
      'This stops every bot and closes all positions they opened, at market. Positions you opened manually in MT5 are not touched.',
      'Stop & close',
      async () => {
        setBusy('panic');
        try {
          const r = await api!.panic();
          await refresh();
          notify('Stopped', `All bots stopped. ${r.closed} position(s) closed.`);
        } catch (err) {
          notify('Failed', err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(null);
        }
      },
      { destructive: true },
    );

  const closePosition = (p: BrokerPosition) =>
    confirmAction(
      'Close position?',
      `${p.side === 'long' ? 'BUY' : 'SELL'} ${p.volume} ${p.symbol} at market (P&L now ${money(p.profit)}).`,
      'Close',
      async () => {
        setBusy(p.id);
        try {
          await api!.closePosition(p.id);
          await refresh();
        } catch (err) {
          notify('Failed', err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(null);
        }
      },
      { destructive: true },
    );

  const statusOf = (r: BotRow) => (r.bot?.error ? 'error' : r.running && needsAttention(r.bot?.blockedReason) ? 'blocked' : r.bot?.status ?? 'stopped');

  // ---------------------------------------------------------------- tables
  const botColumns: Column<BotRow>[] = [
    {
      key: 'bot',
      title: 'Strategy',
      flex: 1.9,
      render: (r) => (
        <View>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
            {r.strategy.name}
          </Text>
          <Text style={font.small} numberOfLines={1}>
            {r.strategy.symbol} · {r.strategy.timeframe}
            {r.running && r.bot?.blockedReason && !needsAttention(r.bot.blockedReason) ? ` · ${r.bot.blockedReason.replace(/\.$/, '')}` : ''}
          </Text>
        </View>
      ),
    },
    { key: 'status', title: 'Bot', flex: 1.1, render: (r) => <StatusPill status={statusOf(r)} /> },
    { key: 'market', title: 'Market', flex: 1.35, render: (r) => <StatusPill status={marketState(r.market)} /> },
    {
      key: 'signal',
      title: 'Signal',
      flex: 0.8,
      render: (r) => <Text style={{ color: r.bot?.lastSignal && r.bot.lastSignal !== 'none' ? colors.text : colors.muted, fontSize: 13, fontWeight: '600' }}>{r.running ? r.bot?.lastSignal ?? '—' : '—'}</Text>,
    },
    { key: 'trades', title: 'Trades', flex: 0.75, align: 'right', render: (r) => String(r.trades) },
        { key: 'floating', title: 'Floating', flex: 1, align: 'right', render: (r) => (r.open ? <Pnl value={r.floating} showGlyph={false} /> : <Text style={{ color: colors.muted }}>—</Text>) },
    { key: 'realised', title: 'Realised', flex: 1, align: 'right', render: (r) => <Pnl value={r.realised} showGlyph={false} muted /> },
    { key: 'bar', title: 'Last bar', flex: 1.1, align: 'right', render: (r) => (r.running && r.bot?.lastBarTime ? hhmm(r.bot.lastBarTime) : '—') },
    {
      key: 'action',
      title: '',
      width: 88,
      interactive: true,
      align: 'right',
      render: (r) => (
        <Button
          title={r.running ? 'Stop' : 'Start'}
          small
          variant={r.running ? 'secondary' : 'success'}
          loading={busy === r.strategy.id}
          disabled={!r.running && marketBlocked(r.market)}
          accessibilityLabel={!r.running && marketBlocked(r.market) ? `Can't start: ${r.strategy.symbol} is not tradable here` : undefined}
          onPress={() => void toggle(r)}
          style={{ minWidth: 72 }}
        />
      ),
    },
  ];

  const posColumns: Column<BrokerPosition>[] = [
    {
      key: 'sym',
      title: 'Position',
      flex: 1.6,
      render: (p) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Badge label={p.side === 'long' ? 'BUY' : 'SELL'} tone={p.side === 'long' ? 'good' : 'critical'} />
          <Text style={{ color: colors.text, fontWeight: '600' }}>
            {p.symbol} · {p.volume}
          </Text>
        </View>
      ),
    },
    { key: 'bot', title: 'Bot', flex: 1.6, render: (p) => byTag.get((p.comment ?? '').slice(0, 12))?.name ?? 'Manual' },
    { key: 'entry', title: 'Entry', flex: 1, align: 'right', render: (p) => String(p.openPrice) },
    { key: 'now', title: 'Now', flex: 1, align: 'right', render: (p) => String(p.currentPrice) },
    { key: 'sl', title: 'Stop', flex: 1, align: 'right', render: (p) => (p.stopLoss ? String(p.stopLoss) : '—') },
    { key: 'tp', title: 'Target', flex: 1, align: 'right', render: (p) => (p.takeProfit ? String(p.takeProfit) : '—') },
    { key: 'pnl', title: 'P&L', flex: 1, align: 'right', render: (p) => <Pnl value={p.profit} /> },
    {
      key: 'close',
      title: '',
      width: 96,
      align: 'right',
      render: (p) => <Button title="Close" small variant="ghost" loading={busy === p.id} onPress={() => closePosition(p)} style={{ minWidth: 72 }} />,
    },
  ];

  // ---------------------------------------------------------------- render
  return (
    <Page refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}>
      <PageHeader
        title="Dashboard"
        subtitle={
          <Text style={[font.small, { marginTop: 2 }]}>
            {account ? `${account.broker} · ${account.name || account.server}` : 'Account not loaded'} · updated {ago(accountAt, now)}
          </Text>
        }
        right={
          <>
            <StatusPill status={account?.type === 'demo' ? 'running' : 'error'} label={account?.type === 'demo' ? 'Demo account' : 'LIVE account'} />
            <StatusPill status={socketUp ? 'running' : 'starting'} label={socketUp ? 'Live' : 'Polling'} />
            <Button title="Refresh" small variant="secondary" icon="↻" onPress={() => void onRefresh()} loading={refreshing} />
            {!wide && (running > 0 || positions.length > 0) ? (
              <Button title="Stop all" small variant="danger" icon="■" onPress={doPanic} loading={busy === 'panic'} />
            ) : null}
          </>
        }
      />

      {error ? <Banner tone="critical">{error}</Banner> : null}
      {account?.mode === 'paper' ? <Banner tone="accent">Paper mode — simulated prices, no broker attached.</Banner> : null}
      {account && account.type !== 'demo' ? <Banner tone="warning">This is a LIVE account. Every order the bots place risks real money.</Banner> : null}

      {alerts.length > 0 ? (
        <View style={{ gap: space.xs, marginBottom: space.md }}>
          {alerts.map(({ r, tone, text }) => (
            <Pressable key={r.strategy.id} onPress={() => onOpenBot(r.strategy)} accessibilityRole="button">
              <Banner tone={tone}>
                <Text style={{ fontWeight: '700', color: colors.text }}>{r.strategy.name}: </Text>
                {text} <Text style={{ color: colors.accent }}>View ›</Text>
              </Banner>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* KPIs --------------------------------------------------------- */}
      <KpiRow>
        <StatTile
          hero
          minWidth={medium ? 260 : 200}
          label={`Equity${account?.currency ? ` (${account.currency})` : ''}`}
          value={account ? account.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
          delta={dayChange}
          deltaLabel="today"
        />
        <StatTile label="Balance" value={account ? account.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'} sub={account ? `Free margin ${account.freeMargin.toFixed(2)}` : undefined} />
        <StatTile label="Floating P&L" value={money(floating)} valueColor={pnlColor(floating)} sub={`${openCount} open position${openCount === 1 ? '' : 's'}`} />
        <StatTile label="Realised today" value={money(realisedToday)} valueColor={pnlColor(realisedToday)} sub={`${tradesToday} trade${tradesToday === 1 ? '' : 's'} since 00:00 UTC`} />
        <StatTile label="Bots running" value={`${running} / ${rows.length}`} sub={alerts.length ? `${alerts.length} need attention` : 'All clear'} />
      </KpiRow>

      {/* Bots + P&L chart ------------------------------------------------ */}
      <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.lg, alignItems: 'flex-start' }}>
        <View style={{ flex: wide ? 2.6 : undefined, width: wide ? undefined : '100%' }}>
          <SectionHead title="Bots" hint="Click a bot for its trades and history" right={<Button title="Manage strategies" small variant="ghost" onPress={onOpenStrategies} />} />
          {rows.length === 0 ? (
            <Card>
              <Empty title="No strategies yet" body="Create a strategy, backtest it, then start it here." action={<Button title="Go to strategies" onPress={onOpenStrategies} small />} />
            </Card>
          ) : medium ? (
            <DataTable columns={botColumns} rows={rows} keyOf={(r) => r.strategy.id} onRowPress={(r) => onOpenBot(r.strategy)} rowLabel={(r) => `${r.strategy.name}, ${statusOf(r)}`} />
          ) : (
            rows.map((r) => <BotCard key={r.strategy.id} row={r} status={statusOf(r)} busy={busy === r.strategy.id} onToggle={() => void toggle(r)} onOpen={() => onOpenBot(r.strategy)} />)
          )}
        </View>

        <View style={{ flex: wide ? 1 : undefined, width: wide ? undefined : '100%', minWidth: wide ? 300 : undefined }}>
          <SectionHead title="Today's P&L by bot" hint="Realised + floating since 00:00 UTC" />
          <PnlBars rows={rows} onOpen={(r) => onOpenBot(r.strategy)} />
        </View>
      </View>

      {/* Positions --------------------------------------------------------- */}
      <SectionHead title="Open positions" hint={positions.length ? `${positions.length} open · updates every few seconds` : undefined} right={<Button title="Activity log" small variant="ghost" onPress={onOpenActivity} />} />
      {positions.length === 0 ? (
        <Card>
          <Text style={font.body}>No open positions.</Text>
        </Card>
      ) : medium ? (
        <DataTable columns={posColumns} rows={positions} keyOf={(p) => p.id} />
      ) : (
        positions.map((p) => (
          <Card key={p.id} style={{ marginBottom: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Badge label={p.side === 'long' ? 'BUY' : 'SELL'} tone={p.side === 'long' ? 'good' : 'critical'} />
              <Text style={[font.h3, { flex: 1 }]}>
                {p.symbol} · {p.volume}
              </Text>
              <Pnl value={p.profit} size={16} />
            </View>
            <Text style={[font.small, { marginTop: space.xs }]}>
              {byTag.get((p.comment ?? '').slice(0, 12))?.name ?? 'Manual'} · {p.openPrice} → {p.currentPrice} · SL {p.stopLoss ?? '—'} / TP {p.takeProfit ?? '—'}
            </Text>
            <Button title="Close at market" variant="ghost" small style={{ marginTop: space.sm }} loading={busy === p.id} onPress={() => closePosition(p)} />
          </Card>
        ))
      )}
    </Page>
  );
}

function SectionHead({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.md, marginTop: space.lg, marginBottom: space.sm }}>
      <View style={{ flex: 1 }}>
        <Text style={font.h2}>{title}</Text>
        {hint ? <Text style={font.small}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  );
}

/**
 * Diverging horizontal bars around a zero baseline (one axis, one measure).
 * Sign is carried by direction + the signed label, not colour alone. Each row
 * is a hover/press target that opens the bot; the Bots table is the table view.
 */
function PnlBars({ rows, onOpen }: { rows: BotRow[]; onOpen: (r: BotRow) => void }) {
  const data = rows
    .map((r) => ({ r, v: Math.round((r.realised + r.floating) * 100) / 100 }))
    .filter((d) => d.r.running || d.v !== 0)
    .sort((a, b) => b.v - a.v);
  const max = Math.max(...data.map((d) => Math.abs(d.v)), 0.01);
  const total = data.reduce((a, d) => a + d.v, 0);

  if (data.length === 0) {
    return (
      <Card>
        <Text style={font.body}>No bot activity today yet.</Text>
      </Card>
    );
  }
  return (
    <Card padded={false} style={{ paddingVertical: space.sm }}>
      {data.map(({ r, v }) => {
        const w = `${(Math.abs(v) / max) * 100}%` as const;
        return (
          <Pressable
            key={r.strategy.id}
            onPress={() => onOpen(r)}
            accessibilityRole="button"
            accessibilityLabel={`${r.strategy.name}: ${money(v)} today`}
            style={(state) => [
              { paddingHorizontal: space.lg, paddingVertical: 7 },
              (state as { hovered?: boolean }).hovered ? { backgroundColor: colors.surfaceHover } : null,
            ]}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5, gap: space.sm }}>
              <Text style={{ color: colors.textSecondary, fontSize: 13, flex: 1 }} numberOfLines={1}>
                {r.strategy.name} <Text style={font.small}>{r.strategy.symbol}</Text>
              </Text>
              <Pnl value={v} size={13} />
            </View>
            {/* track: left half = losses, right half = gains, 1px zero baseline */}
            <View style={{ flexDirection: 'row', height: 8, alignItems: 'center' }}>
              <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'flex-end' }}>
                {v < 0 ? <View style={{ width: w, height: 8, backgroundColor: colors.critical, borderTopLeftRadius: 4, borderBottomLeftRadius: 4 }} /> : null}
              </View>
              <View style={{ width: 1, height: 14, backgroundColor: colors.axis }} />
              <View style={{ flex: 1, flexDirection: 'row' }}>
                {v > 0 ? <View style={{ width: w, height: 8, backgroundColor: colors.good, borderTopRightRadius: 4, borderBottomRightRadius: 4 }} /> : null}
              </View>
            </View>
          </Pressable>
        );
      })}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.sm, marginTop: space.xs, borderTopWidth: 1, borderColor: colors.border }}>
        <Text style={font.small}>Total</Text>
        <Pnl value={total} size={13} />
      </View>
    </Card>
  );
}

function BotCard({ row, status, busy, onToggle, onOpen }: { row: BotRow; status: string; busy: boolean; onToggle: () => void; onOpen: () => void }) {
  const { strategy: st, bot } = row;
  return (
    <Card style={{ marginBottom: space.sm }}>
      {/* The tappable area stops above the buttons: a button inside a button is invalid HTML on the web. */}
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${st.name}, ${status}. Open details.`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Text style={font.h3} numberOfLines={1}>
              {st.name}
            </Text>
            <Text style={font.small}>
              {st.symbol} · {st.timeframe}
              {row.running && bot?.lastBarTime ? ` · last bar ${hhmm(bot.lastBarTime)}` : ''}
            </Text>
          </View>
          <View style={{ gap: 4, alignItems: 'flex-end' }}>
            <StatusPill status={status} />
            <StatusPill status={marketState(row.market)} label={`Market ${marketState(row.market) === 'unavailable' ? 'not offered' : marketState(row.market) === 'close_only' ? 'close only' : marketState(row.market) === 'unknown' ? '…' : marketState(row.market)}`} />
          </View>
        </View>

        {marketBlocked(row.market) ? (
          <View style={{ marginTop: space.sm }}>
            <Banner tone="critical">{row.market!.reason}</Banner>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', marginTop: space.md, gap: space.sm }}>
          <Mini label="Signal" value={<Text style={{ color: colors.text, fontWeight: '600' }}>{row.running ? bot?.lastSignal ?? '—' : '—'}</Text>} />
          <Mini label="Trades" value={<Text style={{ color: colors.text, fontWeight: '600' }}>{row.trades}</Text>} />
          <Mini label={`Floating · ${row.open}`} value={row.open ? <Pnl value={row.floating} showGlyph={false} /> : <Text style={{ color: colors.muted }}>—</Text>} />
          <Mini label="Realised" value={<Pnl value={row.realised} showGlyph={false} muted />} />
        </View>

        {row.running
          ? bot!.openPositions.map((p) => (
              <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderColor: colors.border }}>
                <Badge label={p.side === 'long' ? 'BUY' : 'SELL'} tone={p.side === 'long' ? 'good' : 'critical'} />
                <Text style={[font.mono, { flex: 1 }]} numberOfLines={1}>
                  {p.volume} @ {p.openPrice} → {p.currentPrice}
                </Text>
                <Pnl value={p.profit} size={13} />
              </View>
            ))
          : null}

        {bot?.error ? (
          <View style={{ marginTop: space.sm }}>
            <Banner tone="critical">{bot.error}</Banner>
          </View>
        ) : row.running && bot?.blockedReason ? (
          needsAttention(bot.blockedReason) ? (
            <View style={{ marginTop: space.sm }}>
              <Banner tone="warning">{bot.blockedReason}</Banner>
            </View>
          ) : (
            <Text style={[font.small, { marginTop: space.sm }]}>{bot.blockedReason}</Text>
          )
        ) : null}

      </Pressable>

        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
          <Button title="Details" small variant="secondary" style={{ flex: 1 }} onPress={onOpen} />
          <Button
            title={row.running ? 'Stop' : 'Start'}
            small
            variant={row.running ? 'secondary' : 'success'}
            style={{ flex: 1 }}
            loading={busy}
            disabled={!row.running && marketBlocked(row.market)}
            onPress={onToggle}
          />
        </View>
    </Card>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View style={{ flex: 1, gap: 3, padding: space.sm, backgroundColor: colors.bg, borderRadius: radius.md }}>
      <Text style={[font.small, { fontSize: 11 }]} numberOfLines={1}>
        {label}
      </Text>
      {value}
    </View>
  );
}
