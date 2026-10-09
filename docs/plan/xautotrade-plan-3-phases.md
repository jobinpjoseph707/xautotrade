# XAutoTrade — all changes in 3 phases

Written 8 October 2026 from a direct read of `github.com/jobinpjoseph707/xautotrade` (branch `main`, one commit, "Initial snapshot", 2 Oct 2026). Demo account only. No profit is promised anywhere in this plan.

Every change has tests, listed by ID in `TEST-PLAN.md`. The Help tab text is in `HELP-ACTIONS.md`. The technology, folders, data and build steps are in `ARCHITECTURE.md`.

Each phase ends in something you can use. Do not start a phase until the one before it is merged and `npm test` is green on your Windows machine.

---

## What the real code showed (and what it changes in the plan)

| Found in the repo | Effect on the plan |
|---|---|
| `RiskConfig.maxLot` already exists, default **5** (`server/src/engine/types.ts`) | No new field. Lower the default and clamp saved strategies. This is why 5 lots opened on EURUSD. |
| `slMode: 'none'` and `tpMode: 'none'` are allowed | Must be rejected. "Target bigger than stop" and risk caps mean nothing without a stop. |
| A strategy is saved as one JSON blob (`strategies.json` column in `server/src/store.ts`) | New strategy fields (`isTest`, `gate`, `tier`, `pausedBy`) need no SQL migration. Only new tables do. |
| `validateStrategy()` lives in `server/src/engine/rules.ts` | The target-above-stop rule goes there, not in a new file. |
| All main endpoints sit in one file, `server/src/api/routes.ts` (18 KB) | New features get their own router file, like `chat.ts`, `journal.ts`, `markets.ts` already do. Nobody edits `routes.ts` in parallel. |
| `BotManager.restoreAutostart()` restarts every bot after a restart, no matter how long the server was down (`server/src/live/manager.ts`) | Needs a downtime check. Today a laptop that slept 6 hours resumes trading silently. |
| YouTube pipeline (`server/src/youtube/`) is rule-based text extraction → strategy → a gate that backtests on **synthetic** candles with the profit check **off** (`minProfitFactor: 0`) → straight into weekly rotation | That gate proves nothing. YouTube output must become an *idea* that enters the same real-data gates as everything else. |
| Lessons (`server/src/learning/notebook.ts`): 3 results, 75% agreement, a **general** tally across all markets, and "hurt" lessons **shared** to every agent | This is the cross-market leak you rejected. Both are removed in Phase 3. |
| Two learning systems: `server/src/learning/` (12 files) and `server/src/agents/` (11 files, run by `npm run agents:weekly`) | Merge into `learning/`. Keep `agents/propose.ts` (it holds `gateViolation`). |
| Tabs in `mobile/App.tsx`: dashboard, journal, strategies, agents, levels, activity, profile, help | Becomes: dashboard, inbox, strategies, testboard, journal, agents, profile, help. Still 8, so the phone tab bar still fits. |
| README still describes MetaApi; `metaapi.ts` is still in `broker/` next to `mt5mcp.ts` | README is rewritten in Phase 1. The MetaApi adapter is left alone. |

---

## Rules for every phase

1. `ALLOW_LIVE_TRADING` stays `false`. No code may change it or promote a strategy to live.
2. Work on a branch, one pull request per task. `main` only moves by merge.
3. After every task: `npm test` and `npm run typecheck` in `server/`, `npx tsc --noEmit` in `mobile/`.
4. New server tests go at least one folder below `server/src/` (the test glob is `src/**/*.test.ts`).
5. Never delete or weaken a test to get green. If behaviour changes on purpose, change the test and say why in the PR.
6. Only one task at a time may edit these shared files: `mobile/App.tsx`, `mobile/src/api.ts`, `types.ts`, `store.tsx`, `server/src/store.ts`, `server/src/engine/types.ts`, `server/src/api/routes.ts`, `server/src/live/runner.ts`, `server/src/index.ts`.

---

## Phase 1 — Clean, safe, and one place to look

**Goal:** the app stops being vague. Only real strategies count, bad configs are refused, and everything that needs you is in one Inbox.
**Time:** about 2 weeks at 2–3 hours a day. **Demo:** your 1–2 keeper strategies start trading by the end of week 1.

### 1.1 Foundation (done alone, first)
- `server/src/engine/types.ts`: add to `Strategy`: `isTest?`, `gate?` (`backtest | paper | demo | live`), `tier?`, `pausedBy?` (`owner | safety`). Add to `RiskConfig`: `minRewardRisk` (1.5), `maxSpreadToStopRatio` (0.15), `flatAtUTC` (`"21:45"`), `flatBeforeWeekend` (true). Change `DEFAULT_RISK.maxLot` from 5 to 0.5.
- `mobile/App.tsx`: new `Tab` type and `NAV` list. Remove `levels` and `activity`, add `inbox` and `testboard` with placeholder screens. `DashboardScreen`'s `onOpenActivity` now opens Inbox.
- `mobile/src/types.ts`, `api.ts`: matching types and empty client methods.
- New empty routers: `server/src/api/inbox.ts`, `testboard.ts`, `tiers.ts`, mounted the same way `chat.ts` is.
- New `plan/REPO-MAP.md`: one line per source file, so later tasks know who owns what.
- Test foundations (TEST-PLAN T-0.1 to T-0.8): tests stop writing to your real database, shared test helpers, first tests for the live runner and the API, logic tests for the app, Playwright, and a CI run on every pull request.
- Tests: F-1 to F-5.

### 1.2 Strategy rules (`engine/rules.ts`, `risk.ts`, `backtest.ts`, `presets.ts`)
- `validateStrategy()` rejects: `slMode: 'none'`; `tpMode: 'none'`; target smaller than `minRewardRisk` × stop (compare ATR multiples, points, or `tpRR`).
- New pure helper in `risk.ts`: skip the entry when spread is more than 15% of the stop distance. Called from both the backtester and the live runner, counted in `gateBlocks.spreadToStop`. `maxSpreadPoints` stays as a hard ceiling.
- `presets.ts`: remove hard-coded session hours; mark `orderPathTest`, `fastScalpTest`, `goldQuickScalpTest` with `isTest: true`.
- Flat rule: close positions at `flatAtUTC` and before the weekend, in backtest and live alike.
- Fix `hourUTC` so it is real UTC, not broker time.
- Tests: R-1 to R-19.
- **What this means for gold:** with a 30–35 point spread, a stop must be about 200 points or more. Tight 1-minute gold scalps will be refused. That is intended.

### 1.3 Clean the saved strategies (one script, dry run first)
- `server/scripts/cleanup.ts`: back up the DB, flag "(test)" strategies as `isTest`, clamp `maxLot`, delete the two "M1 Gold Quick Scalp" copies that trade EURUSD, delete "M1 HFT EMA Scalp".
- `server/scripts/rank.ts`: backtest every remaining strategy under the new rules and print trades, profit factor, drawdown. **You** run it with MT5 open and pick the 1–2 keepers.
- Journal and Dashboard totals exclude `isTest` (filter in `journal/journal.ts` and the dashboard queries).
- Tests: C-1 to C-7.

### 1.4 Inbox replaces Activity
- New `server/src/inbox/` with its own table (`inbox_items`). Types: proposal, gate result, error, stall, losing streak, safety action, Claude unavailable, digest.
- New `mobile/src/screens/InboxScreen.tsx`; delete `ActivityScreen.tsx`. Approve / Reject / Restart / Dismiss happen in place.
- Proposals created in `chat/service.ts` also write an Inbox item. Logs stay in the `logs` table; only the screen goes.
- Tests: I-1 to I-10.

### 1.5 Chat on each strategy
- Chat icon on each row in `StrategiesScreen.tsx` opens a sheet tied to that strategy (`mobile/src/screens/StrategyChatSheet.tsx`).
- `chat/agents.ts`: `routeAgent()` keyword regex replaced by four buttons (Tune, Diagnose, Tighten risk, Critique) plus a cheap-model fallback for free text.
- `chat/service.ts`: the `wantsBacktest` regex goes; the agent asks for a what-if backtest in a fenced block, the server runs it and attaches a one-tap proposal.
- Tests: H-1 to H-9.

### 1.6 Safety basics
- Account-level daily loss cap (default 3% of day-start equity) in a new `server/src/safety/killSwitch.ts`: closes XAT positions, pauses all bots, writes an Inbox item.
- `manager.ts` `restoreAutostart()`: save a heartbeat every minute; on start, resume bots only if the gap was under 30 minutes, otherwise leave them paused and ask in Inbox.
- Stall watch: no bar processed for 3× the timeframe while the market is open → Inbox item.
- Rewrite `README.md`; rotate the API key and remove it from `RUNBOOK.md` (needed before live, not before demo).
- `index.ts`: stop printing the full API key at every start, accept the key in the URL only for the live feed, and limit which web addresses may call the API.
- Tests: S-1 to S-11.

### 1.7 Help tab says what to do
- Today `HelpScreen.tsx` describes each tab. It becomes an action guide: your daily and weekly routine at the top, then "when you see this, do this" for every Inbox card, broker error and save error, then one action line per tab. Full text in `HELP-ACTIONS.md`.
- The text moves into `mobile/src/logic/help.ts` so a test can check that every message the app can show has an action.
- Each Inbox card gets a "What do I do?" link that opens Help at the right entry.
- The Chart lines and Activity cards are removed from Help; the line "agents cannot act on their own" is corrected for safety moves.
- From now on a feature is not finished until its Help entry exists.
- Tests: HP-1 to HP-7.

**Phase 1 is done when:** a strategy with target smaller than stop cannot be saved; test rigs are gone from all totals; the Inbox is the only place you need to open; a 40-minute server outage leaves bots paused with a message; every Inbox card has a "What do I do?" answer in Help.

---

## Phase 2 — Gates and enforced risk

**Goal:** every strategy has a visible stage, and risk limits block trades instead of just being shown.
**Time:** about 1–2 weeks. **Demo:** keepers keep trading; first verdicts arrive at about 100 trades.

### 2.1 Gate engine and Testboard
- New `server/src/gates/`: evaluates each strategy every 30 minutes, records every pass and fail.
- Stages and pass marks (all changeable):

| Stage | Pass mark |
|---|---|
| Backtest | Real broker candles. At least 100 trades, at least 30 on older unseen bars, profit factor 1.2 or more on the unseen part, still not losing with the spread doubled. |
| Paper | Replay the last 3 days of real candles through the live runner with the paper broker. No errors, no illegal stops, lots within `maxLot`, trades match the backtest. Takes minutes. It checks the plumbing, not the edge. |
| Demo | At least 7 days and 100 trades. Profit factor above 1.2, average win at least as big as average loss, drawdown inside its tier. |
| Live | Locked. Shown with a padlock. |

- Each extra attempt on the same unseen bars raises the bar (+0.05 profit factor), max 5 attempts, then wait for new bars. This stops lucky passes.
- `mobile/src/screens/TestboardScreen.tsx`: one card per strategy with stage, progress (e.g. "40 / 100 trades") and a plain verdict. Moving to the next stage is your tap, from the Inbox (**Move to next stage** or **Keep here**). Help gains an action for every Testboard verdict.
- `server/src/broker/paper.ts` gains the replay mode (new file `paperReplay.ts` beside it).
- Tests: G-1 to G-15.

### 2.2 Risk tiers
- New `server/src/portfolio/`: five tiers, set from measured behaviour over the last 30 demo days (risk per trade, drawdown, daily swings), not from the strategy's name. Rechecked daily.
- Cap = open risk to stop, per tier, as a share of a 3% account risk budget. The top tier can never be set above 20%.
- Enforced in `live/runner.ts` as a check before every order; blocked orders are logged.
- Correlation: same symbol and direction counts as one bet; so do configured pairs (for example EURUSD and GBPUSD in the same direction).
- Dashboard gets a tier panel (`mobile/src/components/TierTiles.tsx`).
- Backtests test one strategy, so they cannot check tier caps. The Testboard shows portfolio checks on their own line.
- Tests: T-1 to T-13.

### 2.3 Safety moves that apply themselves
- New `server/src/safety/applySafetyMove.ts`, the **only** function allowed to change anything without your approval. It accepts two things: pause a bot, or a change that `gateViolation()` (in `agents/propose.ts`) confirms is strictly tighter. Everything else throws.
- Every use writes an Inbox item with **OK** and **Undo**. Undo is your own action, so it may restore the old value. A bot paused by safety stays paused until you restart it. Help gains the tier and safety entries.
- Tests: M-1 to M-9. One of them fails if any new code path saves a strategy without your approval.

### 2.4 Small additions
- Token usage panel in Settings (`ProfileScreen.tsx`), reading the existing `GET /api/chat/usage`.
- Weekly digest (`server/src/digest/`): Sunday summary as an Inbox item, built from numbers, one cheap model call for wording.
- Daily cap of 40 unattended Claude calls (`server/src/chat/backend.ts`); when the CLI login expires or a limit is hit, one Inbox item and the loop stops for the day.
- Tests: U-1 to U-8.

**Phase 2 is done when:** every strategy shows a stage and a verdict; an order past a tier cap is blocked and logged; a forged "loosen" safety move is refused in a test.

---

## Phase 3 — Learning that cannot fool itself, then knowledge

**Goal:** the agents improve strategies by testing theories, and lessons only reach the place they were learned.
**Time:** about 2 weeks for 3.1–3.3, then 3.4 onward at your own pace.

### 3.1 One learning system
- Move the "one cause-directed change per failed week" idea from `agents/weekly.ts` into the learning loop. Migrate `agents/lessonStore.ts` data. Then delete `weekly.ts`, `rotation.ts`, `lessons.ts`, `lessonStore.ts`, `paperRunner.ts` and the `agents:weekly` script. Keep `propose.ts`. The drawdown helper in `evaluate.ts` moves to `portfolio/` in Phase 2, with its test.
- Tests: L-1, L-2.

### 3.2 Scoped lesson ledger (replaces `learning/notebook.ts`)
- Remove the general tally and the shared hurt lessons from `deriveLessons()` and `buildNotebook()`.
- New `learning/ledger.ts`. A lesson's key is symbol + timeframe + market state (volatility, trend and spread, each low / mid / high, taken from the `MarketSnapshot` already saved on every record).
- An outcome counts only if it rests on 30 or more trades **after** the change.
- A lesson is trusted after 5 agreeing outcomes (was 3). Old outcomes lose weight over time (half-life 14 days for market-state lessons, 90 days for structural ones).
- If two trusted lessons disagree on the same setting: the agent holds and does nothing.
- New `learning/retrieve.ts` builds the prompt: only lessons whose key matches the strategy, top 10, as data rows, under a fixed size. `chat/prompt.ts` stops pasting notebook sentences.
- `learning/scoring.ts`: score on real demo trades after the change (30 or more), not a second backtest.
- Tests: L-3 to L-16.

### 3.3 Reasoning by theory and test
- New `learning/hypothesis.ts` and `trials.ts`. Once a week, for each strategy that is failing its gate and has no change waiting to be scored:
  1. Slice the journal by market state, hour and direction.
  2. The agent writes a theory, the one change it implies, and what result would prove it wrong.
  3. The server tests it on bars the agent never saw.
  4. Only a surviving theory becomes a proposal in your Inbox.
  5. After approval and 30 trades, it is scored, and the agent writes one sentence on why.
- Every proposal stores its checklist answers (market, timeframe, market state, tier, evidence, what would prove it wrong) and the lessons it used. You can open this from the Inbox card ("Why was this proposed?"). Help gains the learning entries.
- One open change per strategy at a time.
- `learning/evolve.ts` uses the same path, so there is one way to change a strategy, not two.
- Tests: P-1 to P-9.

### 3.4 Knowledge layer
- Two tables in the same SQLite file for a graph of ideas (nodes and links, links carry "valid from / valid until"). No new database. Kùzu, which I suggested earlier, was archived in October 2025, so it is out.
- YouTube: keep `youtube/transcript.ts`, `extract.ts`, `map.ts`. Change `pipeline.ts` so the result is an idea with a source tag at stage "backtest", sized by your risk rules. Remove `submitToRotation()` and the synthetic-candle gate in `gate.ts`; the Phase 2 gate on real candles replaces it.
- Books: you paste a chapter you own; the server keeps short concept notes and page numbers, never the text.
- Competition methods: manual entry form; the entry idea is kept, the sizing is thrown away.
- Each idea shows its measured status in prompts: untested, supported by N outcomes, or contradicted. A book never changes a lesson's score.
- Tests: K-1 to K-8.

### 3.5 Later, in any order
Parameter sweep (each combination counts as an attempt), walk-forward and Monte Carlo tests, news with a vector store (`sqlite-vec`), Chart lines on MT5 with a loud health check, a second model behind the existing `ChatBackend` interface.

**Phase 3 is done when:** a test proves a gold lesson never appears in a EURUSD prompt; a proposal cannot exist without a surviving test; with Claude unreachable the loop writes one Inbox item and changes nothing.

---

## Decisions that are yours (defaults used until you say otherwise)

1. Delete "M1 HFT EMA Scalp" instead of fixing it.
2. `maxLot` default 0.5 (0.2 on gold).
3. Flat at 21:45 UTC daily and before the weekend.
4. Account daily loss cap 3%.
5. Bots resume by themselves only after an outage under 30 minutes.
6. Moving a strategy to the next stage needs your tap.
7. Lesson trusted after 5 agreeing outcomes.
8. Help tab stays, text updated.
9. A stop in ATR with a target in points (or the reverse) is refused, because the two cannot be compared. Use reward:risk for the target instead.

## Honest expectation

One month gives 1–3 weeks of demo trades on 1–2 strategies. That is enough to throw out bad ideas, not enough to prove a good one. 100 trades at profit factor 1.2 is only about 84% confidence the edge is real. If nothing passes, the system did its job.

---

## Update 8 October 2026 — agents that talk to each other

**Decision changed.** The plan said "no agent framework". You asked for agents that talk and share what they know about each strategy, so Phase 3 task 3.3 (the hand-built learning loop) is replaced by a small Python service built on LangGraph. Full design: `AGENT-SERVICE.md`. Tests: AG-1 to AG-14 in `TEST-PLAN.md`.

| What | Detail |
|---|---|
| Where | New folder `agents-py/` beside `server/` and `mobile/` |
| Agents | Doctor, Optimizer/Strategist, Tester (plain code), Critic, Risk Guard |
| Shared memory | One dossier per strategy (settings, journal slices, scoped lessons, open theories, agent notes) |
| Guardrail | The service has no broker and no database access. It uses five `/api/agent/*` routes. Its proposals go through the same checks and the Inbox as any other. |
| Runs | On your tap (Diagnose, Tune) and in the weekly cycle. Not continuously. |
| Cost | About one extra week in Phase 3. The YouTube and books layer (3.4) moves after it. |

**Interview and profile items** (small, added to Phase 3 as the last task, 3.6):
agent evaluation suite run on each pull request; trace of every agent call; Docker for paper mode so anyone can run it without MT5; short decision records; a results page that shows what failed as well as what passed.

**Kept out of the phases, in `FUTURE.md`:** a fast local decision model, quant methods at small scale, tick-level execution, and the note that MT5 has no order book.

**Separate project:** Polymarket is in its own repo, `polymarket-research-agents`. Nothing in these three phases depends on it.
