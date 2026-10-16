# Repo map

One line per source file, so a task knows who owns what. Generated from each file's first doc comment; edit the file's comment, not this list.
Shared files (one task at a time): `mobile/App.tsx`, `mobile/src/api.ts`, `types.ts`, `store.tsx`, `server/src/store.ts`, `server/src/engine/types.ts`, `server/src/api/routes.ts`, `server/src/live/runner.ts`, `server/src/index.ts`.


## `agents-py/agents_py/`

- `app.py` — The service's HTTP face: start a run, read a run. Nothing else.
- `client.py` — How the service talks to the trading server. The server's agent key opens exactly five routes, so
- `config.py` — —
- `engine.py` — Runs the graph for one request and reads saved runs back.
- `errors.py` — Why a run stops early. Each one maps to a run outcome the app understands.
- `graph.py` — The graph:
- `model.py` — One run's model calls: counted, capped, and parsed as JSON.
- `nodes.py` — The agents as graph steps. Each step reads the shared state, adds what it found, and passes it on.
- `prompts.py` — What each agent is told. Short on purpose: the numbers come from the dossier, never from memory.
- `risk.py` — The Risk Guard's check. It mirrors the server's own `gateViolation` (server/src/learning/propose.ts),
- `state.py` — —

## `agents-py/tests/`

- `conftest.py` — —
- `fakes.py` — A fake trading server and a scripted model, so every test runs with no network and no Claude.
- `test_app.py` — The service's HTTP face.
- `test_graph.py` — The agent graph, with a scripted model and a fake server (no network, no Claude).

## `e2e/tests/`

- `chat-sessions.spec.ts` — Previous chats: list, open, New chat, and per-strategy scope (CS-E1, CS-E2).
- `help.spec.ts` — HP-6
- `helpers.ts` — Collects console errors and uncaught page errors; call `.errors` at the end of a test.
- `ideas.spec.ts` — —
- `inbox.spec.ts` — I-9
- `shell.spec.ts` — —
- `smoke.spec.ts` — T-0.7: app loads, every tab opens with keys 1-8, no console errors.
- `strategy-chat.spec.ts` — —
- `testboard.spec.ts` — —
- `tiers.spec.ts` — —
- `usage.spec.ts` — —
- `youtube.spec.ts` — YT-6 (the transcript fetch needs the internet, so the end to end flow is covered by the server tests

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

- `agentRuns.test.ts` — —
- `agentRuns.ts` — Pure rules for agent runs in the strategy chat (no React Native imports) so they can be unit-tested.
- `chatSessions.test.ts` — Grouping, IST midnight and proposal patching (CS-M1 to CS-M4).
- `chatSessions.ts` — Groups saved chats by IST day and builds the labels the Previous chats list shows.
- `help.test.ts` — HP-1
- `help.ts` — The text of the Help tab, as data, so a test can check that every message the app can show has an ac
- `inbox.test.ts` — —
- `inbox.ts` — Pure Inbox presentation rules (no React Native imports) so they can be unit-tested.
- `knowledge.test.ts` — —
- `knowledge.ts` — Pure rules for the Ideas sheet (no React Native imports) so they can be unit-tested.
- `legacyLessons.test.ts` — —
- `legacyLessons.ts` — Pure presentation rules for lessons carried over from the old weekly rotation (no React Native imports).
- `markets.test.ts` — MK-1
- `markets.ts` — "Which markets are trading right now?" for the Help tab.
- `nav.test.ts` — T-0.6
- `nav.ts` — Pure navigation data (no React Native imports) so it can be unit-tested.
- `notebook.test.ts` — —
- `notebook.ts` — —
- `strategyChat.test.ts` — —
- `strategyChat.ts` — Pure rules for the per-strategy chat sheet (no React Native imports) so they can be unit-tested.
- `testboard.test.ts` — —
- `testboard.ts` — Pure Testboard presentation rules (no React Native imports) so they can be unit-tested.
- `tiers.test.ts` — —
- `tiers.ts` — Pure risk-tier presentation rules (no React Native imports) so they can be unit-tested.
- `time.test.ts` — TM-1
- `time.ts` — Every time the app shows is shown in Indian Standard Time (IST, UTC+5:30, no daylight saving), whatever the computer's own clock says.
- `totals.test.ts` — —
- `totals.ts` — Dashboard totals, kept out of the screen so they can be tested. Test strategies (`isTest`) never cou
- `usage.test.ts` — —
- `usage.ts` — Pure token-usage presentation rules (no React Native imports) so they can be unit-tested.
- `youtube.test.ts` — —
- `youtube.ts` — The one line under a result: what was tested and how it did. Describes past data only.

## `mobile/src/screens/`

- `AgentRunPanel.tsx` — —
- `BacktestScreen.tsx` — —
- `BotDetailScreen.tsx` — Parses "YYYY-MM-DD" in local time; returns null for empty/unparseable input.
- `ChatHistorySheet.tsx` — "Previous chats": saved conversations grouped by day; open, delete, or start a new chat.
- `ChatScreen.tsx` — "Microsoft Orla Online (Natural) - Irish (Ireland)" → "Microsoft Orla Online", for the chip.
- `ConnectScreen.tsx` — —
- `DashboardScreen.tsx` — Normal waiting states, not problems: shown quietly, never as alerts.
- `HelpScreen.tsx` — Help: what to do each day, what to do when you see a message, one action line per tab, and then the
- `InboxScreen.tsx` — —
- `JournalScreen.tsx` — —
- `KnowledgeSheet.tsx` — —
- `LearningPanel.tsx` — Scoreboard, notebooks, outcome history and auto-evolve controls.
- `LevelsScreen.tsx` — Draws support and resistance lines onto the MetaTrader chart.
- `ProfileScreen.tsx` — Account/connection management, split out of Activity so logging in, logging
- `SimpleCreate.tsx` — Guided strategy creation.
- `StrategiesScreen.tsx` — —
- `StrategyChatSheet.tsx` — A chat tied to one strategy: four buttons for the common questions, free text for the rest.
- `StrategyEditor.tsx` — —
- `StrategyOverlayPanel.tsx` — Pick a strategy and see everything it takes into account — the same picture
- `TestboardScreen.tsx` — Placeholder until task 2.1 adds the gate engine.
- `YoutubeSheet.tsx` — Strategies > From YouTube. Paste a video link: the server reads its captions, builds a strategy only
- `useChatSession.ts` — One saved chat per screen: loads the latest, creates on first send, new chat, open, delete.

## `server/scripts/`

- `cleanup.ts` — Usage (from server/, with the server STOPPED):
- `key.ts` — Show or replace the API key the phone app must send.
- `rank.ts` — Usage (from server/, MT5 open and the bridge reachable):  npm run rank
- `salvage.ts` — Usage (from server/, with the server STOPPED):

## `server/src/`

- `app.ts` — Builds the Express app without listening, so tests can start it on any port.
- `config.ts` — MetaApi API token. Leave unset (and MT5MCP_URL unset too) to run the whole
- `index.ts` — No silent fake data: if no broker was chosen (a missing or misplaced .env), stop with a clear messag
- `security.ts` — Who may call the API from a web page. The phone app and tools like curl send no Origin header at all
- `store.ts` — SQLite persistence. Small, synchronous, zero-ops — the right shape for a

## `server/src/agent/`

- `agent.test.ts` — The server side of the agent service: dossier, the five routes, runs, the weekly cycle.
- `auth.ts` — Two keys. The owner's key opens everything. The agent service has its own key that opens exactly
- `dossier.ts` — The dossier: everything the agents may know about ONE strategy, built by the server from data it
- `routes.ts` — The five routes the agent service may call, and the owner's routes for starting and reading runs.
- `runner.ts` — Starts and tracks runs of the agent service. The service does the talking between agents; this
- `types.ts` — —
- `weekly.ts` — The weekly research cycle: once a week, one run on each strategy that is failing its gate, at most 3.

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

- `agent.ts` — Wires the agent service to the running server: the five /api/agent routes (reached with the agent
- `api.test.ts` — T-0.5
- `chat.ts` — ---------------------------------------------------------------------------
- `inbox.ts` — Everything that needs the owner. Mounted under /api, so it inherits the API-key middleware.
- `journal.ts` — Broker lookups per request: the MT5 bridge is serial, so details fill in over a few refreshes.
- `knowledge.test.ts` — —
- `knowledge.ts` — —
- `levels.ts` — Level publishing routes.
- `markets.ts` — Is a symbol offered / tradable / open right now? Cached 30 s per symbol (the MT5 bridge is serial).
- `routes.ts` — Everything the mobile rule builder needs to render its pickers.
- `testboard.ts` — Testboard: gate stage and verdict per strategy (task 2.1).
- `tiers.ts` — Risk tiers and open-risk caps (task 2.2).
- `youtube.test.ts` — The router is wired exactly as in production, except the broker is a stub that serves fixed candles
- `youtube.ts` — Strategies from YouTube videos. Mounted under /api/youtube, so it inherits the API-key middleware.

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
- `sessions.test.ts` — Saved chats (CS-1 to CS-8).
- `sessions.ts` — Saved chats in SQLite: create, list by scope, append, history for the agent, rename, delete.
- `usage.test.ts` — —
- `usage.ts` — Token use, grouped the two ways the Settings panel shows it: by UTC day and by agent.

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

## `server/src/knowledge/`

- `books.ts` — Book notes. You paste a chapter you own; the server keeps a few SHORT concept notes with the page
- `competition.ts` — Competition methods: typed in by hand. The ENTRY idea is kept; how the winner sized positions is
- `graph.ts` — A small graph of ideas in two ordinary SQLite tables (no graph database).
- `ideas.ts` — Ideas from outside (a video, a competition) and how they are described in prompts.
- `instance.ts` — —
- `knowledge.test.ts` — The knowledge layer. Test IDs K-1 to K-8 are from docs/plan/xautotrade-test-plan.md.

## `server/src/learning/`

- `critic.ts` — The critic: a fifth agent whose only job is to argue against a proposal.
- `demo.ts` — Closing events written by the live runner; each carries the position's profit.
- `diagnose.test.ts` — —
- `diagnose.ts` — Finding why a strategy lost. Everything here is rule-based and deterministic:
- `evolve.ts` — Auto-evolve: OFF by default, explicit opt-in per strategy.
- `hypothesis.ts` — A theory: why a strategy is failing, the ONE change that follows from it, and the result on bars
- `lab.ts` — Broker-backed wrappers around the pure validation/scoring functions.
- `learning.test.ts` — --- signatures -------------------------------------------------------------
- `ledger.test.ts` — The lesson ledger: what counts as evidence, when a lesson is trusted, and what an agent may see.
- `ledger.ts` — Lesson ledger: lessons keyed by agent + symbol + timeframe + market state, trust rules, holds.
- `legacy.ts` — Lessons written by the old weekly rotation (data/lessons.json) are carried into the database once.
- `oneSystem.test.ts` — —
- `outcomeNote.ts` — The one sentence on how a change turned out. It is written from the scored numbers, after scoring:
- `panel.ts` — Learning-panel notebooks built from the ledger.
- `propose.ts` — "Propose next config": one deliberate, explainable change per failed week,
- `records.ts` — Tiny record store. The interface keeps the learning logic testable with an
- `retrieve.ts` — What an agent may see: its own trusted lessons for exactly its market, ≤10 rows.
- `scoring.ts` — Scores approved changes once enough time has passed: helped, hurt or
- `signature.ts` — Turn a change into stable "kinds of change" (signatures) so outcomes of
- `sqliteRecords.ts` — Rows of one kind ("change", "candidate") in a single table, JSON bodies.
- `stats.test.ts` — —
- `stats.ts` — Beta win-rate interval and seeded bootstrap.
- `trials.test.ts` — Theory and test (task 3.3). Test IDs P-1 to P-4, P-8 and P-9 are from docs/plan/xautotrade-test-plan.md.
- `trials.ts` — The test every theory must survive before it can become a proposal.
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
- `serverClock.test.ts` — CK-1
- `serverClock.ts` — The broker's clock, learned only from prices that move; a stopped price may not set the offset.

## `server/src/safety/`

- `broker.test.ts` — B-1
- `killSwitch.ts` — The account-level loss cap. If equity falls 3% (default) below where the day started,
- `safety.test.ts` — A bot-opened position (comment "XAT:<id>") and one opened by hand (no comment).
- `stall.ts` — Stall watch: a running bot that has seen no new bar for three times its timeframe, while its market

## `server/src/scripts/`

- `cleanup.ts` — One-off clean-up of saved strategies (task 1.3). Pure logic: the store and the
- `dbcheck.ts` — Is the database file healthy? Pure: takes an open connection, returns null when healthy or a plain-E
- `rank.ts` — Ranks the saved strategies by backtest under the current rules (task 1.3), so
- `riskCases.ts` — Writes agents-py/tests/fixtures/risk_cases.json: risk changes and whether the server's own check
- `salvage.test.ts` — A database like the app's: a few strategies early in the file, then a big logs table.
- `salvage.ts` — Copy what can still be read out of a damaged database into a fresh one. Never changes the damaged fi
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
