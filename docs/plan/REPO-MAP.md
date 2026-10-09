# Repo map

One line per source file, so a task knows who owns what. Generated from each file's first doc comment; edit the file's comment, not this list.
Shared files (one task at a time): `mobile/App.tsx`, `mobile/src/api.ts`, `types.ts`, `store.tsx`, `server/src/store.ts`, `server/src/engine/types.ts`, `server/src/api/routes.ts`, `server/src/live/runner.ts`, `server/src/index.ts`.


## `e2e/tests/`

- `help.spec.ts` — HP-6
- `helpers.ts` — Collects console errors and uncaught page errors; call `.errors` at the end of a test.
- `inbox.spec.ts` — I-9
- `shell.spec.ts` — —
- `smoke.spec.ts` — T-0.7: app loads, every tab opens with keys 1-8, no console errors.
- `strategy-chat.spec.ts` — —

## `mobile/`

- `App.tsx` — A hand-rolled tab shell plus two full-screen routes (editor, backtest).

## `mobile/src/`

- `api.ts` — Typed client for the XAutoTrade server, plus a self-healing WebSocket for
- `confirm.ts` — Alert.alert() is a documented no-op on react-native-web (the browser
- `layout.ts` — Breakpoint flags. Wide = desktop web (sidebar shell, tables); otherwise phone layout.
- `store.tsx` — When `account` was last fetched (ms), for the "updated Xs ago" hint.
- `theme.ts` — Design tokens.
- `types.ts` — Mirrors the server's engine types. Keep in sync with server/src/engine/types.ts.
- `voice.ts` — Voice for the Agents chat — speak instead of typing, and optionally have

## `mobile/src/components/`

- `EquityChart.tsx` — Equity curve — a single series over time, so there is no legend: the title
- `OverlayChart.tsx` — Price with a strategy's price-scale indicators on top — the same lines the
- `ProposalChecks.tsx` — Unseen-data check and critic verdict, shown on a proposal card before Approve.
- `SymbolPicker.tsx` — Symbol chooser bound to the broker's own instrument list.
- `ui.tsx` — Pins its content to the top of the nearest scrolling ancestor (CSS

## `mobile/src/logic/`

- `help.test.ts` — HP-1
- `help.ts` — The text of the Help tab, as data, so a test can check that every message the app can show has an ac
- `inbox.test.ts` — —
- `inbox.ts` — Pure Inbox presentation rules (no React Native imports) so they can be unit-tested.
- `markets.test.ts` — MK-1
- `markets.ts` — "Which markets are trading right now?" for the Help tab.
- `nav.test.ts` — T-0.6
- `nav.ts` — Pure navigation data (no React Native imports) so it can be unit-tested.
- `strategyChat.test.ts` — —
- `strategyChat.ts` — Pure rules for the per-strategy chat sheet (no React Native imports) so they can be unit-tested.
- `totals.test.ts` — —
- `totals.ts` — Dashboard totals, kept out of the screen so they can be tested. Test strategies (`isTest`) never cou

## `mobile/src/screens/`

- `BacktestScreen.tsx` — —
- `BotDetailScreen.tsx` — Parses "YYYY-MM-DD" in local time; returns null for empty/unparseable input.
- `ChatScreen.tsx` — "Microsoft Orla Online (Natural) - Irish (Ireland)" → "Microsoft Orla Online", for the chip.
- `ConnectScreen.tsx` — —
- `DashboardScreen.tsx` — Normal waiting states, not problems: shown quietly, never as alerts.
- `HelpScreen.tsx` — Help: what to do each day, what to do when you see a message, one action line per tab, and then the
- `InboxScreen.tsx` — —
- `JournalScreen.tsx` — —
- `LearningPanel.tsx` — Scoreboard, notebooks, outcome history and auto-evolve controls.
- `LevelsScreen.tsx` — Draws support and resistance lines onto the MetaTrader chart.
- `ProfileScreen.tsx` — Account/connection management, split out of Activity so logging in, logging
- `SimpleCreate.tsx` — Guided strategy creation.
- `StrategiesScreen.tsx` — —
- `StrategyChatSheet.tsx` — A chat tied to one strategy: four buttons for the common questions, free text for the rest.
- `StrategyEditor.tsx` — —
- `StrategyOverlayPanel.tsx` — Pick a strategy and see everything it takes into account — the same picture
- `TestboardScreen.tsx` — Placeholder until task 2.1 adds the gate engine.

## `server/scripts/`

- `cleanup.ts` — Usage (from server/, with the server STOPPED):
- `key.ts` — Show or replace the API key the phone app must send.
- `rank.ts` — Usage (from server/, MT5 open and the bridge reachable):  npm run rank

## `server/src/`

- `app.ts` — Builds the Express app without listening, so tests can start it on any port.
- `config.ts` — MetaApi API token. Leave unset (and MT5MCP_URL unset too) to run the whole
- `index.ts` — No silent fake data: if no broker was chosen (a missing or misplaced .env), stop with a clear messag
- `security.ts` — Who may call the API from a web page. The phone app and tools like curl send no Origin header at all
- `store.ts` — SQLite persistence. Small, synchronous, zero-ops — the right shape for a

## `server/src/agents/`

- `agents.test.ts` — —
- `evaluate.ts` — Peak-to-trough drawdown in percent, measured on EQUITY samples (same rule as
- `lessonStore.ts` — Append-only, ordered history of lessons and the config changes they produced.
- `lessons.test.ts` — Preset with the session/day/spread limits opened up, so each test controls them.
- `lessons.ts` — Failure -> lesson handoff. Everything here is rule-based and deterministic:
- `paperRunner.ts` — Run one agent-week against the PAPER broker's simulated market. This never
- `propose.ts` — "Propose next config": one deliberate, explainable change per failed week,
- `rotation.ts` — STUB (piece 3 fills this in). Deliberately makes no change: it only logs
- `store.ts` — Append-only record store. A completed week's record is written exactly once;
- `types.ts` — Weekly agent-rotation types.
- `weekly.ts` — Manual weekly trigger:  npm run agents:weekly

## `server/src/api/`

- `api.test.ts` — T-0.5
- `chat.ts` — ---------------------------------------------------------------------------
- `inbox.ts` — Everything that needs the owner. Mounted under /api, so it inherits the API-key middleware.
- `journal.ts` — Broker lookups per request: the MT5 bridge is serial, so details fill in over a few refreshes.
- `levels.ts` — Level publishing routes.
- `markets.ts` — Is a symbol offered / tradable / open right now? Cached 30 s per symbol (the MT5 bridge is serial).
- `routes.ts` — Everything the mobile rule builder needs to render its pickers.
- `testboard.ts` — Testboard: gate stage and verdict per strategy (task 2.1).
- `tiers.ts` — Risk tiers and open-risk caps (task 2.2).

## `server/src/broker/`

- `metaapi.ts` — MetaApi cloud adapter.
- `mt5mcp.test.ts` — Tests the MT5-via-MCP adapter against a fake MCP server that returns
- `mt5mcp.ts` — MT5-via-MCP adapter — EXPERIMENTAL.
- `paper.ts` — Paper-trading broker.
- `types.ts` — Broker abstraction.

## `server/src/chat/`

- `actions.ts` — Parsing, validating and applying agent-proposed actions.
- `agents.ts` — The chat agents. Each is a role prompt plus a whitelist of the actions it may
- `backend.ts` — Anything that turns a prompt into text. The default runs the Claude Code CLI.
- `chat.test.ts` — —
- `prompt.ts` — Just the bot fields an agent needs; keeps the prompt small.
- `service.ts` — Hooks for the learning layer. All optional so the chat works without them.
- `usage.test.ts` — —

## `server/src/engine/`

- `backtest.ts` — Bar-by-bar backtester.
- `engine.test.ts` — Fixed end time (a Thursday, 18:00 UTC) so these tests do not depend on when they are run.
- `indicators.ts` — Vectorised technical indicators.
- `levels.test.ts` — Tests for the chart-level publisher consumed by XATLevels.mq5.
- `levels.ts` — HLINE/TREND/RECT: the original EA kinds (TREND rays to the right).
- `overlays.test.ts` — —
- `overlays.ts` — Strategy overlays: everything a strategy takes into account, drawn on the
- `presets.ts` — Starter strategies for M5 scalping. These are working examples of the rule
- `risk.ts` — Money management and risk gating.
- `rules.ts` — Rule DSL evaluator.
- `synthetic.ts` — Deterministic synthetic candle generator.
- `types.ts` — Shared type definitions for the XAutoTrade strategy engine.

## `server/src/inbox/`

- `feed.ts` — Consecutive losing closes before a "losing streak" card is raised.
- `inbox.test.ts` — I-1
- `inbox.ts` — Newest first.
- `instance.ts` — The one inbox for the running server. Handlers (what the buttons do) are set when the app starts.
- `proposals.ts` — Mirrors chat proposals into the Inbox: one card per proposal, closed by a decision made anywhere.
- `sqlite.ts` — Inbox cards in SQLite. The full card is a JSON body; status, key and time are columns so lists are c
- `types.ts` — The Inbox: the one place that holds everything that needs the owner.

## `server/src/journal/`

- `journal.test.ts` — Shapes copied from the live log on 2026-09-23.
- `journal.ts` — Trade journal: one row per position a bot opened, assembled from

## `server/src/learning/`

- `critic.ts` — The critic: a fifth agent whose only job is to argue against a proposal.
- `demo.ts` — Closing events written by the live runner; each carries the position's profit.
- `evolve.ts` — Auto-evolve: OFF by default, explicit opt-in per strategy.
- `lab.ts` — Broker-backed wrappers around the pure validation/scoring functions.
- `learning.test.ts` — --- signatures -------------------------------------------------------------
- `notebook.ts` — Agent notebooks: only PROVEN lessons, distilled from scored outcomes.
- `records.ts` — Tiny record store. The interface keeps the learning logic testable with an
- `scoring.ts` — Scores approved changes once enough time has passed: helped, hurt or
- `signature.ts` — Turn a change into stable "kinds of change" (signatures) so outcomes of
- `sqliteRecords.ts` — Rows of one kind ("change", "candidate") in a single table, JSON bodies.
- `types.ts` — Learning layer types: outcome memory, validation, critic verdicts, scoring
- `validate.ts` — Out-of-sample validation and forward scoring. Pure: candles in, verdicts out.

## `server/src/live/`

- `daily.test.ts` — —
- `daily.ts` — Small pure helpers the live runner uses so the dashboard matches the broker:
- `manager.test.ts` — A strategy that never trades, so the tests only watch start/stop.
- `manager.ts` — Owns the single broker connection and the set of running bots.
- `reconcile.test.ts` — —
- `reconcile.ts` — Fills gaps in the trade log from the broker's own deal history.
- `runner.test.ts` — First tests for the live runner. They pin today's behaviour so later changes show up.
- `runner.ts` — Live strategy runner.

## `server/src/safety/`

- `broker.test.ts` — B-1
- `killSwitch.ts` — The account-level loss cap. If equity falls 3% (default) below where the day started,
- `safety.test.ts` — A bot-opened position (comment "XAT:<id>") and one opened by hand (no comment).
- `stall.ts` — Stall watch: a running bot that has seen no new bar for three times its timeframe, while its market

## `server/src/scripts/`

- `cleanup.ts` — One-off clean-up of saved strategies (task 1.3). Pure logic: the store and the
- `rank.ts` — Ranks the saved strategies by backtest under the current rules (task 1.3), so
- `scripts.test.ts` — The strategies named in the open-issues list, plus two real ones.

## `server/src/testkit/`

- `index.ts` — Shared test helpers (not a test file). Everything a test needs to build a
- `setup.ts` — Loaded with `--import` before every test file (see package.json "test").
- `testkit.test.ts` — T-0.2

## `server/src/youtube/`

- `extract.ts` — Rule-based strategy extraction from a transcript. Deterministic and
- `gate.ts` — The backtest gate. A Strategy becomes an EligibleStrategy only by passing
- `map.ts` — Map an extracted description onto the engine's Strategy schema, reusing the
- `pipeline.ts` — Transcript text -> candidate strategy, or a needs-review report with exact gaps.
- `run.ts` — npm run strategy:youtube -- <url> [SYMBOL] [timeframe]
- `transcript.ts` — Transcript fetching. Uses caption text only (never video/audio scraping).
- `youtube.test.ts` — Fixed end time (a Tuesday, midday UTC) so these tests do not depend on when they are run.
