# XAutoTrade — architecture, technology and build

Written 8 October 2026 from the code on `main` (one commit, 2 October 2026). It goes with `PLAN-3-PHASES.md` and `TEST-PLAN.md`. Each section says what exists **today** and what the plan **adds**.

---

## 1. What the system is

A phone and browser app that controls a trading server on your Windows machine. The server keeps the strategies, runs backtests, and places orders on a MetaTrader 5 demo account. AI agents suggest changes to strategies; nothing they suggest is applied until you approve it.

```
 Phone / browser                Your Windows machine
┌──────────────────┐   HTTP    ┌──────────────────────────────────────────┐
│ mobile/          │  /api/*   │ server/  (Node + TypeScript)             │
│ Expo app         │◄─────────►│                                          │
│ (also runs as a  │ WebSocket │  api ── chat ── learning                 │
│  web page)       │   /ws     │   │       │        │                     │
└──────────────────┘           │  live ── engine ── store (SQLite file)   │
        ▲                      │   │                                      │
        │ Tailscale            │  broker ──► MT5 bridge (Python, stdio)   │
        │ (private network)    │                 │                        │
        └──────────────────────│  chat backend ──┼─► claude CLI           │
                               └─────────────────┼────────────────────────┘
                                                 ▼
                                      MetaTrader 5 terminal ──► broker (demo)
```

Three things run on the Windows machine: the Node server, the MT5 terminal, and the Python bridge that the server starts by itself. The phone only talks to the Node server.

---

## 2. Technology

### Server (`server/package.json`)

| Part | Technology | Version in the repo | Used for |
|---|---|---|---|
| Language | TypeScript, ES modules | ^5.7.2 | Everything |
| Runtime | Node.js | types for 22 | |
| Run and test | tsx | ^4.19.2 | `npm run dev`, `npm test` |
| HTTP | Express | ^4.21.2 | REST API under `/api` |
| Live feed | ws | ^8.18.0 | Pushes bot status and log lines on `/ws` |
| Database | better-sqlite3 | ^11.7.0 | One file, `xautotrade.db`, WAL mode |
| MT5 link | @modelcontextprotocol/sdk | ^1.30.0 | Talks to the Python bridge |
| Config | dotenv | ^16.4.7 | `server/.env` |
| Other | cors ^2.8.5, youtube-transcript ^1.2.1, metaapi.cloud-sdk ^27.0.3 | | The MetaApi adapter is still in the code but is not the path you use |

### App (`mobile/package.json`)

| Part | Technology | Version in the repo |
|---|---|---|
| Framework | Expo | ~57.0.24 |
| UI | React Native 0.86.3, React 19.2.3 | |
| Web build | react-native-web | ^0.21.0 |
| Charts | react-native-svg | 15.15.4 |
| Local settings | @react-native-async-storage/async-storage | 2.2.0 |
| Language | TypeScript | ~6.0.3 |

No navigation library: the tab shell is written by hand in `mobile/App.tsx`.

### Outside the repo

| Part | What it is |
|---|---|
| MetaTrader 5 terminal | Must be open and logged in to the demo account. Windows only. |
| MT5 bridge | Python package `mcp-metatrader5-server`, started by the server with `uvx --from mcp-metatrader5-server mt5mcp`. Needs `uv` installed. |
| Agent brain | The `claude` command-line tool, logged in on the server machine. The server calls it through one small interface, `ChatBackend.complete(prompt, { model })`. |
| Remote access | Tailscale, so the phone reaches the server away from home (`TAILSCALE.md`). |

### What the plan adds

| Phase | New dependency | Where |
|---|---|---|
| 1 | Playwright (dev only) | new `e2e/` folder |
| 1 | tsx (dev only) | `mobile/`, to run logic tests |
| 1–2 | **Nothing on the server.** Inbox, gates, tiers, safety and digest use Express and SQLite, which are already there. | |
| 3 | `sqlite-vec`, only when the news feature is built | server |

No agent framework and no second database are added.

---

## 3. Server layout

### Today (`server/src/`)

| Folder | Main files | Job |
|---|---|---|
| `engine/` | `types.ts`, `rules.ts`, `indicators.ts`, `risk.ts`, `backtest.ts`, `presets.ts`, `synthetic.ts`, `levels.ts`, `overlays.ts` | Strategy format, rule evaluation, indicators, position sizing and stops, the backtester. Pure code: no network, no clock. |
| `broker/` | `types.ts`, `mt5mcp.ts`, `paper.ts`, `metaapi.ts` | One `Broker` interface, three implementations. `paper.ts` uses made-up candles. |
| `live/` | `runner.ts`, `manager.ts`, `daily.ts`, `reconcile.ts` | One `BotRunner` per strategy; `BotManager` owns the broker connection and all runners. |
| `chat/` | `agents.ts`, `prompt.ts`, `service.ts`, `actions.ts`, `backend.ts` | The five agents, prompt building, proposals and approval, the Claude CLI call. |
| `learning/` | `validate.ts`, `lab.ts`, `critic.ts`, `scoring.ts`, `notebook.ts`, `evolve.ts`, `signature.ts`, `records.ts`, `sqliteRecords.ts` | Unseen-data check, critic, outcome scoring, lessons, auto-evolve. |
| `agents/` | `propose.ts`, `rotation.ts`, `weekly.ts`, `lessons.ts`, `lessonStore.ts`, `evaluate.ts`, `paperRunner.ts` | An older weekly loop, run by hand. Overlaps with `learning/`. |
| `youtube/` | `transcript.ts`, `extract.ts`, `map.ts`, `gate.ts`, `pipeline.ts`, `run.ts` | Turns a video transcript into a strategy by text rules. |
| `journal/` | | Trade journal built from the log. |
| `api/` | `routes.ts`, `chat.ts`, `journal.ts`, `levels.ts`, `markets.ts` | HTTP endpoints. |
| top level | `index.ts`, `config.ts`, `store.ts` | Start-up, settings from `.env`, all SQLite access. |

### After the plan

| Folder | Phase | Job |
|---|---|---|
| `testkit/` | 1 | Shared fakes for tests (not shipped behaviour). |
| `app.ts` | 1 | Builds the Express app without listening, so the API can be tested. `index.ts` only listens. |
| `inbox/` | 1 | Items that need you; replaces the Activity screen's role. |
| `safety/` | 1–2 | Account kill switch, heartbeat and restart rule, stall watch, and `applySafetyMove`. |
| `scripts/` | 1 | Cleanup and ranking logic (testable); thin runners in `server/scripts/`. |
| `gates/` | 2 | Evaluates each strategy's stage and records every pass and fail. |
| `broker/paperReplay.ts` | 2 | Replays real recent candles through the live runner. |
| `portfolio/` | 2 | Tiers, open-risk caps, correlation. |
| `digest/` | 2 | Weekly summary. |
| `learning/ledger.ts`, `retrieve.ts`, `hypothesis.ts`, `trials.ts`, `stats.ts`, `trace.ts` | 3 | The new learning loop. |
| `knowledge/` | 3 | Idea graph in SQLite. |
| removed | 3 | `agents/weekly.ts`, `rotation.ts`, `lessons.ts`, `lessonStore.ts`, `paperRunner.ts`; `learning/notebook.ts` text injection; `youtube/gate.ts` synthetic gate. `agents/propose.ts` stays (it holds `gateViolation`). `maxDrawdownPctFromEquity` moves from `agents/evaluate.ts` to `portfolio/`. |

---

## 4. App layout (`mobile/`)

| Part | File | Today | After |
|---|---|---|---|
| Shell and tabs | `App.tsx` | 8 tabs: Dashboard, Journal, Strategies, Agents, Chart lines, Activity, Settings, Help | 8 tabs: Dashboard, Inbox, Strategies, Testboard, Journal, Agents, Settings, Help |
| Screens | `src/screens/` | 15 screens | Adds `InboxScreen`, `TestboardScreen`, `StrategyChatSheet`. Removes `ActivityScreen`. `LevelsScreen` stays in the code, hidden. |
| Shared UI | `src/components/ui.tsx` | `Page`, `PageHeader`, `StatusPill`, `Pnl`, `StatTile`, `KpiRow`, `DataTable`, `Select`, `Sticky`, `Sheet`, `Button` | New screens use these. Adds `TierTiles.tsx`. |
| Design tokens | `src/theme.ts`, `src/layout.ts` | Dark neutral surfaces, fixed status colours, wide ≥ 1024 px | Unchanged. |
| State and API | `src/store.tsx`, `src/api.ts`, `src/types.ts` | One context, one client | New methods for inbox, testboard, tiers. |
| Logic | `src/logic/` | Does not exist | Pure functions moved out of screens so they can be tested. Includes `help.ts`, the Help tab's text as data. |
| Help | `src/screens/HelpScreen.tsx` | Describes each tab | Says what to do: routine, "when you see this, do this", one action per tab. |

---

## 5. Data

Everything is in one SQLite file. All access goes through `server/src/store.ts`.

### Today

| Table | Holds |
|---|---|
| `strategies` | One row per strategy; the whole strategy is one JSON column |
| `backtests` | Last 10 backtest results per strategy |
| `logs` | Everything the bots did. Rows with level `trade` are never deleted; they are the journal. |
| `position_history` | Closed-position details from the broker |
| `chat_usage` | Tokens and cost per Claude call |
| `settings` | Key-value: API key, autostart flags, evolve settings |
| learning records | Every proposal and its outcome (`learning/sqliteRecords.ts`) |

### Added

| Table | Phase | Holds |
|---|---|---|
| `inbox_items` | 1 | type, strategy, payload, status, created, acted |
| `chat_threads`, `chat_messages` | 1 | One conversation per strategy |
| `gate_events` | 2 | Every stage entry, pass and fail. Append only. |
| `tier_config`, `tier_assignments` | 2 | Caps and the tier history of each strategy |
| `claude_calls` | 2 | Each unattended call and whether it failed |
| `lesson_claims`, `lesson_evidence` | 3 | Scoped lessons and the outcomes behind them |
| `hypotheses`, `trials`, `decision_traces` | 3 | Theories, each test run, and why each proposal was made |
| `kg_nodes`, `kg_edges`, `sources` | 3 | Idea graph |

New fields on a strategy (`isTest`, `gate`, `tier`, `pausedBy`) live inside its JSON, so old rows keep working with no migration.

**Tests never touch this file.** From Phase 1 they run on an in-memory database.

---

## 6. How the main flows work

### A trade

1. `BotRunner` waits for a bar to close. It never acts on a bar that is still forming.
2. `engine/rules.ts` checks the entry rules against the indicators.
3. `engine/risk.ts` works out the stop, target and lot size. **The same file is used by the backtester**, so a backtest and a live bot size and stop the same way.
4. Checks before the order: daily loss, daily trades, cooldown, spread, session. **Added:** spread no more than 15% of the stop (Phase 1), account kill switch (Phase 1), tier cap and correlated bets (Phase 2).
5. The order goes through the `Broker` interface with a comment `XAT:<id>` so the bot can find its own positions later.
6. Trailing and break-even run once per bar. Stop and target sit at the broker, so they still protect you if the server is off.

### A change to a strategy

1. An agent replies with text plus a fenced `xat-actions` block.
2. `chat/actions.ts` parses it; `chat/service.ts` validates it and refuses anything the agent is not allowed to do.
3. `learning/validate.ts` backtests before and after on bars the agent did not see.
4. The critic adds its view.
5. **Today:** the proposal waits in the chat. **After:** it also appears in the Inbox.
6. You approve. Only then is the strategy saved.
7. Later the change is scored as helped, hurt or unclear.

**Added in Phase 2:** one narrow door, `applySafetyMove`, for pausing a bot or strictly tightening a limit without waiting for you. Everything else still needs step 6.

**Added in Phase 3:** before step 1 the agent must state a theory and what would prove it wrong, and the server tests it. No surviving test, no proposal.

### A strategy's stage (Phase 2)

Backtest → paper → demo → live. The gate engine checks every 30 minutes. Passing writes an Inbox item; you tap to move on. Live is locked.

### Start-up

`index.ts` loads `.env`, opens the database, creates an API key if there is none, starts HTTP and WebSocket, resumes bots, starts the learning loop. **Changed in Phase 1:** bots resume only if the server was down under 30 minutes.

---

## 7. API

| Kind | Path | Notes |
|---|---|---|
| REST | `/api/*` | Needs the key in the `x-api-key` header. `/api/health` is open. |
| WebSocket | `/ws?key=…` | Sends `bots`, `bot`, `logs`, `log` messages. |
| Added | `/api/inbox`, `/api/inbox/:id/act`, `/api/testboard`, `/api/strategies/:id/promote`, `/api/strategies/:id/chat`, `/api/tiers`, `/api/digest/latest` | Each group in its own router file, like `chat.ts` and `journal.ts` today. Nobody edits the 18 KB `routes.ts` in parallel. |

---

## 8. Settings (`server/.env`)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | 4000 | |
| `BROKER` | inferred | `paper`, `mt5mcp` or `metaapi`. You use `mt5mcp`. |
| `ALLOW_LIVE_TRADING` | false | While false the server refuses orders on any account that is not demo. **Stays false.** |
| `DB_PATH` | `./xautotrade.db` | |
| `API_KEY` | generated on first start | |
| `MT5MCP_TRANSPORT`, `MT5MCP_COMMAND`, `MT5MCP_ARGS` | `stdio`, `uvx`, `--from,mcp-metatrader5-server,mt5mcp` | How the bridge is started |
| `MT5MCP_FILL_MODE` | auto per symbol | Your runbook pins `ioc` |
| `MT5MCP_DEVIATION_POINTS` | 20 | Allowed slippage on an order |
| `AGENT_MODEL_<ID>`, `CHAT_MODEL` | | Model per agent |
| Added | `ACCOUNT_DAILY_LOSS_PCT=3`, `RESUME_MAX_GAP_MIN=30`, `UNATTENDED_CALLS_PER_DAY=40` | Phase 1–2 |

---

## 9. Build and run

### Needed on the machine

Windows, Node 22, `uv` (for `uvx`), the MT5 terminal logged in to the demo account with Algo Trading switched on, and the `claude` command-line tool logged in.

### Server

```
cd server
npm install
copy .env.example .env      (then set BROKER=mt5mcp)
npm run dev                 start with auto-reload
npm test                    run all tests
npm run typecheck           type check only
npm run build && npm start  compiled run (dist/index.js)
```

### App

```
cd mobile
npm install
npm run web                 browser
npm run android             phone, through Expo
npm run typecheck
npm test                    added in Phase 1
```

### End-to-end tests (added in Phase 1)

```
cd e2e
npm install
npx playwright test         starts the server in paper mode and the web app
```

### On every pull request (added in Phase 1)

`.github/workflows/ci.yml` runs server tests and type check, and the mobile type check and tests. A pull request cannot be merged while red.

---

## 10. Design rules the code already follows, and the plan keeps

1. **The engine is pure.** No network and no clock inside `engine/`. That is why it is easy to test.
2. **One risk module for backtest and live.** Any per-strategy rule goes in `engine/risk.ts`, never in the runner alone.
3. **Dependencies are passed in.** `ChatService`, `Evolver` and the scoring loop take their backend, store and clock as arguments.
4. **Cannot be built without passing.** `EligibleStrategy` in `youtube/gate.ts` has a private constructor, so a strategy that skipped the gate cannot exist. The plan reuses this for proposals (no surviving test, no proposal) and safety moves.
5. **Agents propose, you approve.** The single exception is `applySafetyMove`, and a test fails if a second exception appears.
6. **Cross-strategy limits are live-only.** Tier caps, correlation and the account kill switch need all strategies at once, so a single-strategy backtest cannot check them. The Testboard shows them on a separate line.

---

## 11. Security, as the code stands

| Finding | Where | Action |
|---|---|---|
| The API key is printed in full at every start | `index.ts` | Print only the last 4 characters after first run. Phase 1. |
| The key is also accepted in the URL (`?key=`) | `index.ts` | Needed for the WebSocket; remove it for REST. Phase 1. |
| Any website origin may call the API (`cors()` with no options) | `index.ts` | Limit to the app's own addresses. Phase 1. |
| A real key and the demo account number are in `RUNBOOK.md` in a public repo | `RUNBOOK.md` | Rotate the key, remove both, clean the history. Before live; test S-11 stops it happening again. |
| `ALLOW_LIVE_TRADING` is a plain `.env` switch | `config.ts` | Stays false. Nothing in the plan reads or writes it except the existing check. |

---

## 12. Limits you should know

- One position per strategy; market orders only; trailing updates once per bar, not per tick.
- The path phone → server → bridge → MT5 is slower than an Expert Advisor running inside MT5. It is fine for bar-close strategies and wrong for tick scalping.
- MT5 and the bridge need Windows, so the always-on machine must be a Windows mini PC or Windows VPS.
- The agents depend on the `claude` tool staying logged in. When it is not, the app keeps trading its saved strategies and stops proposing changes.

---

## Update 8 October 2026 — agent service

A second process is added in Phase 3: `agents-py/` (Python 3.12, LangGraph, FastAPI, pytest). It reads one dossier per strategy from the server, runs the graph Doctor → Optimizer → Tester → Critic → Risk Guard, and submits at most one proposal. It has its own SQLite file (`agents.db`) for saved runs and no access to `xautotrade.db` or the broker.

New server routes (all need the agent-only key): `GET /api/agent/dossier/:id`, `POST /api/agent/backtest`, `POST /api/agent/llm`, `POST /api/agent/notes`, `POST /api/agent/proposals`. New table: `agent_notes`. The model call cap and usage log stay on the server because the model is reached through `/api/agent/llm`.

If the service is down, trading and the single-agent chat continue; the Inbox shows one item saying so. See `AGENT-SERVICE.md`.
