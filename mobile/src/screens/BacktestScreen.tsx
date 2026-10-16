import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { EquityChart } from '../components/EquityChart';
import { ProposalChecks } from '../components/ProposalChecks';
import { Badge, Banner, Button, Card, Divider, Explain, ExplainedStat, NumberField, Row, SectionTitle, Stat } from '../components/ui';
import { useApp } from '../store';
import { colors, font, money, pct, pnlColor, radius, space } from '../theme';
import { istDateTime } from '../logic/time';
import type { BacktestResult, ChatProposal, Strategy } from '../types';

export function BacktestScreen({ strategy, onClose }: { strategy: Strategy; onClose: () => void }) {
  const { api, account, strategies, refreshStrategies } = useApp();
  const [bars, setBars] = useState(3000);
  const [balance, setBalance] = useState(10_000);
  const [spread, setSpread] = useState<number | null>(null);
  const [commission, setCommission] = useState<number | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTrades, setShowTrades] = useState(false);

  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

  // Keep working against the latest saved version of this strategy — once a
  // fix suggestion below is approved, the id stays the same but the config
  // underneath changes, and a re-run should test the new version.
  const [activeStrategy, setActiveStrategy] = useState(strategy);
  useEffect(() => {
    const fresh = strategies.find((s) => s.id === strategy.id);
    if (fresh) setActiveStrategy(fresh);
  }, [strategies, strategy.id]);

  // "This lost money — get a fix" flow, only offered once a backtest result
  // is in and it's actually bad. Separate from Optimize test settings above,
  // which only fills in realistic simulation numbers and never touches the
  // strategy itself.
  const [fixing, setFixing] = useState(false);
  const [fixReply, setFixReply] = useState<string | null>(null);
  const [fixProposals, setFixProposals] = useState<ChatProposal[]>([]);
  const [fixRejected, setFixRejected] = useState<string[]>([]);
  const [fixError, setFixError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const run = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    setFixReply(null);
    setFixProposals([]);
    setFixRejected([]);
    try {
      const r = await api.backtest({
        strategy: activeStrategy,
        bars,
        initialBalance: balance,
        ...(spread != null ? { spreadPoints: spread } : {}),
        ...(commission != null ? { commissionPerLot: commission } : {}),
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const m = result?.metrics;
  const isBad = !!m && m.totalTrades > 0 && (m.netProfit < 0 || m.profitFactor < 1);

  const fixStrategy = async () => {
    if (!api || !m) return;
    setFixing(true);
    setFixError(null);
    try {
      const message =
        `This backtest for "${activeStrategy.name}" (id ${activeStrategy.id}, ${activeStrategy.symbol} ${activeStrategy.timeframe}) came out negative under realistic settings: ` +
        `${bars} bars, ${spread != null ? `${spread}pt spread override` : "broker's live spread"}, ${commission != null ? `${commission}/lot commission` : 'no commission override'}, starting balance ${balance}. ` +
        `Result: ${m.totalTrades} trades, profit factor ${m.profitFactor.toFixed(2)}, net profit ${money(m.netProfit)} (${m.netProfitPct.toFixed(1)}%), win rate ${m.winRatePct.toFixed(
          1,
        )}%, max drawdown ${m.maxDrawdownPct.toFixed(1)}%. Look at the strategy's current configuration and this result, and suggest one deliberate change to fix it, explaining your reasoning.`;
      const r = await api.chat({ agent: 'optimizer', message, history: [] });
      setFixReply(r.reply);
      setFixProposals(r.proposals);
      setFixRejected(r.rejected);
    } catch (err) {
      setFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixing(false);
    }
  };

  const decide = async (p: ChatProposal, approve: boolean) => {
    if (!api) return;
    setActing(p.id);
    try {
      const updated = approve ? await api.approveProposal(p.id) : await api.rejectProposal(p.id);
      setFixProposals((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...updated } : x)));
      if (approve) await refreshStrategies();
    } catch (err) {
      setFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  // Fills in these four test-settings fields with real numbers instead of
  // guesses: the broker's actual current spread/commission for this symbol,
  // your real account balance, and enough bars of history to cover about a
  // month on this timeframe.
  const suggestSettings = async () => {
    if (!api) return;
    setSuggesting(true);
    setSuggestError(null);
    setSuggestNote(null);
    try {
      const spec = await api.symbolSpec(activeStrategy.symbol);
      setSpread(spec.spreadPoints);
      setCommission(spec.commissionPerLot);
      if (account?.balance) setBalance(Math.round(account.balance));
      const tfMinutes = timeframeMinutes(activeStrategy.timeframe);
      const targetBars = Math.round((30 * 1440) / tfMinutes);
      const monthBars = Math.max(200, Math.min(20_000, targetBars));
      setBars(monthBars);
      const days = Math.round((monthBars * tfMinutes) / 1440);
      setSuggestNote(
        `Filled in from your broker: ${spec.spreadPoints}pt spread, ${spec.commissionPerLot}/lot commission on ${activeStrategy.symbol}` +
          (account?.balance ? `, ${Math.round(account.balance)} starting balance (your real balance)` : '') +
          `, and ${monthBars} bars (${days} days of ${activeStrategy.timeframe} data${targetBars > 20_000 ? ' — capped at the 20,000-bar limit' : ''}).`,
      );
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, width: '100%', maxWidth: 1100, alignSelf: 'center' as const, }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
        <Pressable
          onPress={onClose}
          hitSlop={16}
          style={{ marginRight: space.sm, paddingVertical: space.sm, paddingRight: space.md, minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>‹ Back</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={font.h3} numberOfLines={1}>
            {activeStrategy.name}
          </Text>
          <Text style={font.small}>
            {activeStrategy.symbol} · {activeStrategy.timeframe}
          </Text>
        </View>
      </View>

      {error ? <Banner tone="critical">{error}</Banner> : null}

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md }}>
          <Text style={font.h3}>Test settings</Text>
          <Pressable onPress={suggestSettings} disabled={suggesting} hitSlop={8} style={{ paddingVertical: 4 }}>
            <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '600' }}>
              {suggesting ? 'Looking up…' : '⚡ Optimize test settings'}
            </Text>
          </Pressable>
        </View>
        <Text style={[font.small, { marginBottom: space.md }]}>
          Not sure what to put here? Optimize test settings pulls your broker's real spread and commission for this
          symbol, your actual account balance, and enough history for a realistic run — no guessing.
        </Text>
        {suggestError ? <Banner tone="critical">{suggestError}</Banner> : null}
        {suggestNote ? (
          <View style={{ marginBottom: space.md }}>
            <Banner tone="good">{suggestNote}</Banner>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg }}>
        <View style={{ flexGrow: 1, flexBasis: 280 }}>
        <NumberField
          label="Bars of history"
          value={bars}
          onChange={(v) => setBars(Math.max(200, Math.min(20_000, Math.round(v))))}
          step={500}
          hint={`${Math.round((bars * timeframeMinutes(activeStrategy.timeframe)) / 1440)} days of ${activeStrategy.timeframe} data.`}
        />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 280 }}>
        <NumberField label="Starting balance" value={balance} onChange={setBalance} step={1000} />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 280 }}>
        <NumberField
          label="Spread override (points)"
          value={spread ?? 0}
          onChange={(v) => setSpread(v <= 0 ? null : v)}
          step={1}
          hint="0 uses your broker's live spread. Raise it to stress-test a scalping strategy."
        />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 280 }}>
        <NumberField
          label="Commission per lot"
          value={commission ?? 0}
          onChange={(v) => setCommission(v <= 0 ? null : v)}
          step={1}
          hint="Round-turn, in account currency. Most raw-spread accounts charge 6–8."
        />
        </View>
        </View>
        <Explain title="What do these settings do?">
          <Text style={{ color: colors.text }}>Bars of history</Text> is how far back to test — more is
          better, 8000 is about a month of 5-minute candles.
          {'\n\n'}<Text style={{ color: colors.text }}>Spread override</Text> is the important one. Your
          demo broker quotes unusually tight spreads. Run the test once at 0, then again at a realistic
          figure for a real account. If the profit disappears, the strategy was living on cheap fills
          rather than a real edge — much better to find that out here than with money.
        </Explain>

        <Button title="Run backtest" onPress={run} loading={busy} />
      </Card>

      {result && m ? (
        <>
          <SectionTitle right={<Text style={font.small}>{result.candles} candles · {result.elapsedMs}ms</Text>}>
            Result
          </SectionTitle>

          <Explain title="New to this? Read the numbers in this order">
            1. <Text style={{ color: colors.text }}>Trades</Text> — under ~30 and nothing else here is
            trustworthy yet.
            {'\n'}2. <Text style={{ color: colors.text }}>Profit factor</Text> — below 1.0 it loses.
            This is the headline.
            {'\n'}3. <Text style={{ color: colors.text }}>Max drawdown</Text> — could you actually sit
            through that?
            {'\n\n'}Tap any number to see what it means. Net profit is the last thing to look at, not
            the first — it is the easiest one to get by luck.
          </Explain>

          {result.warnings.map((w, i) => (
            <Banner key={i} tone="warning">
              {w}
            </Banner>
          ))}

          {m.totalTrades === 0 ? (
            <Card>
              <Banner tone="warning">
                This strategy produced no trades over the tested window. Loosen the entry conditions, widen
                the session filter, or test more history.
              </Banner>
            </Card>
          ) : (
            <>
              <Card>
                <EquityChart
                  data={result.equity}
                  initialBalance={m.initialBalance}
                  title="Equity curve"
                  currency={account?.currency ?? ''}
                />
              </Card>

              <Card style={{ marginTop: space.sm }}>
                <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.md }}>
                  <ExplainedStat
                    label="Net profit"
                    value={money(m.netProfit)}
                    sub={pct(m.netProfitPct)}
                    valueColor={pnlColor(m.netProfit)}
                    help="What the account would have gained or lost over this period, after spread and commission. On its own it means little — a big profit from three lucky trades is not a strategy."
                  />
                  <ExplainedStat
                    label="Trades"
                    value={String(m.totalTrades)}
                    sub={`${m.longTrades}L / ${m.shortTrades}S`}
                    help="How many trades it took. Under about 30 and the other numbers are mostly noise — you cannot tell skill from luck on a handful of trades."
                  />
                  <ExplainedStat
                    label="Win rate"
                    value={`${m.winRatePct.toFixed(1)}%`}
                    sub={`${m.wins}W / ${m.losses}L`}
                    help="Share of trades that made money. A high win rate is not automatically good: winning 90% of the time still loses overall if the 10% losses are huge. Read this together with profit factor."
                  />
                </View>
                <Divider />
                <View style={{ flexDirection: 'row', gap: space.md }}>
                  <ExplainedStat
                    label="Profit factor"
                    value={m.profitFactor.toFixed(2)}
                    valueColor={m.profitFactor >= 1 ? colors.good : colors.criticalText}
                    sub={m.profitFactor >= 1.3 ? 'healthy' : m.profitFactor >= 1 ? 'thin edge' : 'losing'}
                    help="Money won divided by money lost. Below 1.0 the strategy loses. 1.0 to 1.2 is too thin to survive real costs. Above 1.3 across many trades is worth a closer look. This is the first number to read."
                  />
                  <ExplainedStat
                    label="Max drawdown"
                    value={`${m.maxDrawdownPct.toFixed(1)}%`}
                    sub={money(-m.maxDrawdown)}
                    valueColor={m.maxDrawdownPct > 20 ? colors.criticalText : colors.text}
                    help="The worst peak-to-trough fall the account went through. This is the pain you would have had to sit through. Ask yourself honestly whether you would have switched the bot off at that point — most people would."
                  />
                  <ExplainedStat
                    label="Expectancy"
                    value={money(m.expectancy)}
                    sub="per trade"
                    valueColor={pnlColor(m.expectancy)}
                    help="Average profit or loss per trade. Multiply by how many trades you expect in a week to get a realistic sense of the pace. If it is negative, more trading just loses faster."
                  />
                </View>
              </Card>

              {isBad ? (
                <Card style={{ marginTop: space.sm }}>
                  <Text style={[font.h3, { marginBottom: space.xs }]}>Not profitable under these settings</Text>
                  <Text style={[font.small, { marginBottom: space.md }]}>
                    Profit factor {m.profitFactor.toFixed(2)} and net {money(m.netProfit)} — this configuration is
                    losing money here. Send this exact result to the Optimizer agent and it'll look at the
                    strategy's current setup plus these numbers and suggest one change. Nothing changes until you
                    approve it.
                  </Text>
                  <Button title="Get a fix suggestion" variant="secondary" onPress={fixStrategy} loading={fixing} />

                  {fixError ? <Banner tone="critical">{fixError}</Banner> : null}

                  {fixReply ? (
                    <View style={{ marginTop: space.md, gap: space.sm }}>
                      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{fixReply}</Text>
                      {fixRejected.map((r, i) => (
                        <Banner key={i} tone="warning">
                          Could not propose: {r}
                        </Banner>
                      ))}
                      {fixProposals.map((p) => (
                        <View
                          key={p.id}
                          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: space.md, backgroundColor: colors.surface }}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.xs }}>
                            <Badge
                              label={p.status.toUpperCase()}
                              tone={p.status === 'approved' ? 'good' : p.status === 'failed' ? 'critical' : p.status === 'rejected' ? 'neutral' : 'accent'}
                            />
                          </View>
                          <Text style={[font.h3, { marginBottom: space.xs }]}>{p.summary}</Text>
                          {p.reason ? <Text style={[font.body, { marginBottom: space.xs }]}>{p.reason}</Text> : null}
                          {p.warnings.map((w, i) => (
                            <Text key={i} style={{ color: colors.warning, fontSize: 12, marginBottom: 2 }}>
                              ⚠ {w}
                            </Text>
                          ))}
                          <ProposalChecks validation={p.validation} critic={p.critic} />
                          {p.resultMessage ? <Text style={[font.small, { marginTop: space.xs }]}>{p.resultMessage}</Text> : null}
                          {p.status === 'pending' && (
                            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
                              <Button title="Approve" variant="success" small loading={acting === p.id} onPress={() => void decide(p, true)} style={{ flex: 1 }} />
                              <Button title="Reject" variant="ghost" small disabled={acting === p.id} onPress={() => void decide(p, false)} style={{ flex: 1 }} />
                            </View>
                          )}
                          {p.status === 'approved' && (
                            <Text style={[font.small, { marginTop: space.sm, color: colors.good }]}>
                              Applied. Run the backtest again above to see how it does.
                            </Text>
                          )}
                        </View>
                      ))}
                    </View>
                  ) : null}
                </Card>
              ) : null}

              <Card style={{ marginTop: space.sm }}>
                <Text style={[font.h3, { marginBottom: space.sm }]}>Detail</Text>
                <Row label="Average win" value={money(m.avgWin)} valueColor={colors.good} />
                <Row label="Average loss" value={money(m.avgLoss)} valueColor={colors.criticalText} />
                <Row label="Largest win" value={money(m.largestWin)} />
                <Row label="Largest loss" value={money(m.largestLoss)} />
                <Row label="Worst losing streak" value={`${m.maxConsecutiveLosses} trades`} />
                <Row label="Sharpe (per trade, annualised)" value={m.sharpe.toFixed(2)} />
                <Row label="Total commission" value={money(-m.totalCommission)} />
                <Row label="Average hold" value={`${m.avgBarsHeld.toFixed(1)} bars`} />
                <Row label="Final balance" value={m.finalBalance.toFixed(2)} />
              </Card>

              <Banner tone="warning">
                A backtest is a lower bound on how wrong things can go, not a forecast. Slippage, requotes,
                news gaps and weekend spread widening all hit live scalping harder than any simulation.
              </Banner>

              <Button
                title={showTrades ? 'Hide trades' : `Show all ${result.trades.length} trades`}
                variant="secondary"
                onPress={() => setShowTrades((v) => !v)}
              />

              {showTrades && (
                <Card style={{ marginTop: space.sm }} padded={false}>
                  {result.trades.map((t) => (
                    <View key={t.id} style={{ padding: space.md, borderBottomWidth: 1, borderColor: colors.border }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                        <Badge label={t.side.toUpperCase()} tone={t.side === 'long' ? 'good' : 'critical'} />
                        <Text style={[font.small, { marginLeft: space.sm, flex: 1 }]}>
                          {istDateTime(t.openTime)}
                        </Text>
                        <Text style={{ color: pnlColor(t.netProfit), fontWeight: '700', fontVariant: ['tabular-nums'] }}>
                          {money(t.netProfit)}
                        </Text>
                      </View>
                      <Text style={font.small}>
                        {t.lots} lots · {t.openPrice} → {t.closePrice} · closed on {reasonLabel(t.reason)} · {t.barsHeld} bars
                      </Text>
                    </View>
                  ))}
                </Card>
              )}
            </>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

function reasonLabel(r: string): string {
  return (
    { sl: 'stop loss', tp: 'take profit', signal: 'exit rule', opposite: 'opposite signal', end: 'end of test' } as Record<
      string,
      string
    >
  )[r] ?? r;
}

function timeframeMinutes(tf: string): number {
  return { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 }[tf] ?? 5;
}
