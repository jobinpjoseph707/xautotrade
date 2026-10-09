# XAutoTrade — Open Issues & Feature Requests

Tracked separately from the runbook (operational steps) and build notes
(architecture/decisions). Fixed items are kept here with their root cause,
since it's the kind of thing worth remembering if a similar symptom shows
up again.

## Added — 2026-09-24

### "Optimize test settings" on the Backtest screen — fills in real numbers, not agent-driven tuning

First pass at this misread the ask: an "Optimize" button was added that
called the Optimizer agent to propose a *strategy* parameter change
(risk/entry-exit tuning), approved inline via the existing proposal
flow. **User corrected this and it was reverted in full** —
`mobile/src/screens/BacktestScreen.tsx` went back to the original file (no
agent card, no `ChatProposal` rendering; `strategy` prop used directly).

What the user actually meant by "Optimize" on this screen: help fill in the
**Test settings** fields themselves (bars of history, starting balance,
spread override, commission per lot) with real facts instead of the user
having to guess numbers. So the screen has a small "⚡ Optimize test
settings" link in the Test settings card header. Tapping it:

- Calls `api.symbolSpec(strategy.symbol)` (existing endpoint,
  `GET /symbols/:symbol/spec` → `manager.broker.getSymbolSpec`) and fills
  **Spread override** and **Commission per lot** with the broker's real
  current numbers for that symbol — not a guess, not a placeholder 0.
- Fills **Starting balance** with the connected account's real balance
  (`account.balance`), when available.
- Computes **Bars of history** for roughly 30 days of data on the
  strategy's timeframe (clamped to the field's existing 200–20,000 range;
  a note says so explicitly if the 30-day target would have exceeded the
  cap, e.g. 1m strategies).
- Shows a one-line confirmation of exactly what it filled in and why.

No new server code — reuses the existing `/symbols/:symbol/spec` route and
the account info already loaded client-side.

### "Get a fix suggestion" — agent-driven strategy tuning, but only offered after a bad backtest result

Follow-up from the same screen: after seeing a real (negative) result from
"Optimize test settings" above, the user asked why the backtest wasn't
positive, and asked for a way to feed the current strategy config plus the
bad result back in and get it optimized — this is deliberately a *separate*
feature from "Optimize test settings" (which only sets simulation costs and
never touches the strategy), placed only where it's relevant: in the
Result section, and only once a backtest has actually run and come out
losing (`netProfit < 0 || profitFactor < 1`, with at least one trade).

Answer to "why is it negative": Optimize test settings intentionally does
not change anything about the strategy — it only fills in realistic spread/
commission/balance/history so the backtest reflects real trading costs
instead of the demo broker's unrealistically tight spread. A strategy
that only looks profitable at 0 spread and stops working once real costs
are applied is exactly what this is meant to reveal — that's the backtest
doing its job, not a bug. (For "M1 HFT EMA Scalp" specifically, this may
also be the known break-even/trailing-inside-spread issue already tracked
below under "Also worth checking on this strategy list" — worth checking
that strategy's stop config too.)

New "Not profitable under these settings" card appears in the Result
section whenever the just-run backtest lost money. "Get a fix suggestion"
sends the strategy's id/symbol/timeframe plus the exact numbers from *this*
run (bars, spread, commission, balance, trades, profit factor, net profit,
win rate, max drawdown) to the Optimizer agent via the existing
`api.chat({ agent: 'optimizer', ... })` — the agent already receives the
strategy's full current config in its prompt automatically
(`ChatService.chat()`'s `CURRENT STRATEGIES` block), so "give it the
current values" was already covered; this just also grounds it in the
specific bad result the user is looking at rather than a generic cached
backtest. The proposal renders inline (summary, reason, warnings, unseen-
data validation, critic verdict) with Approve/Reject, reusing the existing
proposal infrastructure exactly like the Agents tab — no new server code.
The screen tracks `activeStrategy` (re-derived from the live `strategies`
list) so approving and re-running "Run backtest" immediately tests the
new config.

Verified with a one-off Playwright script (8/8 passed): backtest a known-
losing fixture strategy → "Not profitable" card appears → "Get a fix
suggestion" → agent reply + proposal with Approve/Reject render → approve
→ "Run the backtest again" hint shown, no console errors. `tsc --noEmit`
clean on both packages, synced to the Windows machine and re-verified
clean there too.

The earlier "run backtest with different values / parameter sweep" ask is
still genuinely open — neither this nor "Optimize test settings" covers a
multi-value sweep. See "Pending decisions" below.

### Token/cost usage tracking for agent chat calls (server-side; mobile UI still pending)

User asked for something to "keep in mind the token usage" of agent chats,
since every Strategist/Optimizer/Doctor/Guard/Critic call spawns the
`claude` CLI and previously discarded its `usage`/`total_cost_usd` output
entirely.

Server side is done: `ClaudeCliBackend` (`server/src/chat/backend.ts`) takes
an optional `onUsage` callback and a new `parseCliUsage()` parses the CLI's
JSON output for `input_tokens`/`output_tokens`/cache token counts/
`total_cost_usd`/`duration_ms`. Every real call site (`chat/service.ts`,
`learning/critic.ts`, `learning/evolve.ts`) now passes a `tag` (the agent
id, or `'critic'`/`'evolve'`) through `CompleteOptions` so usage can be
broken down per agent later. `server/src/store.ts` gained a `chat_usage`
SQLite table and a `chatUsage` store object (`add`, `summary(sinceMs)`,
`prune`). `server/src/api/chat.ts` wires the backend's `onUsage` to persist
every call (best-effort — never breaks a chat reply if it fails) and
exposes `GET /api/chat/usage?period=today|7d|30d|all` returning
`{ period, calls, inputTokens, outputTokens, totalTokens, costUsd, byTag }`.

Test coverage: `parseCliUsage` parsing (`chat/chat.test.ts`) and the
`chatUsage` store's add/summary/group-by-tag behaviour
(`server/src/chat/usage.test.ts` — note: a same-name test file placed
directly under `server/src/` with no subdirectory is silently skipped by
`npm test`'s `tsx --test src/**/*.test.ts` glob under `sh -c`, since POSIX
`**` needs a real directory segment to expand into; keep new server test
files at least one directory deep, matching every existing test file).
`npm test` 172/172 passing, `tsc --noEmit` clean on both packages, synced to
the Windows machine and re-verified there.

**Not yet built:** the mobile UI to actually show this to the user (a
compact panel — likely in Settings/Profile — with a period toggle and
per-agent breakdown, using the new `GET /chat/usage` endpoint). Next
session should add a `ChatUsage` type + `api.usage()` method
(`mobile/src/api.ts`/`types.ts`) and a small panel, following the pattern
already scoped: `usage.ts`/`.tsx` naming, `Api` class method pattern at
`chatAgents`/`scoreboard`.

### Explained, not a bug: "Activity" shows fewer trades than "Journal"

User noticed Activity's "Trades 97" chip looked much smaller than Journal's
"202 trades" for the same 30-day period and asked why. Root cause (no code
change needed): Activity's subtitle ("last N events") is just the length of
the client's capped recent-events window (`mobile/src/store.tsx` loads the
most recent 120 log rows and keeps at most 400 live via the socket;
`GET /logs` on the server hard-caps at 1000). Its "Trades" chip counts
*log events* with `level:'trade'` in that small window — and every closed
trade produces **two** such rows (`entry` + `position_closed`/`exit`/
`panic_close`, `server/src/live/runner.ts`), so a ~120-row recent window
covers far fewer than 120 distinct trades. Journal's count comes from
`logs.tradesAll(from, to)` (`server/src/store.ts`), an unbounded SQL query
over the full selected period with no cap, then paired into one
`JournalTrade` per position. So the two numbers are answering different
questions (a small recent live-feed vs. every position in 30 days) and both
are correct for what they represent. Secondary note: the high-frequency "M1
Gold Quick Scalp (test)" strategy (fires roughly every 20 minutes) likely
crowds other bots' events out of Activity's small window, which is the same
test strategy flagged below as still needing a decision.

## Fixed — 2026-09-23

### Strategy Doctor silently skipped backtest evidence for plain-English performance questions

**Root cause:** `ChatService.chat()` (`server/src/chat/service.ts`) only runs
the (slow) `backtests()` hook when a regex `wantsBacktest` matches the raw
message text — the idea being agents shouldn't pay for a backtest pass on
every message. That regex only covered fairly narrow phrasing (`backtest`,
`optimi[sz]e`, `perform`, `profit`, `best`/`worst`, `remove`/`delete`/`clean`,
etc). A completely natural question like *"how many current strategies are
there? check it in details and see how theyre doing and why are they in
loss? how to make it a better scalping strategy?"* matched none of it, so
Strategy Doctor answered from saved config alone and said outright "No
backtest results were shared with me" — even though the message is exactly
the kind of performance question the hook exists for.

**Fix:** widened the `wantsBacktest` regex in `service.ts` to also catch
loss/losing/lose, improve*, working/broken, results/stats, win rate,
drawdown, edge, "how ... doing", and "why ... losing/loss/bad" phrasing.
Added a regression test (`chat.test.ts`, "backtest trigger recognises
loss/result phrasing, not just the word 'backtest'") pinning the exact
reported message to `ran === 1`. `npx tsc --noEmit` clean; existing
"backtest results reach the prompt only for performance questions and
non-Strategist agents" test still passes (plain "hello there" to Doctor
still does *not* trigger a backtest pass — the gate itself wasn't removed,
just widened). Full suite not re-run from this session (same known
esbuild win32/linux mismatch on the remote bridge noted below) — worth a
`npm test` confirmation next time you're at the machine, though `tsc` +
the targeted test file both passed clean.

An earlier idea (force `backtests()` to always run whenever the resolved
agent is doctor/optimizer/guard, regardless of message content, since all
three explicitly reason from backtest evidence per their role prompt) was
tried and reverted — it broke the existing test asserting a plain "hello
there" to Doctor should *not* trigger a backtest pass, and paying for a
backtest pass on every single message to those three agents (even a
greeting) seemed wasteful even with the 10-min cache. Widening the regex
was the more surgical fix; the always-on idea is worth revisiting only if
the regex keeps missing real phrasings.

### Logout / Stop-all-bots / other confirm-gated buttons "not working"

**Root cause:** `react-native-web`'s `Alert` module is a documented no-op —
`mobile/node_modules/react-native-web/src/exports/Alert/index.js` is
literally `class Alert { static alert() {} }`. Every confirm dialog and
every "Failed: ..." error popup in the app was built on `Alert.alert(...)`,
so on the web build (the `localhost:8081` browser preview J was testing
against) every one of those calls did nothing — no dialog appeared, and the
`onPress` handler carrying the actual action (log out, stop & close, delete
strategy, close position, clear chart levels, discard changes) never fired.
Native Expo Go on a phone was never affected — that's the real native
`Alert`.

**Fix:** added `mobile/src/confirm.ts` — `notify()` and `confirmAction()`
helpers that use the native `Alert.alert` on iOS/Android and fall back to
`window.alert` / `window.confirm` on web. Replaced every `Alert.alert(...)`
call site across `ProfileScreen`, `DashboardScreen`, `LevelsScreen`,
`SimpleCreate`, `StrategiesScreen`, and `StrategyEditor` with these. Both
packages typecheck clean (`npx tsc --noEmit`) after the change.

### Dashboard P&L / prices not real-time

**Root cause:** the dashboard's floating P&L and each open position's
current price came only from each bot's snapshot, which was only pushed
once per bar close (by design — signals must never evaluate a forming bar).
For anything above an M1 strategy, that's a frozen number for however long
the timeframe's bar interval is, even though the market (and the bot's real
floating P&L) kept moving the whole time.

**Fix:** added a separate, lightweight refresh loop in `BotManager`
(`startFloatingRefresh`, every 4s) that fetches current positions once and
applies them to every running bot's displayed `openPositions` via a new
`BotRunner.applyPositions()` method — purely a display refresh, it never
touches signals, indicators, or realised P&L accounting, so the actual
trading logic and backtest parity are untouched. Wired up at server start
in `index.ts` alongside `restoreAutostart()`. Also shortened the mobile
app's websocket-down polling fallback from 15s to 5s
(`mobile/src/store.tsx`) to match.

### Activity log — logout and bot-stop events

Added `POST /api/logs/client` on the server so client-only actions (right
now: logout) land in the same persistent activity feed as everything else;
`ProfileScreen`'s log-out flow calls it (best-effort) just before
disconnecting. Enriched `BotRunner.stop()`'s existing `bot_stop` log entry
to include the strategy name, how long it had been running
(`formatDuration`), and its P&L at the moment it was stopped — this single
change covers both the individual per-bot stop button and "stop all/panic"
(which calls the same `stop()` per bot), plus the individual `panic_close`
log lines already existed per-position with their own P&L. Also fixed two
places (`POST /panic`'s summary line, and `autostart_failed` in
`manager.ts`) that wrote to the log store directly without broadcasting
over the websocket, so open apps weren't seeing them live.

### Chat agents (Strategist / Optimizer / Strategy Doctor / Risk Guard)

Added a chat-based agent layer (`server/src/chat/*`, `server/src/api/chat.ts`,
mobile `ChatScreen` under the new "Agents" tab) so strategies can be created,
tuned, diagnosed, or removed conversationally instead of only through the
manual editor. Backend is `claude` (Claude Code CLI) run on the server's own
machine via `child_process.spawn`, chosen over an API key so it rides the
user's existing Claude Code login with no separate billing setup — the
tradeoff is that it depends on that CLI session staying logged in on the
laptop (`claude` in a terminal to re-auth if it expires; surfaces in the app
as a clear error when it has).

Every agent can only *propose* actions (`create_strategy`, `update_strategy`,
`delete_strategy`, `start_bot`, `stop_bot`) inside a fenced ` ```xat-actions `
JSON block in its reply — nothing is applied until the user taps Approve on
the card in the app. Proposals are validated server-side (indicator support,
strategy shape, `validateStrategy`) before ever reaching the user, and a
`gateViolation` check (reused from the existing weekly agent-rotation code)
blocks Risk Guard specifically from ever proposing a looser risk setting.
On approval, an update is re-merged onto the *current* saved version of the
strategy (not the version at proposal time), so an edit made in between isn't
silently clobbered.

Agents can request a **backtest pass** (`ChatService`'s `backtests()` hook)
when the user's message is about performance/cleanup — runs each strategy
against recent broker candles via the existing `runBacktest` engine (10-min
result cache per strategy, capped at 12 strategies per request, sequential
since the MT5 bridge handles one call at a time) and includes trades/win
rate/profit factor/drawdown in the prompt so recommendations are
evidence-based rather than just reading the saved config. Used already to
approve deleting 8 duplicate/test strategies (5x cloned "M5 EMA Pullback
Scalp", 3x cloned "New Strategy" EMA9/21 template, plus the ORDER TEST rig).
See the widened-trigger fix above — the original keyword list for this hook
missed a lot of natural phrasing.

41 new tests added (`server/src/chat/chat.test.ts`) covering: action
extraction/validation, agent routing, approve/reject/re-merge semantics,
Risk Guard's tighten-only enforcement, and CLI output parsing. Full suite
now 131 tests (130 + the 2026-09-23 backtest-trigger regression test).

## Design notes — planned but not yet built

Discussed 2026-09-22/23: extending the chat agents toward genuine
self-improvement rather than one-shot suggestions, and toward being able to
swap in a different model (Gemini, or a small decision-only model like
TypeSafe's Jev) as the "brain" behind an agent without touching agent
definitions, prompts, or the app. None of this is implemented yet — noted
here so the reasoning isn't lost.

- **Model-swappable backend already holds** — `ChatBackend` is a one-method
  interface (`complete(prompt): Promise<string>`); `ClaudeCliBackend` is the
  only implementation today. A Gemini backend is a second small class behind
  the same interface, no other code changes. Worth adding a `model` field to
  proposal/outcome records now (see below) even before a second backend
  exists, since it's cheap now and expensive to retrofit onto historical data.
- **Outcome memory (foundational — do this first).** Every *approved* change
  needs to be recorded with metadata: which agent + model proposed it, its
  stated reasoning, the strategy config before/after, and — critically —
  backtest/demo results measured *after* the change had time to run, not just
  at approval time. Nothing else below is possible without this existing.
- **Agent notebooks.** Each agent role gets a small persistent notes file,
  read at the start of every chat, holding only *proven* lessons distilled
  from outcome memory (e.g. "tightening stops on 1m gold scalps hurt 3 of 4
  times") — not raw history, which would bloat the prompt.
- **Out-of-sample validation before a proposal is ever shown.** The real risk
  in "self-improving" trading agents is overfitting to noise: a change that
  improves a backtest on the window the agent just saw usually does so by
  fitting recent randomness, not by finding a real edge. Before an agent's
  proposal reaches the user, backtest the new config on a time window the
  agent was never shown; only surface proposals that hold up there.
  Without this, the four features above amount to automated overfitting.
- **A fifth "critic" agent.** Reviews a proposal before it reaches the user
  and argues against it if warranted (too few trades to judge, changes too
  many parameters at once, repeats a documented past failure). Its verdict
  rides along with the proposal card rather than blocking it outright.
- **A scoreboard.** Surface, per agent (and later per model), what fraction
  of its approved proposals actually helped vs. hurt vs. inconclusive —
  otherwise there's no way to tell real improvement from mere activity.
- **What stays fixed, deliberately, regardless of the above:** risk limits,
  the live-trading flag, and the human-approval step are code, not something
  any agent can propose changing or bypass. Learning/self-improvement only
  ever runs against demo/backtest data — this is a hard line, not a
  configurable default.
- Explicitly **out of scope for now**: connecting a second model. The
  interface is being kept ready for it, but there is no present need at
  current usage volume (a handful of chat messages a day) to justify the
  added dependency — noted per the user's own framing of "not looking into
  that now."

## Open / not yet verified

- ~~Full `npm test` run could not be completed from this session's remote
  bridge...~~ **Resolved 2026-09-23**: user ran `npm test` directly on the
  Windows machine (`server` folder) — 130/130 passing, 0 failed. The
  Linux-bridge esbuild mismatch noted earlier only ever affected running
  tests *from this remote session*; it was never a real bug in the app, and
  future sessions should ask the user to run `npm test` on their own machine
  to confirm rather than relying on `tsc --noEmit` alone, exactly as was
  done here.
- The backtest-trigger widening above (same session, later) was only
  verified via `tsc --noEmit` and `npx tsx --test src/chat/chat.test.ts` run
  through the remote device bridge (hits the same known esbuild win32/linux
  mismatch as `npm test` proper when run that way — worked around by
  invoking `tsx --test` directly against the one file). Worth a plain
  `npm test` on the Windows machine next time to fold this into the 131-test
  confirmed count.

## Pending decisions / not yet built

- **What to do about "M1 Gold Quick Scalp (test)" polluting aggregate
  totals.** Confirmed 2026-09-24 (again) that it's a plain hardcoded preset
  in `server/src/engine/presets.ts` — `(test)` is only a display-name
  string, there is no `isTest` flag or exclusion anywhere, so its trades
  count in every dashboard/journal aggregate exactly like a real strategy.
  Also confirmed to be the likely cause of it crowding out other bots from
  Activity's small recent-events window (see above). Three options were
  offered to the user (add a real `isTest` flag + exclude from aggregates /
  stop and delete it manually / leave as-is) and the user has not chosen
  one yet — do not assume this is resolved.
- **Token usage mobile UI** — see "Added — 2026-09-24" above. Server side
  and `GET /chat/usage` are done; the Settings/Profile panel to show it is
  not built yet.
- **Backtest parameter sweep ("run backtest with different values")** —
  still genuinely open. Neither "Optimize test settings" nor "Get a fix
  suggestion" (both added 2026-09-24) sweeps a strategy's risk parameters
  across multiple values and compares results — one fills in realistic
  single-run simulation costs, the other asks the agent for one suggested
  change when a result is bad. A true sweep is a separate, not-yet-started
  feature (a `POST /api/backtest/sweep`-style endpoint that fetches candles
  once and loops the existing synchronous `runBacktest()` over parameter
  combinations, plus a comparison-table UI).
- **M1 HFT EMA Scalp's stop config** — worth checking whether its known
  break-even/trailing-inside-spread issue (see "Also worth checking on
  this strategy list" below) explains why a realistic-settings backtest on
  it came out negative on 2026-09-24.

## Also worth checking on this strategy list

From the same session's Strategy Doctor pass (screenshot, not yet
actioned): **M1 Gold Quick Scalp #1 and #2** (`fg8207hm`, `oouli9cz`) are
exact duplicates that both actually trade EURUSD despite the "Gold" name,
re-enter on every bar the EMAs line up rather than on a fresh cross, and
have take-profit (0.8×ATR) smaller than stop-loss (1×ATR) with a 50-point
spread cap that's far too loose for EURUSD — likely candidates for
deleting one and fixing the other. **M1 HFT EMA Scalp (XAUUSD)** caused an
`INVALID_STOPS` broker error: break-even at 20 points / trailing at 30
points is inside gold's own ~35-point spread, so the broker rejects the
stop-move outright — needs those distances widened past the spread before
it can trade at all. Neither fix has been applied yet; revisit once the
widened backtest trigger has had a chance to gather real evidence on all
three.
