import React from 'react';
import { Text, View } from 'react-native';

import { Button, Card, Divider, Explain, Page, PageHeader, SectionTitle } from '../components/ui';
import { ROUTINE, TAB_ACTIONS, WHEN_YOU_SEE, entryById, type HelpEntry } from '../logic/help';
import { NAV, type Tab } from '../logic/nav';
import { colors, font, space } from '../theme';

/**
 * Help: what to do each day, what to do when you see a message, one action line per tab, and then the
 * longer explanation of each tab. The first three come from logic/help.ts (so a test can check them);
 * static content, no API calls, so it works even before you've connected.
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

function EntryCard({ e, highlight, onOpenTab }: { e: HelpEntry; highlight?: boolean; onOpenTab?: (t: Tab) => void }) {
  return (
    <Card style={[{ marginBottom: space.sm }, highlight ? { borderColor: colors.accent, borderWidth: 1 } : null]}>
      <Text style={[font.label, { marginBottom: 2 }]}>YOU SEE</Text>
      <Text style={[font.h3, { marginBottom: space.sm }]}>{e.see}</Text>
      <Text style={[font.label, { marginBottom: 2 }]}>WHAT IT MEANS</Text>
      <P>{e.means}</P>
      <Text style={[font.label, { marginBottom: 2 }]}>WHAT TO DO</Text>
      <Text style={[font.body, { color: colors.text, lineHeight: 20 }]}>{e.do}</Text>
      {e.open && onOpenTab ? (
        <View style={{ flexDirection: 'row', marginTop: space.sm }}>
          <Button title={e.open.label} small variant="secondary" onPress={() => onOpenTab(e.open!.tab)} />
        </View>
      ) : null}
    </Card>
  );
}

export function HelpScreen({ focus, onBack, onOpenTab }: { focus?: string | null; onBack?: () => void; onOpenTab?: (t: Tab) => void }) {
  const focused = focus ? entryById(focus) : undefined;
  return (
    <Page>
      <PageHeader title="Help" subtitle="What to do each day, and when something goes wrong" />

      {focused ? (
        <View style={{ marginBottom: space.md }}>
          <SectionTitle>From your Inbox card</SectionTitle>
          <EntryCard e={focused} highlight onOpenTab={onOpenTab} />
          {onBack ? (
            <View style={{ flexDirection: 'row' }}>
              <Button title="Back to Inbox" small variant="ghost" onPress={onBack} />
            </View>
          ) : null}
        </View>
      ) : null}

      <SectionTitle>Your routine</SectionTitle>
      <Card style={{ marginBottom: space.md }}>
        {ROUTINE.map((r, i) => (
          <View key={r.title} style={{ marginBottom: i < ROUTINE.length - 1 ? space.md : 0 }}>
            <Text style={[font.h3, { marginBottom: space.xs }]}>{r.title}</Text>
            {r.steps.map((step, j) => (
              <Text key={j} style={[font.body, { lineHeight: 20, marginBottom: 2 }]}>
                {`${j + 1}. ${step}`}
              </Text>
            ))}
          </View>
        ))}
      </Card>

      <SectionTitle>When you see this, do this</SectionTitle>
      {WHEN_YOU_SEE.map((g) => (
        <View key={g.id} style={{ marginBottom: space.md }}>
          <Text style={[font.h3, { marginBottom: space.sm }]}>{g.title}</Text>
          {g.entries.map((e) => (
            <EntryCard key={e.id} e={e} onOpenTab={onOpenTab} />
          ))}
        </View>
      ))}

      <SectionTitle>One line per tab</SectionTitle>
      <Card style={{ marginBottom: space.md }}>
        {TAB_ACTIONS.map((t, i) => {
          const nav = NAV.find((n) => n.tab === t.tab)!;
          return (
            <View key={t.tab} style={{ flexDirection: 'row', gap: space.sm, paddingVertical: space.xs }}>
              <Text style={[font.h3, { width: 96 }]}>{nav.label}</Text>
              <Text style={[font.small, { width: 22 }]}>{i + 1}</Text>
              <Text style={[font.body, { flex: 1, lineHeight: 20 }]}>{t.line}</Text>
            </View>
          );
        })}
      </Card>

      <SectionTitle>More detail, tab by tab</SectionTitle>
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
