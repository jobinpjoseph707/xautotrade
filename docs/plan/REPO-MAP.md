# Repo map

One line per source file, so a task knows who owns what. Generated from each file's first doc comment; edit the file's comment, not this list.
Shared files (one task at a time): `mobile/App.tsx`, `mobile/src/api.ts`, `types.ts`, `store.tsx`, `server/src/store.ts`, `server/src/engine/types.ts`, `server/src/api/routes.ts`, `server/src/live/runner.ts`, `server/src/index.ts`.


## `server/src/agents/`

- `agents.test.ts` — +3%
- `evaluate.ts` — Peak-to-trough drawdown in percent, measured on EQUITY samples (same rule as
- `lessonStore.ts` — Append-only, ordered history of lessons and the config changes they produced. */
- `lessons.test.ts` — Preset with the session/day/spread limits opened up, so each test controls them. */
- `lessons.ts` — Failure -> lesson handoff. Everything here is rule-based and deterministic:
- `paperRunner.ts` — Run one agent-week against the PAPER broker's simulated market. This never
- `propose.ts` — "Propose next config": one deliberate, explainable change per failed week,
- `rotation.ts` — STUB (piece 3 fills this in). Deliberately makes no change: it only logs
- `store.ts` — Append-only record store. A completed week's record is written exactly once;
- `types.ts` — Weekly agent-rotation types.
- `weekly.ts` — Manual weekly trigger:  npm run agents:weekly

## `server/src/api/`

- `api.test.ts` — 127.0.0.1:${(server.address() as AddressInfo).port}`;
- `chat.ts` — usage tracking is a bonus, never worth failin
- `inbox.ts` — Inbox: everything that needs the owner (task 1.4).
- `journal.ts` — Broker lookups per request: the MT5 bridge is serial, so details fill in over a few refreshes. */
- `levels.ts` — Level publishing routes.
- `markets.ts` — Is a symbol offered / tradable / open right now? Cached 30 s per symbol (the MT5 bridge is serial). */
- `routes.ts` — Everything the mobile rule builder needs to render its pickers. */
- `testboard.ts` — Testboard: gate stage and verdict per strategy (task 2.1).
- `tiers.ts` — Risk tiers and open-risk caps (task 2.2).

## `server/src/`

- `app.ts` — Builds the Express app without listening, so tests can start it on any port.

## `server/src/broker/`

- `metaapi.ts` — MetaApi cloud adapter.
- `mt5mcp.test.ts` — Tests the MT5-via-MCP adapter against a fake MCP server that returns
- `mt5mcp.ts` — MT5-via-MCP adapter — EXPERIMENTAL.
- `paper.ts` — Paper-trading broker.
- `types.ts` — Broker abstraction.

## `server/src/chat/`

- `actions.ts` — Parsing, validating and applying agent-proposed actions.
- `agents.ts` — The chat agents. Each is a role prompt plus a whitelist of the actions it may
- `backend.ts` — Anything that turns a prompt into text. The default runs the Claude Code CLI. */
- `chat.test.ts`
- `prompt.ts` — Just the bot fields an agent needs; keeps the prompt small. */
- `service.ts` — Hooks for the learning layer. All optional so the chat works without them. */
- `usage.test.ts` — A unique tag per run — the backing DB is a real (persistent) file shared

## `server/src/`

- `config.ts` — MetaApi API token. Leave unset (and MT5MCP_URL unset too) to run the whole

## `server/src/engine/`

- `backtest.ts` — Bar-by-bar backtester.
- `engine.test.ts` — ---------------------------------------------------------------------------
- `indicators.ts` — Vectorised technical indicators.
- `levels.test.ts` — Tests for the chart-level publisher consumed by XATLevels.mq5.
- `levels.ts` — HLINE/TREND/RECT: the original EA kinds (TREND rays to the right).
- `overlays.test.ts` — broker time (UTC+3)
- `overlays.ts` — Strategy overlays: everything a strategy takes into account, drawn on the
- `presets.ts` — Starter strategies for M5 scalping. These are working examples of the rule
- `risk.ts` — Money management and risk gating.
- `rules.ts` — Rule DSL evaluator.
- `synthetic.ts` — Deterministic synthetic candle generator.
- `types.ts` — Shared type definitions for the XAutoTrade strategy engine.

## `server/src/`

- `index.ts` — An API key is generated and persisted on first boot so the server is never

## `server/src/journal/`

- `journal.test.ts` — Shapes copied from the live log on 2026-09-23.
- `journal.ts` — Trade journal: one row per position a bot opened, assembled from

## `server/src/learning/`

- `critic.ts` — The critic: a fifth agent whose only job is to argue against a proposal.
- `demo.ts` — Closing events written by the live runner; each carries the position's profit. */
- `evolve.ts` — Auto-evolve: OFF by default, explicit opt-in per strategy.
- `lab.ts` — Broker-backed wrappers around the pure validation/scoring functions.
- `learning.test.ts` — --- signatures -------------------------------------------------------------
- `notebook.ts` — Agent notebooks: only PROVEN lessons, distilled from scored outcomes.
- `records.ts` — Tiny record store. The interface keeps the learning logic testable with an
- `scoring.ts` — Scores approved changes once enough time has passed: helped, hurt or
- `signature.ts` — Turn a change into stable "kinds of change" (signatures) so outcomes of
- `sqliteRecords.ts` — Rows of one kind ("change", "candidate") in a single table, JSON bodies. */
- `types.ts` — Learning layer types: outcome memory, validation, critic verdicts, scoring
- `validate.ts` — Out-of-sample validation and forward scoring. Pure: candles in, verdicts out.

## `server/src/live/`

- `daily.test.ts` — Market closed: last tick from Friday evening.
- `daily.ts` — Small pure helpers the live runner uses so the dashboard matches the broker:
- `manager.ts` — Owns the single broker connection and the set of running bots.
- `reconcile.test.ts` — still open
- `reconcile.ts` — Fills gaps in the trade log from the broker's own deal history.
- `runner.ts` — Live strategy runner.

## `server/src/`

- `store.ts` — SQLite persistence. Small, synchronous, zero-ops — the right shape for a

## `server/src/testkit/`

- `setup.ts` — Loaded with `--import` before every test file (see package.json "test").
- `testkit.test.ts` — T-0.2

## `server/src/youtube/`

- `extract.ts` — Rule-based strategy extraction from a transcript. Deterministic and
- `gate.ts` — The backtest gate. A Strategy becomes an EligibleStrategy only by passing
- `map.ts` — Map an extracted description onto the engine's Strategy schema, reusing the
- `pipeline.ts` — Transcript text -> candidate strategy, or a needs-review report with exact gaps. */
- `run.ts` — npm run strategy:youtube -- <url> [SYMBOL] [timeframe]
- `transcript.ts` — Transcript fetching. Uses caption text only (never video/audio scraping).
- `youtube.test.ts` — 2% of 2000 = 40 price units = 4000 points at point 0.01

## `mobile/src/`

- `api.ts` — Typed client for the XAutoTrade server, plus a self-healing WebSocket for

## `mobile/src/components/`

- `EquityChart.tsx` — Equity curve — a single series over time, so there is no legend: the title
- `OverlayChart.tsx` — Price with a strategy's price-scale indicators on top — the same lines the
- `ProposalChecks.tsx` — Unseen-data check and critic verdict, shown on a proposal card before Approve. */
- `SymbolPicker.tsx` — Symbol chooser bound to the broker's own instrument list.
- `ui.tsx` — Pins its content to the top of the nearest scrolling ancestor (CSS

## `mobile/src/`

- `confirm.ts` — Alert.alert() is a documented no-op on react-native-web (the browser
- `layout.ts` — Breakpoint flags. Wide = desktop web (sidebar shell, tables); otherwise phone layout. */

## `mobile/src/logic/`

- `nav.test.ts` — T-0.6
- `nav.ts` — Pure navigation data (no React Native imports) so it can be unit-tested. */

## `mobile/src/screens/`

- `ActivityScreen.tsx`
- `BacktestScreen.tsx` — Keep working against the latest saved version of this strategy — once a
- `BotDetailScreen.tsx` — Parses "YYYY-MM-DD" in local time; returns null for empty/unparseable input. */
- `ChatScreen.tsx` — "Microsoft Orla Online (Natural) - Irish (Ireland)" → "Microsoft Orla Online", for the chip. */
- `ConnectScreen.tsx` — Prefill whatever was saved. When a stored connection fails the app lands
- `DashboardScreen.tsx` — The comment tag the server puts on a bot's orders ("XAT:<last 8 of id>"). */
- `HelpScreen.tsx` — The user manual — every tab, what it's for, and how to use it. Static
- `InboxScreen.tsx` — Placeholder until task 1.4 replaces the Activity screen with the real Inbox. */
- `JournalScreen.tsx`
- `LearningPanel.tsx` — Scoreboard, notebooks, outcome history and auto-evolve controls. */
- `LevelsScreen.tsx` — Draws support and resistance lines onto the MetaTrader chart.
- `ProfileScreen.tsx` — Account/connection management, split out of Activity so logging in, logging
- `SimpleCreate.tsx` — Guided strategy creation.
- `StrategiesScreen.tsx`
- `StrategyEditor.tsx` — Header ---------------------------------------------------------- */}
- `StrategyOverlayPanel.tsx` — Pick a strategy and see everything it takes into account — the same picture
- `TestboardScreen.tsx` — Placeholder until task 2.1 adds the gate engine. */

## `mobile/src/`

- `store.tsx` — When `account` was last fetched (ms), for the "updated Xs ago" hint. */
- `theme.ts` — Design tokens.
- `types.ts` — Mirrors the server's engine types. Keep in sync with server/src/engine/types.ts. */
- `voice.ts` — Voice for the Agents chat — speak instead of typing, and optionally have

## `mobile/`

- `App.tsx` — A hand-rolled tab shell plus two full-screen routes (editor, backtest).
