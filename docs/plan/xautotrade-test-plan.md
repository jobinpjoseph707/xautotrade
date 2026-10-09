# XAutoTrade — test plan

Written 8 October 2026 from the code on `main`. It goes with `PLAN-3-PHASES.md` and `ARCHITECTURE.md`.

**The rule:** no task is finished until its tests in this file exist and pass. Every change in the 3-phase plan has tests listed here, written the same way the current tests are written.

---

## 1. How tests work today

I read 5 of the 12 test files in full (`chat.test.ts`, `usage.test.ts`, `learning.test.ts`, `agents.test.ts`, `daily.test.ts`) and the folder listings for the rest.

| Fact | Detail |
|---|---|
| Runner | Node's built-in runner: `import { test } from 'node:test'` and `assert from 'node:assert/strict'`. No Jest, no Vitest. |
| Command | `npm test` in `server/` runs `tsx --test src/**/*.test.ts`. |
| Files | 12 files, each beside the code it tests: `engine/engine.test.ts`, `engine/levels.test.ts`, `engine/overlays.test.ts`, `broker/mt5mcp.test.ts`, `live/daily.test.ts`, `live/reconcile.test.ts`, `chat/chat.test.ts`, `chat/usage.test.ts`, `learning/learning.test.ts`, `agents/agents.test.ts`, `agents/lessons.test.ts`, `youtube/youtube.test.ts`. Your notes say about 172 tests in total. |
| Style | Each test name is a full sentence that states the behaviour, for example "Risk Guard can tighten but never loosen; other agents get a warning". |
| Fakes | No mocking library. Code takes its dependencies as arguments, and tests pass in small fakes: a fake `ChatBackend` (`{ name: 'fake', complete: async () => reply }`), `makeHost()` (strategies in a Map), `MemoryRecordStore`, `MemoryAgentStore`, a clock passed in as `now: () => now`, `PaperBroker`, and `broker/mt5mcp.fake.mjs` for the MT5 bridge. |
| Regressions | A bug that reached you gets a test with a comment saying what broke. |

### Gaps found in the repo

| Gap | Why it matters | Fixed in |
|---|---|---|
| **Tests write to your real database.** `store.ts` opens `./xautotrade.db` when imported; `usage.test.ts` says so in a comment. | New tables (Inbox, gates, tiers) would get test rows mixed with real ones. | Phase 1, T-0.2 |
| **The test glob is not quoted.** On Linux the shell turns `src/**/*.test.ts` into "exactly one folder below `src`", so a test two folders deep is silently skipped. On Windows Node expands it and finds all depths. | A test can pass on your PC and never run in CI. | Phase 1, T-0.1 |
| **`live/runner.ts` (26 KB) and `live/manager.ts` have no tests.** Only `daily.ts` and `reconcile.ts` do. | The kill switch, tier caps and restart rule all hook in here. | Phase 1, T-0.4 |
| **`api/` has no tests** (5 files, `routes.ts` is 18 KB). `index.ts` starts listening as soon as it is imported, so it cannot be tested. | Three new routers are being added. | Phase 1, T-0.5 |
| **`mobile/` has no tests at all**, and no test script. The Playwright scripts your notes mention are not in the repo. | Tabs and two new screens change. | Phase 1, T-0.6 and T-0.7 |
| **No CI.** There is no `.github/` folder. | Nothing runs the tests on a pull request. | Phase 1, T-0.8 |

---

## 2. Rules for every new test

1. Same runner, same style. `node:test` + `assert/strict`. No new test library on the server.
2. Test file sits beside the code: `server/src/<folder>/<folder>.test.ts`. One folder below `src` only, until T-0.1 is merged.
3. Name the behaviour in a sentence. Someone reading only the test names should understand the rules of the app.
4. New code takes its dependencies as arguments (broker, clock, store, backend). If a test needs a real MT5 terminal, a real Claude call, or the real time of day, the design is wrong.
5. Numbers in tests are worked out by hand in a comment, like `// (10200-9600)/10200 = 5.88%` in `agents.test.ts`.
6. Table-driven where there is a table. Tier thresholds, gate pass marks and the "what counts as tighter" table each get one test that loops over rows.
7. Each safety rule gets a test that tries to break it, not only a test that it works.
8. Never delete or weaken a test to get green. When behaviour is changed on purpose, the test changes with it and the pull request says why. Section 6 lists every existing test this plan changes.
9. The test count may only go down when a file is deleted, and then section 6 says where its still-useful tests moved.

**Done means:** the task's tests in this file exist and pass, `npm test` and `npm run typecheck` pass in `server/`, `npx tsc --noEmit` passes in `mobile/`, and from T-0.7 on, the Playwright run passes at 1440 px and 390 px.

---

## 3. Phase 1 tests

### 3.0 Test foundations (part of task 1.1, done first)

| ID | What is built | How it is checked |
|---|---|---|
| T-0.1 | Quote the glob: `"test": "tsx --test \"src/**/*.test.ts\""`. | A throwaway test two folders deep runs on both Windows and Linux, then is removed. |
| T-0.2 | `server/src/testkit/setup.ts` sets `process.env.DB_PATH ??= ':memory:'`; the test script loads it with `--import`. | New test "tests never open the real database file": `config.dbPath` is `:memory:` under test. |
| T-0.3 | `server/src/testkit/` (not a test file) with the helpers now copied between files: `makeHost`, `fakeBackend`, `record`, `validStrategy()` (stop 200, target 300), `fakeClock`, candle builders (`trend`, `flat`, `withSpread`), `ScriptedBroker` (a `PaperBroker` whose quotes, equity and positions a test can set). | Used by every test below. `chat.test.ts` and `learning.test.ts` switch to it with no change in what they assert. |
| T-0.4 | `live/runner.test.ts` — first tests for the runner, on today's behaviour, before anything changes: opens on a signal at bar close; never acts on a forming bar; refuses a non-demo account when `allowLiveTrading` is false; tags orders `XAT:<id>`; `stop()` leaves positions open; `closeAll()` closes only its own. | 6 tests with `ScriptedBroker`. These pin current behaviour so later changes are visible. |
| T-0.5 | Split `index.ts` into `app.ts` (`createApp()` returns the Express app, no listen) and `index.ts` (listens). `api/api.test.ts` starts the app on port 0 and calls it with `fetch`. | "every /api route except /health refuses a missing or wrong key"; "the key is accepted in the x-api-key header". |
| T-0.6 | Mobile logic tests: move pure logic out of screens into `mobile/src/logic/*.ts` and test it with the same runner (`tsx` added as a dev dependency, `"test": "tsx --test \"src/**/*.test.ts\""`). | `mobile/src/logic/nav.test.ts`: "there are exactly 8 tabs, in order: dashboard, inbox, strategies, testboard, journal, agents, profile, help"; "levels and activity are not tabs". |
| T-0.7 | `e2e/` folder with Playwright against `expo start --web`, server in paper mode with a seeded in-memory database. Two sizes: 1440 px and 390 px. | Smoke: app loads, every tab opens with keys 1–8, no console errors. Re-adds the checks your design notes describe (sidebar collapse, journal filter bar). |
| T-0.8 | `.github/workflows/ci.yml`: on every pull request run server test + typecheck and mobile typecheck + test. Playwright runs on a manual trigger first, on every pull request once it is stable. | A pull request with a failing test shows red. |

### 3.1 Foundation types and storage (task 1.1)

File: `engine/engine.test.ts`, `api/api.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| F-1 | new risk defaults are maxLot 0.5, minRewardRisk 1.5, maxSpreadToStopRatio 0.15 | `DEFAULT_RISK` values. |
| F-2 | a strategy saved before this change still loads and gets the new defaults | Old JSON without `isTest`, `gate`, `minRewardRisk` reads back as `isTest: false`, `gate: 'backtest'`, ratio 1.5. No SQL migration is needed because a strategy is one JSON column. |
| F-3 | isTest, gate, tier and pausedBy survive a save and load | Round trip through `strategies.save` / `get`. |
| F-4 | starting twice on the same database changes nothing | New `CREATE TABLE IF NOT EXISTS` blocks are safe to re-run; old rows untouched. |
| F-5 | inbox, testboard and tiers routes exist and need the API key | 401 without key, 200 with, for each new router. |

### 3.2 Strategy rules (task 1.2)

Files: `engine/engine.test.ts`, `live/runner.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| R-1 | a strategy with no stop is refused | `slMode: 'none'` fails `validateStrategy` with a readable reason. |
| R-2 | a strategy with no target is refused | Same for `tpMode: 'none'`. |
| R-3 | target smaller than 1.5 × stop is refused (points) | stop 200 / target 299 fails; 300 passes. |
| R-4 | target smaller than 1.5 × stop is refused (ATR multiples) | 1.0 / 1.4 fails; 1.0 / 1.5 passes. This is the `goldQuickScalpTest` shape (1.0 / 0.8). |
| R-5 | reward:risk mode needs tpRR of at least 1.5 | 1.4 fails; 1.5 passes. |
| R-6 | stop and target in different units are refused unless the target is reward:risk | ATR stop with a points target cannot be compared, so it is refused. **New rule — say if you want it otherwise.** |
| R-7 | the three real presets pass on XAUUSD and EURUSD; the three test rigs are marked isTest | Loops over presets. |
| R-8 | presets carry no session hours | `risk.sessions` is `[]` for every preset. |
| R-9 | spread 35 with a 150-point stop is blocked; with a 240-point stop it is allowed | 35/150 = 23% > 15%; 35/240 = 14.6%. Pure helper in `risk.ts`. |
| R-10 | when a bar has no spread, the symbol's typical spread is used | `Candle.spread` is optional today. |
| R-11 | a backtest with spread above 15% of the stop opens no trades and counts the blocks | `gateBlocks.spreadToStop > 0`, `totalTrades === 0`. |
| R-12 | the live runner places no order when spread is above 15% of the stop | Same helper, live side, with `ScriptedBroker`. Together with R-11 this keeps backtest and live the same. |
| R-13 | maxSpreadPoints still blocks on its own | The old hard ceiling is unchanged. |
| R-14 | a position open at 21:45 UTC is closed with reason "eod", and nothing opens until the next day | Backtest. |
| R-15 | positions are closed before the weekend | Friday cut-off, backtest. |
| R-16 | the live runner goes flat at the same times as the backtest | `fakeClock` + `ScriptedBroker`. |
| R-17 | hourUTC is real UTC when the broker clock is UTC+3 | A bar stamped 15:00 broker time gives 12. |
| R-18 | 1% risk with a 4-point stop never sizes above maxLot | **Regression:** percent-risk sizing opened 5 lots on EURUSD. |
| R-19 | an agent proposal that breaks any rule above is refused with the reason | `chat.test.ts`: create and update both go through `validateStrategy`. |

### 3.3 Cleanup scripts (task 1.3)

File: `server/src/scripts/scripts.test.ts` (the logic lives in `src/scripts/cleanup.ts` so it can be tested; `server/scripts/` only holds thin runners)

| ID | Test name | What it proves |
|---|---|---|
| C-1 | a dry run changes nothing and prints what it would do | Database identical before and after. |
| C-2 | a backup is written before the first change | No backup, no change. |
| C-3 | strategies with "(test)" in the name are flagged isTest | |
| C-4 | maxLot above the new default is clamped | 5 → 0.5. |
| C-5 | only the named duplicates and the HFT scalper are deleted, and a second run does nothing | Idempotent. |
| C-6 | journal and dashboard totals leave out test strategies | `journal/journal.ts`: trades from an `isTest` strategy do not change any total. |
| C-7 | ranking marks a strategy with under 100 trades as unproven and sorts the rest | `rank.ts` with fixed backtest results. |

### 3.4 Inbox (task 1.4)

Files: `inbox/inbox.test.ts`, `api/api.test.ts`, `e2e/inbox.spec.ts`

| ID | Test name | What it proves |
|---|---|---|
| I-1 | an item is added, listed newest first, and leaves the list when acted on | Lifecycle. |
| I-2 | acting on the same item twice is refused | Like "already approved" in `chat.test.ts`. |
| I-3 | a new proposal writes exactly one inbox item that points to it | `ChatService` + inbox. |
| I-4 | approving from the inbox applies the proposal once | Calls `ChatService.approve` one time. |
| I-5 | rejecting from the inbox changes nothing | Host call list stays empty. |
| I-6 | the same stall on the same strategy does not create a second open item | De-duplication key. |
| I-7 | GET /api/inbox returns open items; POST /api/inbox/:id/act acts on one | HTTP shape. |
| I-8 | trade rows still reach the log and the live feed | Removing the Activity screen removes no data. |
| I-9 (e2e) | an empty inbox says "Nothing needs you. You can close the app." | |
| I-10 (e2e) | approving a proposal card removes it from the list | Both screen sizes. |

### 3.5 Chat on each strategy (task 1.5)

File: `chat/chat.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| H-1 | each button picks its agent: Tune → optimizer, Diagnose → doctor, Tighten risk → guard, Critique → critic | Replaces the keyword test. |
| H-2 | free text is routed by the classifier's JSON answer | Fake backend returns `{"agent":"guard"}`. |
| H-3 | if the classifier fails or answers nonsense, the doctor answers | No crash, no wrong agent with write rights. |
| H-4 | each strategy has its own conversation | History from strategy A is not in B's prompt. |
| H-5 | the prompt for a strategy chat contains that strategy only | |
| H-6 | a what-if block runs one backtest and returns a proposal with the before and after numbers | Fake `backtests` function called once. |
| H-7 | a what-if that breaks the target rule returns the reason and no proposal | |
| H-8 | a performance question gets backtest numbers without any keyword | **Rewrites the regression test** "backtest trigger recognises loss/result phrasing": same user sentence, same expectation, no regex. |
| H-9 | the critic still cannot propose actions | Unchanged test, kept. |

### 3.6 Safety basics (task 1.6)

Files: `safety/safety.test.ts`, `live/manager.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| S-1 | at 3% below day-start equity every bot is paused and its positions are closed | `ScriptedBroker` equity 10 000 → 9 700. `pausedBy: 'safety'`. |
| S-2 | at 2.9% nothing happens | |
| S-3 | positions you opened by hand in MT5 are not touched | Only `XAT:` comments are closed. |
| S-4 | the kill switch fires once per day and writes one inbox item | |
| S-5 | the loss is measured on equity, so an open loss counts | Balance unchanged, equity down 3%. |
| S-6 | after a 29-minute outage bots resume | Heartbeat + `fakeClock`. |
| S-7 | after a 31-minute outage bots stay paused and the inbox asks | **Changes today's behaviour**, where `restoreAutostart()` always resumes. |
| S-8 | a bot paused by safety never resumes by itself | Whatever the outage length. |
| S-9 | no bar for 3 × the timeframe while the market is open raises a stall item | |
| S-10 | a quiet weekend raises nothing | |
| S-11 | RUNBOOK.md and README.md contain no 32-character hex key | A test that fails if a key is ever committed again. |

### 3.7 Help tab says what to do (task 1.7)

Files: `mobile/src/logic/help.test.ts`, `e2e/help.spec.ts`. The text is in `HELP-ACTIONS.md`.

| ID | Test name | What it proves |
|---|---|---|
| HP-1 | every inbox card type has a "what to do" entry | Loops over the Inbox item types in `types.ts`; a new type with no Help entry fails the build. |
| HP-2 | every Testboard verdict has a "what to do" entry | Same, for verdicts. Phase 1 ships the list empty; Phase 2 fills it and this test starts to bite. |
| HP-3 | every tab has exactly one action line, and no removed tab is mentioned | 8 lines matching `NAV`; no "Chart lines", no "Activity". |
| HP-4 | every entry has all three parts: what you see, what it means, what to do | No empty strings; "what to do" starts with a verb or "Nothing". |
| HP-5 | Help never promises profit | No entry contains "guarantee", "will profit" or "risk-free". |
| HP-6 (e2e) | Help opens with the daily routine, before any tab description | Both screen sizes. |
| HP-7 (e2e) | "What do I do?" on an inbox card opens Help at that entry | |

### Phase 1 checks by hand (your Windows machine, MT5 demo open)

1. `npm test` and both type checks pass.
2. Run the cleanup script as a dry run, read the list, then run it for real.
3. Try to save a strategy with target smaller than stop in the app. It is refused with a reason.
4. Start one keeper strategy. One demo order opens and closes with the right lot.
5. Open Help. Without reading anything else in the app, you can say what to do each day.
6. Stop the server for 40 minutes with a bot running, start it again. The bot is paused and the Inbox asks.
7. Put the laptop to sleep for 10 minutes with a position open. On wake, the position still has its stop and target at the broker.

---

## 4. Phase 2 tests

### 4.1 Gates and Testboard (task 2.1)

Files: `gates/gates.test.ts`, `broker/paperReplay.test.ts`, `e2e/testboard.spec.ts`

| ID | Test name | What it proves |
|---|---|---|
| G-1 | the backtest gate passes and fails at each pass mark | Table: 99 trades fail, 100 pass; 29 unseen trades fail, 30 pass; profit factor 1.19 fail, 1.20 pass; loses with spread × 2 fail. |
| G-2 | the gate never uses made-up candles | The candle source is passed in; a test double for `generateCandles` that throws is never called. **This is the fault in today's `youtube/gate.ts`.** |
| G-3 | the second attempt on the same unseen bars needs profit factor 1.25 | Bar rises 0.05 per attempt. |
| G-4 | a sixth attempt is refused until 500 new bars exist | Then the count resets. |
| G-5 | the demo gate needs both 7 days and 100 trades | 6 days + 300 trades fails; 14 days + 99 trades says "not enough evidence", not pass. |
| G-6 | average win smaller than average loss fails the demo gate | "Bigger wins, smaller losses". |
| G-7 | passing a gate writes an inbox item and does not move the strategy | `strategy.gate` unchanged until you tap. |
| G-8 | moving to live is always refused | Throws "locked" with `allowLiveTrading` false **and** true. |
| G-9 | gate history can be added to but never changed | Same pattern as "a written record is immutable" in `agents.test.ts`. |
| G-10 | test strategies never appear on the Testboard | |
| G-11 | replay: a strategy with break-even inside the spread fails with "stop move illegal" | The "M1 HFT EMA Scalp" fault. |
| G-12 | replay and backtest of the same bars give the same trades | Same entries; exits within one bar. **The parity test.** |
| G-13 | replay fails if any lot is above maxLot or any error is logged | |
| G-14 (e2e) | a strategy with 40 demo trades shows "40 / 100" and "Not enough trades yet" | |
| G-15 (e2e) | the live stage shows a padlock and cannot be tapped | |

### 4.2 Risk tiers (task 2.2)

File: `portfolio/portfolio.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| T-1 | each row of the tier table lands in its tier | Table-driven over the thresholds. |
| T-2 | the worst of the three measures decides the tier | Low risk per trade + 12% drawdown → tier 4. |
| T-3 | moving to a riskier tier is immediate; moving to a safer one needs 3 days in a row | |
| T-4 | open risk is the sum of lot × stop distance × point value | Worked by hand for two positions. |
| T-5 | an order that would pass the tier cap is blocked and logged | Budget 3%, top tier 20% → cap 0.6% of equity. |
| T-6 | an order below the cap goes through | |
| T-7 | a cap never closes a position that is already open | |
| T-8 | the top tier cannot be set above 20% | Config refuses 21%. |
| T-9 | two strategies long gold count as one bet | Counted once, against the stricter tier. |
| T-10 | long and short on the same symbol are not grouped | |
| T-11 | EURUSD long and GBPUSD long count as one bet | Configured group. |
| T-12 | a tier taken from a backtest is marked provisional | |
| T-13 | drawdown is measured on equity and catches a dip that recovers | **Moved** from `agents.test.ts` with `maxDrawdownPctFromEquity`. |

### 4.3 Safety moves (task 2.3)

File: `safety/safety.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| M-1 | pausing a bot is accepted | |
| M-2 | each tightening in the table is accepted | Table: lower lot, lower risk %, lower daily trades, lower daily loss %, lower max spread, higher cooldown, higher minimum reward:risk. |
| M-3 | each loosening in the table is refused | The same table, reversed. |
| M-4 | a change that tightens one field and loosens another is refused whole | Nothing applied. |
| M-5 | a field not in the table is refused | Unknown means no. |
| M-6 | 500 random changes: every one that is accepted is tighter | Seeded random, so a failure can be repeated. |
| M-7 | every safety move writes an inbox item and a trace | |
| M-8 | only three places in the code may save a strategy without a request from you | Scans `server/src` for callers of `strategies.save`: allowed are the API handler, `ChatService.approve` / `Evolver.promote`, and `applySafetyMove`. A new caller fails the test. |
| M-9 | an approved proposal is still needed for everything else | "nothing is applied automatically" in `learning.test.ts` stays as it is. |

### 4.4 Usage, call cap, digest (task 2.4)

Files: `chat/usage.test.ts`, `digest/digest.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| U-1 | usage is grouped by day and by agent | |
| U-2 | the 41st unattended call in a day is refused | |
| U-3 | your own chat messages do not count toward the cap | |
| U-4 | the cap resets at the next UTC day | `fakeClock`. |
| U-5 | "Not logged in" from the CLI writes one inbox item and stops calls for the day | Uses the same error shape as `parseCliOutput`'s test. |
| U-6 | the digest text is built from the numbers | Fixed input, exact expected text. |
| U-7 | if the model call fails, the digest still arrives from the template | |
| U-8 | the digest leaves out test strategies | |

### Phase 2 checks by hand

1. Testboard shows each keeper with a stage and a sentence you understand.
2. Set the top tier cap very low, let a bot signal. The order is blocked and the log says why.
3. Run the paper replay on a keeper. It finishes in minutes and matches the backtest.
4. Log out of the Claude CLI. One Inbox item appears and nothing else changes.

---

## 5. Phase 3 tests

### 5.1 One learning system (task 3.1)

| ID | Test name | What it proves |
|---|---|---|
| L-1 | every old lesson is carried over, and one with no market becomes display-only | Count in = count out. |
| L-2 | package.json has no agents:weekly script and nothing imports the deleted files | |

### 5.2 Lesson ledger (task 3.2)

File: `learning/learning.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| L-3 | a gold lesson never reaches a EURUSD strategy | **The headline test.** 5 trusted outcomes on XAUUSD 1m; retrieval for EURUSD 1m returns nothing. |
| L-4 | a 1-minute lesson never reaches a 5-minute strategy | |
| L-5 | the market state comes from the saved snapshot: volatility, trend and spread, each low, mid or high | Bucket edges worked by hand. |
| L-6 | an outcome resting on 29 trades is ignored; 30 counts | Evidence floor. |
| L-7 | four agreeing outcomes are not a lesson; five are | Was 3. |
| L-8 | five outcomes from 60 days ago no longer count as trusted | Half-life 14 days: weight 0.5^(60/14) = 0.05 each. |
| L-9 | new outcomes that disagree take trust away | |
| L-10 | two trusted lessons that disagree on the same setting give "hold", and no proposal can be made on that setting | |
| L-11 | there is no all-markets lesson and no lesson shared between agents | **Rewrites** "only repeated, consistent results become notebook lessons", which today asserts the opposite. |
| L-12 | 200 lessons in scope give 10 rows in the prompt, in the same order every time, under the size cap | |
| L-13 | the prompt carries lesson rows, not sentences like "hurt 3 of 4 times" | **Rewrites** "proven lessons and past outcomes reach the agent prompt". |
| L-14 | a change is scored from demo trades made after approval | Not from a second backtest. |
| L-15 | the backtest that argued for a change can never score it | |
| L-16 | the statistics match values worked out by hand | Beta mean and interval, bootstrap with a seeded random source. |

### 5.3 Theory and test (task 3.3)

| ID | Test name | What it proves |
|---|---|---|
| P-1 | a proposal cannot be created without a surviving test | The type can only be built by passing, the same trick as `EligibleStrategy` in `youtube/gate.ts`. |
| P-2 | the test bars never overlap the bars the theory was formed on | Like the existing validation-window test. |
| P-3 | a theory that meets its own "this would prove me wrong" line is dropped and recorded as an attempt | |
| P-4 | a strategy with one change waiting to be scored gets no second change | |
| P-5 | one weekly run handles at most 3 strategies | `fakeClock`. |
| P-6 | every proposal stores its seven checklist answers and the lessons it used | |
| P-7 | with Claude unreachable the run writes one inbox item and changes nothing | |
| P-8 | auto-evolve goes through the same path | Existing evolve tests keep passing. |
| P-9 | the one-line reason is written after scoring, never before | |

### 5.4 Knowledge (task 3.4)

Files: `knowledge/knowledge.test.ts`, `youtube/youtube.test.ts`

| ID | Test name | What it proves |
|---|---|---|
| K-1 | neighbours and two-step paths are found | Node and edge tables. |
| K-2 | a contradicted link is closed, not deleted | History stays. |
| K-3 | a strategy from a video arrives as an idea, at the backtest stage, with your risk settings | Lot size from the video is discarded. |
| K-4 | a video strategy cannot enter rotation | `submitToRotation` is gone; its tests are replaced by K-3 and gate test G-2. |
| K-5 | a book note keeps the concept and the page number, not the paragraph | Stored text is capped; the pasted input is deleted. |
| K-6 | an idea's status comes from measured outcomes only | "untested", "supported by N", "contradicted". |
| K-7 | a book can never change a lesson's score | |
| K-8 | at most 5 knowledge items reach a prompt | |

### Phase 3 checks by hand

1. Read one proposal's trace in the Inbox. You can follow why it was made.
2. Paste one YouTube link. An idea appears on the Testboard at "backtest", not as a running bot.

---

## 6. Existing tests this plan changes on purpose

| File | Test | What happens | Why |
|---|---|---|---|
| `chat/chat.test.ts`, `learning/learning.test.ts` | fixtures `existing()` and `base()` | Target changes from 200 to 300 points (stop stays 200). | A 1:1 strategy is no longer valid. No assertion changes. |
| `chat/chat.test.ts` | routing picks the matching agent… | Replaced by H-1 to H-3. | Keyword routing is removed. |
| `chat/chat.test.ts` | backtest results reach the prompt only for performance questions… | Replaced by H-6 and H-8. | The keyword trigger is removed. |
| `chat/chat.test.ts` | backtest trigger recognises loss/result phrasing… | Rewritten as H-8 with the same sentence. | The regression it guards must stay guarded. |
| `learning/learning.test.ts` | only repeated, consistent results become notebook lessons | Rewritten as L-7 and L-11. | Today it asserts that hurt lessons are shared with other agents. That is the leak being removed. |
| `learning/learning.test.ts` | proven lessons and past outcomes reach the agent prompt | Rewritten as L-13. | Sentences are replaced by rows. |
| `learning/learning.test.ts` | scoreDue waits for age, then scores from the forward window | Updated for L-14. | Scoring moves to demo trades. |
| `agents/agents.test.ts` | 7 rotation tests | File deleted with `rotation.ts`. The drawdown test moves to T-13; "a written record is immutable" becomes G-9. | Weekly rotation is merged into the learning loop. |
| `agents/lessons.test.ts` | all | Reviewed test by test in the Phase 3 pull request: each is kept, moved to the ledger tests, or listed as dropped with a reason. | I have not read this file yet. |
| `youtube/youtube.test.ts` | tests of the synthetic gate and rotation hand-off | Replaced by K-3, K-4 and G-2. | The synthetic gate is removed. |

Tests that must **not** change: "Risk Guard can tighten but never loosen", "a proposed new strategy is validated, then only saved after approval", "the critic can be chatted with but can never propose actions", "auto-evolve is off by default", "auto-evolve never keeps a variant that loosens risk or fails unseen data", and everything in `daily.test.ts`, `reconcile.test.ts` and `mt5mcp.test.ts`.

---

## 7. What the tests cannot tell you

- Whether a strategy makes money. Tests prove the rules are applied. Only demo trades show an edge, and 100 trades is thin evidence.
- How your broker fills orders. The MT5 bridge is faked in tests; the hand checks cover the real one.
- Whether the Claude CLI stays logged in. Test U-5 proves the app copes when it is not.

## 8. Count

| Phase | New or rewritten tests |
|---|---|
| 1 | 11 tests in the foundation items (T-0.2, T-0.4, T-0.5, T-0.6) plus 68 listed tests |
| 2 | 45 listed tests |
| 3 | 33 listed tests |
| **Total** | **157 on top of today's (about 172 by your notes)** |

---

## Update 8 October 2026 — AG: agent service (14 new tests, total 171)

| ID | Test |
|---|---|
| AG-1 | Graph runs end to end with a fake model and no network |
| AG-2 | Doctor says "nothing wrong": run ends with a note, no proposal |
| AG-3 | Tester fails its own test: theory dropped and noted, no proposal |
| AG-4 | Critic objects: sent back to Optimizer, and stops after 2 rounds |
| AG-5 | Risk Guard refuses a change that loosens risk |
| AG-6 | More than 8 model calls in a run is refused |
| AG-7 | A second run on the same strategy is refused while one is active or a change awaits scoring |
| AG-8 | Dossier for a gold strategy contains no EURUSD lessons or notes |
| AG-9 | Dossier respects the size limit |
| AG-10 | Agent key works on the five agent routes and nothing else (start bot, approve, edit strategy all return 403) |
| AG-11 | A proposal from the service goes through the same validation, gates and Inbox as any other |
| AG-12 | Two trusted lessons that disagree end the run with "hold" |
| AG-13 | Service down: server keeps trading and shows one Inbox item |
| AG-14 | A run can be read back step by step ("Why was this proposed?") |

The existing "second door" test (only `applySafetyMove` may apply without approval) is extended to cover `/api/agent/*`.
