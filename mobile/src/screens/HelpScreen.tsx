import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Banner, Button, Card, Divider, Explain, Page, PageHeader } from '../components/ui';
import { useLayout } from '../layout';
import { ROUTINE, TAB_ACTIONS, WHEN_YOU_SEE, entryById, type HelpEntry } from '../logic/help';
import { IST_NOTE, sortMarkets, summaryLine, USUAL_HOURS, WATCHLIST, type MarketRow, type MarketsNow } from '../logic/markets';
import { istTimeSeconds } from '../logic/time';
import { NAV, type Tab } from '../logic/nav';
import { useApp } from '../store';
import { colors, font, radius, space } from '../theme';

/**
 * Help: what to do each day, what to do when you see a message, one action line per tab, and then the
 * longer explanation of each tab. The first three come from logic/help.ts (so a test can check them);
 * static content, so it works even before you've connected. The one live part is "Markets trading now",
 * which asks the broker and says so plainly when it cannot.
 */

function P({ children }: { children: React.ReactNode }) {
  return <Text style={[font.body, { marginBottom: space.sm, lineHeight: 20 }]}>{children}</Text>;
}

function Manual({ icon, shortcut, title, children }: { icon: string; shortcut?: number; title: string; children: React.ReactNode }) {
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: colors.accentDim, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.accent, fontSize: 14 }}>{icon}</Text>
        </View>
        <Text style={[font.h3, { flex: 1 }]}>{title}</Text>
        {shortcut ? <Text style={{ color: colors.muted, fontSize: 11, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>key {shortcut}</Text> : null}
      </View>
      {children}
    </Card>
  );
}


/** Section heading in sentence case, with an optional one-line note under it. */
function Heading({ title, note }: { title: string; note?: string }) {
  return (
    <View style={{ marginTop: space.xl, marginBottom: space.md }}>
      <Text style={font.h2} accessibilityRole="header">{title}</Text>
      {note ? <Text style={[font.small, { marginTop: 2 }]}>{note}</Text> : null}
    </View>
  );
}

/** A message in the "when you see this" list: what you see, what it means, what to do. A bar on the left marks it. */
function EntryRow({ e, highlight, onOpenTab }: { e: HelpEntry; highlight?: boolean; onOpenTab?: (t: Tab) => void }) {
  return (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: highlight ? colors.accent : colors.borderStrong,
        backgroundColor: highlight ? colors.accentDim : colors.surface,
        borderRadius: radius.md,
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        flex: 1,
        minWidth: 280,
      }}
    >
      <Text style={[font.h3, { marginBottom: space.xs }]}>{e.see}</Text>
      <Text style={[font.body, { lineHeight: 20, marginBottom: space.sm }]}>
        <Text style={{ color: colors.muted }}>What it means. </Text>
        {e.means}
      </Text>
      <Text style={[font.body, { color: colors.text, lineHeight: 20 }]}>
        <Text style={{ color: colors.accent, fontWeight: '700' }}>What to do. </Text>
        {e.do}
      </Text>
      {e.open && onOpenTab ? (
        <View style={{ flexDirection: 'row', marginTop: space.sm }}>
          <Button title={e.open.label} small variant="secondary" onPress={() => onOpenTab(e.open!.tab)} />
        </View>
      ) : null}
    </View>
  );
}

/** One open market as a tile: symbol, name, spread. The green bar and the word "open" both say it is open. */
function MarketTile({ m }: { m: MarketRow }) {
  const { wide } = useLayout();
  return (
    <View
      accessibilityLabel={`${m.symbol}, ${m.name}, open${m.spreadPoints != null ? `, spread ${m.spreadPoints} points` : ''}`}
      style={{
        flexGrow: 1,
        flexBasis: wide ? 168 : 140,
        maxWidth: wide ? 260 : undefined,
        backgroundColor: colors.surfaceAlt,
        borderRadius: radius.md,
        borderLeftWidth: 3,
        borderLeftColor: colors.good,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 }}>{m.symbol}</Text>
        <Text style={{ color: colors.good, fontSize: 12, fontWeight: '700' }}>● open</Text>
      </View>
      <Text style={font.small} numberOfLines={1}>{m.name}</Text>
      <Text style={[font.body, { marginTop: 4, color: colors.text }]}>
        {m.spreadPoints != null ? `Spread ${m.spreadPoints} pts` : 'Spread not reported'}
      </Text>
    </View>
  );
}

/** Closed and not-offered markets, one quiet line each, behind a toggle so the open ones stay the focus. */
function OtherMarkets({ rows, title }: { rows: MarketRow[]; title: string }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <View style={{ marginTop: space.md }}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={8}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={[font.h3, { flex: 1, color: colors.textSecondary }]}>{`${title} (${rows.length})`}</Text>
        <Text style={font.small}>{open ? 'hide' : 'show'}</Text>
      </Pressable>
      {open ? (
        <View style={{ marginTop: space.sm }}>
          {rows.map((m) => (
            <View key={m.symbol} style={{ flexDirection: 'row', gap: space.md, paddingVertical: 5, borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={[font.h3, { width: 80 }]}>{m.symbol}</Text>
              <Text style={[font.small, { flex: 1 }]}>{`${m.name}. ${m.note}`}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The one thing Help leads with: which markets can take a new trade right now, straight from the broker. */
function MarketsBoard() {
  const { api } = useApp();
  const [data, setData] = useState<MarketsNow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!api) {
      setError('Connect to the server in Settings to see live market status.');
      return;
    }
    setLoading(true);
    try {
      setData(sortMarkets(await api.markets(WATCHLIST.map((w) => w.symbol))));
      setCheckedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card style={{ borderColor: colors.borderStrong, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 240 }}>
          <Text style={font.h2} accessibilityRole="header">Markets trading now</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm, marginTop: space.xs }}>
            <Text style={font.hero}>{data ? String(data.open.length) : '–'}</Text>
            <Text style={[font.h3, { color: colors.textSecondary }]}>open</Text>
          </View>
          <Text style={[font.body, { marginTop: 2 }]}>{data ? summaryLine(data) : 'Asking your broker…'}</Text>
        </View>
        <Button title={loading ? 'Checking…' : 'Check again'} small variant="secondary" onPress={() => void load()} disabled={loading} />
      </View>

      {error ? <View style={{ marginTop: space.md }}><Banner tone="warning">{error}</Banner></View> : null}

      {data && data.open.length > 0 ? (
        <View style={{ marginTop: space.lg }}>
          <Text style={[font.small, { marginBottom: space.sm }]}>Open now, cheapest spread first</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {data.open.map((m) => <MarketTile key={m.symbol} m={m} />)}
          </View>
        </View>
      ) : null}

      {data ? <OtherMarkets rows={data.closed} title="Closed right now" /> : null}
      {data ? <OtherMarkets rows={data.unavailable} title="Not available on this account" /> : null}

      <Text style={[font.small, { marginTop: space.md }]}>
        {checkedAt ? `Checked at ${istTimeSeconds(checkedAt)} IST. ` : ''}
        In paper mode every market is simulated and always open. With a real broker, some name symbols with an extra
        letter (for example XAUUSDm), so a market can show as not available even though it trades there; use the exact
        name from MetaTrader when you build a strategy.
      </Text>
      <Explain title="Usual trading hours (IST)">
        {USUAL_HOURS.map((h) => (
          <P key={h.group}>
            <Text style={{ color: colors.text }}>{h.group}: </Text>
            {h.text}
          </P>
        ))}
        <P>{IST_NOTE}</P>
        <P>These are typical hours. The live list above is what counts, because brokers differ and holidays change things.</P>
      </Explain>
    </Card>
  );
}

/** The daily routine: a real sequence, so the steps are numbered. */
function Routine() {
  return (
    <View>
      {ROUTINE.map((r) => (
        <Card key={r.title} style={{ marginBottom: space.md }}>
          <Text style={[font.h3, { marginBottom: space.sm }]}>{r.title}</Text>
          {r.steps.map((step, j) => (
            <View key={j} style={{ flexDirection: 'row', gap: space.md, marginBottom: space.sm }}>
              <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accentDim, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                <Text style={{ color: colors.accent, fontSize: 12, fontWeight: '700' }}>{j + 1}</Text>
              </View>
              <Text style={[font.body, { flex: 1, lineHeight: 20 }]}>{step}</Text>
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}

/** One line per tab, as a plain list with hairlines (not a stack of cards). */
function TabLines() {
  return (
    <Card padded={false}>
      {TAB_ACTIONS.map((t, i) => {
        const nav = NAV.find((n) => n.tab === t.tab)!;
        return (
          <View key={t.tab} style={{ flexDirection: 'row', gap: space.md, padding: space.md, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border }}>
            <View style={{ width: 28, height: 28, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: colors.accent, fontSize: 14 }}>{nav.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={font.h3}>{`${nav.label}  `}<Text style={font.small}>{`key ${i + 1}`}</Text></Text>
              <Text style={[font.body, { lineHeight: 20 }]}>{t.line}</Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

export function HelpScreen({ focus, onBack, onOpenTab }: { focus?: string | null; onBack?: () => void; onOpenTab?: (t: Tab) => void }) {
  const focused = focus ? entryById(focus) : undefined;
  const { wide } = useLayout();
  return (
    <Page>
      <PageHeader title="Help" subtitle="What to do each day, and when something goes wrong" />

      {focused ? (
        <View style={{ marginBottom: space.md }}>
          <Heading title="From your Inbox card" />
          <View style={{ flexDirection: 'row' }}>
            <EntryRow e={focused} highlight onOpenTab={onOpenTab} />
          </View>
          {onBack ? (
            <View style={{ flexDirection: 'row', marginTop: space.sm }}>
              <Button title="Back to Inbox" small variant="ghost" onPress={onBack} />
            </View>
          ) : null}
        </View>
      ) : null}

      <MarketsBoard />

      <Heading title="Your routine" note="Ten minutes a day. The Inbox is the place to start." />
      <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.lg, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, width: '100%' }}>
          <Routine />
        </View>
        <View style={{ flex: 1, width: '100%' }}>
          <Text style={[font.h3, { marginBottom: space.sm }]} accessibilityRole="header">One line per tab</Text>
          <TabLines />
        </View>
      </View>

      <Heading title="When you see this, do this" note="Every message the app can show, and what to do about it." />
      {WHEN_YOU_SEE.map((g) => (
        <View key={g.id} style={{ marginBottom: space.lg }}>
          <Text style={[font.h3, { marginBottom: space.sm, color: colors.textSecondary }]}>{g.title}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {g.entries.map((e) => (
              <EntryRow key={e.id} e={e} onOpenTab={onOpenTab} />
            ))}
          </View>
        </View>
      ))}

      <Heading title="More detail, tab by tab" />
      <Manual icon="●" title="How this app works">
        <P>
          XAutoTrade runs rule-based trading bots on MetaTrader 5. A strategy is a set of entry and
          exit rules plus risk settings; starting it turns it into a bot that watches the market and
          trades on its own from then on. You can build strategies by hand, or ask the AI agents in
          the Agents tab to draft one for you.
        </P>
        <P>
          Whatever an agent proposes — a new strategy, a change, stopping or deleting one — is only a
          proposal. Nothing happens until you tap <Text style={{ color: colors.text }}>Approve</Text>{' '}
          on that card. Agents cannot change a strategy on their own. The system itself can do two things
          without asking: pause a bot, and close the positions the bots opened when the daily loss cap is
          hit. Each time, it tells you in the Inbox.
        </P>
        <Explain title="Demo, paper and live — what's the difference?">
          Paper mode simulates a market with no real broker connected — good for trying the app out.
          Connected to a real MT5 account, it can be a demo account (fake money, real market data) or
          a live account (real money). The account type shows as a badge in the sidebar / Settings.
          This app is built and tested as a demo platform — treat any live connection with care, and
          never assume past results predict future ones.
        </Explain>
        <Explain title="Keyboard shortcuts (desktop)">
          Press 1 through 8 to jump straight to a tab — the number is shown next to each item in the
          sidebar. Shortcuts are ignored while you're typing in a text field.
        </Explain>
      </Manual>

      <Manual icon="◧" shortcut={1} title="Dashboard">
        <P>
          Your account balance and equity, every bot's status, today's realised profit/loss and trade
          count, and every open position across all bots — with a one-tap close on each. A market
          status pill flags when a bot's market is closed, unavailable, or close-only, so you know why
          it isn't trading.
        </P>
        <Explain title="What does Stop all do?">
          The red <Text style={{ color: colors.text }}>Stop all bots</Text> button (sidebar and
          Dashboard) immediately stops every running bot and closes every position they opened, at
          market. It never touches a position you opened yourself in MT5. Use it any time you want
          everything to stand down at once.
        </Explain>
      </Manual>

      <Manual icon="✉" shortcut={2} title="Inbox">
        <P>
          The one place that holds everything that needs you: proposals from the agents, errors, losing
          streaks, stalled bots, and safety stops. Each card can be acted on once and then leaves the
          list. When it is empty, nothing needs you.
        </P>
      </Manual>

      <Manual icon="✓" shortcut={4} title="Testboard">
        <P>
          Which stage each strategy has reached. The stages and their pass marks arrive in the next
          version of the app; until then this tab is empty.
        </P>
      </Manual>

      <Manual icon="▤" shortcut={5} title="Journal">
        <P>
          Every trade any bot has taken: which bot, which market, buy or sell, lot size, when it
          opened and closed, entry and exit price (or the live price while still open), stop-loss,
          take-profit, and exactly how it closed — take-profit, stop-loss, a bot's own exit rule,
          manual, or Stop all.
        </P>
        <Explain title="How to filter and read it">
          Use Result to show only winners, only losers, breakeven or still-open trades — each chip
          shows its own count. Period, Side, Closed by, Bot and Symbol narrow it further, and Search
          matches a bot name, symbol or MT5 ticket. The KPI row (net P&amp;L, win rate, profit factor,
          average win/loss, best/worst) and the profit chart follow whatever filters are active. Tap
          any row for the full detail sheet, or use Export CSV to download the filtered list.
        </Explain>
      </Manual>

      <Manual icon="◈" shortcut={3} title="Strategies">
        <P>
          The list of strategies you've built, each backed by a market, a timeframe, entry/exit rules
          and risk settings. From here you can start a strategy as a live bot, stop it, run a
          backtest against recent history, open its full detail (trades, P&amp;L, market status), or
          delete it.
        </P>
        <Explain title="Two ways to create one">
          <Text style={{ color: colors.text }}>New strategy</Text> asks three plain-language questions
          — which market, an active or relaxed trading style, and how much to risk per trade — and
          works out the rest (stop-loss, take-profit, daily loss limit, max trades) for you. If you
          already know indicators and rule logic, use the full editor instead for complete control
          over every setting.
        </Explain>
        <Explain title="Always backtest before you trust a strategy">
          Backtest runs the strategy against recent broker candles (spread, slippage and commission
          included) and reports net profit, win rate, profit factor and drawdown. Treat anything under
          about 30 trades as weak evidence either way, and remember past results never guarantee
          future ones.
        </Explain>
      </Manual>

      <Manual icon="✦" shortcut={6} title="Agents">
        <P>
          Chat with five specialised AI agents: Strategist creates new strategies from a plain-English
          idea, Optimizer tunes an existing one, Strategy Doctor diagnoses problems and can stop or
          delete a strategy, Risk Guard only ever makes risk safer, and Critic argues against a
          proposal before you approve it. For one strategy, use its own chat on the Strategies tab: four
          buttons (Tune, Diagnose, Tighten risk, Critique) pick the right agent for you. Here you can
          pick an agent directly, or leave it on Auto and a small model picks one.
        </P>
        <Explain title="How proposals are checked">
          Before you ever see a proposed change, the server backtests it on an older time window the
          agent never saw, and a Critic agent reviews it. A change that does worse there is held back
          automatically. You still make the final call with Approve or Reject.
        </Explain>
        <Explain title="Talking instead of typing">
          Tap the mic button to ask by voice — it transcribes as you speak and sends automatically the
          moment you stop talking; tap it again to cancel. Turn on{' '}
          <Text style={{ color: colors.text }}>Read replies aloud</Text> to have every answer spoken
          back, and tap it again mid-reply to interrupt. Both need a browser that supports speech, so
          they only appear when yours does.
        </Explain>
        <Explain title="The Learning panel">
          Switch to Learning (inside this tab) to see the scoreboard of which agents' changes actually
          helped, promoted variants from auto-evolve, each agent's notebook of proven lessons, and the
          full history of approved changes and their outcomes.
        </Explain>
      </Manual>



      <Manual icon="◐" shortcut={7} title="Settings">
        <P>
          Your server connection and account details, and Log out. If a connection needs
          re-establishing, this is also where you reconnect or switch servers.
        </P>
      </Manual>

      <Divider />
      <Text style={[font.small, { textAlign: 'center', marginTop: space.sm }]}>
        Still stuck? Ask the Agents tab — "what does this app do" or "how do I use the journal" both
        work, spoken or typed.
      </Text>
    </Page>
  );
}
