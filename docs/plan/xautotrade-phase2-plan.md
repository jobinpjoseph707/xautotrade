# XAutoTrade — Phase 2 plan and Phase 1 as-built

Written 11 October 2026 from a direct read of `phase1/1.9-no-silent-paper` (head `d27f3b6`, 21 commits ahead of `main`). Demo account only. No profit is promised anywhere in this plan.

This replaces the Phase 2 section of `xautotrade-plan-3-phases.md`, which is otherwise unchanged. Test IDs refer to `xautotrade-test-plan.md`.

---

## 1. Where Phase 1 actually stands

The 9 October status doc covered tasks 1.1 to 1.7. Five more pieces of work have landed since, so the real picture is:

| Task | What shipped | PR / commit |
|---|---|---|
| 1.1 | Test foundations, 8-tab shell, stub routers, CI | #2 |
| 1.2 | Strategy rules: stop required, 1.5x target, spread-to-stop, flat window, real-UTC hours | #3 |
| 1.3 | Cleanup and rank scripts, test strategies out of totals | #4 |
| 1.4 | Inbox replaces Activity | #5 |
| 1.5 | Chat on each strategy, what-if backtests | #6 |
| 1.6 | Daily loss cap, outage handling, stall watch, key hygiene | #7 |
| 1.7 | Help tab as an action guide | #8 |
| 1.8 | Help shows which markets are trading now | #9 |
| 1.9 | Refuses to start with no broker instead of using fake data; `npm run salvage` for a damaged database | #10 |
| extra | Strategies > From YouTube: video to strategy, backtested on real MT5 history, Inbox proposal, Strategist fallback for narrated videos | `1d4ffd2`, `bfcb844`, `38c46b4` |
| extra | Every displayed time in Indian Standard Time (UTC+5:30) | `0ab8bbe` |
| extra | Market status: a stopped price may not teach the broker clock; a price stamped in the future is never "open" | `2b87f78`, `d27f3b6` |

Counts on the branch today: **server 287 tests, mobile 37, e2e 22 (2 skipped by design)**, both type checks clean, CI green on every commit.

### Still to be done by hand

1. **Merge the nine pull requests.** All are mergeable with no conflicts. Merge #2 through #10 in order, using "Create a merge commit" — squashing breaks a stacked set. GitHub retargets each next PR to `main` as you go.
2. **Rotate the API key.** The old one is in git history. `npm run key -- rotate` in `server/`.
3. **Run the cleanup and rank scripts** with MT5 open, and pick the keepers.
4. **Raise "Bollinger Fade"'s target** to at least 1.95x ATR, or it stays refused by the 1.5:1 rule.
5. **Phase 1 hand checks** from the test plan: refused save with target below stop, one demo order at the right lot, a 40-minute outage leaving bots paused with an Inbox card.

### Known open issues carried into Phase 2

- **Six bots run, none trade.** Not yet explained. Section 2 gives the most likely cause.
- The Help tab still carries the sentence "In paper mode every market is simulated and always open" while on a real broker.
- The `develop` branch exists at `f5decb4` but nothing is based on it. Either adopt it or delete it.
- Five of the six older strategies remain unproven (profit factor below 1).

---

## 2. What changed in the plan, and why

A fault found on 9 October reorders Phase 2.

The app works out the broker's clock offset by comparing a quote's timestamp with the current time, accepting any value within three minutes of a half-hour boundary. Against a **frozen** quote — which is what a closed market returns — that comparison drifts into the next boundary down every thirty minutes, so the offset silently decays: 3h, 2h, 1.5h, 1h, 0.5h, 0. Replaying the broker's real tick values through the real estimator reproduces this exactly.

Two consequences, one fixed and one not:

- **Fixed.** The Help markets board read closed forex markets as open, because the decayed offset put their last tick 34 minutes in the future and the freshness check was one-sided. Commits `2b87f78` and `d27f3b6`.
- **Not fixed.** `live/runner.ts` runs the same estimator on its own quotes and writes the result to settings, where backtests reuse it. The same decay therefore reaches the trading engine, where the offset decides the hour of day used for session windows. A bot asking "am I inside my trading hours?" can be asking against a clock that is wrong by hours. **This is the leading candidate for six bots running and never trading**, and it is unproven until measured.

Phase 2 is built on measuring strategies: unseen bars, session behaviour, seven-day demo windows. Every one of those depends on the broker clock being right. So a new task **2.0** goes in front of the gate engine. Nothing else in Phase 2 changes in substance; only the order.

---

## 3. Phase 2, slice by slice

Each slice is a branch, tests green before it is pushed, no slice started before the one above it is pushed.

### 2.0 One broker clock, learned only from prices that move

**Why first:** everything Phase 2 measures is timestamped by this clock.

- New `server/src/live/serverClock.ts`: a single tracker, keyed by symbol, that owns the offset. It accepts a quote only when that quote's timestamp has *changed* since the last one it saw for that symbol, so a stopped price can never teach it. An offset confirmed by a moving price survives a closed market; an offset never confirmed is discarded rather than trusted.
- `live/runner.ts` stops calling the estimator directly and reads the shared tracker. Only a confirmed offset is written to settings, so backtests stop inheriting a decayed one.
- The runner snapshot already exposes `serverOffsetMinutes`, which nothing renders today. Showing the clock, and whether it is confirmed, belongs with the Testboard in 2.1c, where the user has a reason to look at it; 2.0 stays server-side.
- **Follow-up inside this slice if it stays small, otherwise 2.1:** `broker/mt5mcp.ts` keeps its own copy of this logic. It is correct as of `2b87f78`, but two implementations of one rule is how this bug happened. Move it onto the shared tracker.
- Tests: CK-1 a frozen quote never changes the offset; CK-2 a moving quote confirms it; CK-3 the real 9 October decay sequence leaves a confirmed offset untouched; CK-4 settings receive only confirmed offsets; CK-5 session-hour evaluation uses the confirmed offset.
- **Done when:** replaying the real closed-market quote sequence leaves the offset at its confirmed value, and a bot's session window is evaluated against the broker's real clock.

### 2.1 Gate engine and Testboard

Split into three pushes, because this is the largest slice.

**2.1a — the engine.** New `server/src/gates/`, evaluating each strategy every 30 minutes and recording every pass and fail. Stages and pass marks as in the three-phase plan: backtest (100 trades, 30 on unseen bars, profit factor 1.2 on the unseen part, still not losing with the spread doubled), paper, demo (7 days and 100 trades), live locked. Each further attempt on the same unseen bars raises the bar by 0.05, five attempts maximum.

Reuse rather than rebuild: `youtube/gate.ts` already has `realGateData()` and `REAL_DATA_GATE`, which fetch real broker candles and refuse to run on fewer than 100. That is the candle source the gate engine should take, and it is why G-2 ("the gate never uses made-up candles") is already satisfied on the YouTube path. Lift it to `gates/` and have YouTube call the shared one.

Tests: G-1 to G-10.

**2.1b — paper replay.** New `server/src/broker/paperReplay.ts` beside `paper.ts`: replays the last three days of real candles through the live runner. This checks the plumbing, not the edge. Tests: G-11, G-12 (the backtest/replay parity test), G-13.

**2.1c — the Testboard screen.** `mobile/src/screens/TestboardScreen.tsx` is a stub today. One card per strategy: stage, progress ("40 / 100 trades"), plain verdict. Moving to the next stage is your tap from the Inbox. Help gains an entry per verdict. Tests: G-14, G-15 (e2e).

### 2.2 Risk tiers

New `server/src/portfolio/`: five tiers set from measured behaviour over the last 30 demo days, not from a strategy's name, rechecked daily. Cap is open risk-to-stop per tier as a share of a 3% account budget; the top tier can never exceed 20%. Enforced in `live/runner.ts` before every order, with blocked orders logged. Same symbol and direction counts as one bet, as do configured pairs. Dashboard gains `mobile/src/components/TierTiles.tsx`. The drawdown helper in `agents/evaluate.ts` moves here with its test. Tests: T-1 to T-13.

### 2.3 Safety moves that apply themselves

New `server/src/safety/applySafetyMove.ts` — the only function allowed to change anything without your approval. It accepts exactly two things: pause a bot, or a change that `gateViolation()` in `agents/propose.ts` confirms is strictly tighter. Everything else throws. Every use writes an Inbox item with OK and Undo. A bot paused by safety stays paused until you restart it. Tests: M-1 to M-9, one of which fails if any new code path saves a strategy without your approval.

### 2.4 Small additions

Token usage panel in Settings from the existing `GET /api/chat/usage`; weekly digest in `server/src/digest/` as a Sunday Inbox item; a daily cap of 40 unattended Claude calls in `chat/backend.ts`. Tests: U-1 to U-8.

**Phase 2 is done when:** every strategy shows a stage and a verdict; an order past a tier cap is blocked and logged; a forged "loosen" safety move is refused in a test; and the broker clock is correct through a weekend.

---

## 4. Branch and merge mechanics

Phase 1 used one pull request per task, stacked. That produced nine open PRs at once, which is more than is comfortable to review. For Phase 2:

- Each slice is still its own branch and its own commit, so any slice can be reverted alone.
- Pull requests are opened **only when you ask**, so the queue stays short.
- Until the Phase 1 stack is merged, Phase 2 commits continue on `phase1/1.9-no-silent-paper`, since `main` does not yet contain Phase 1. Once you merge, the next slice branches from `main` as `phase2/2.x-...`.

---

## 5. Decisions for you

1. **Order.** 2.0 first, as argued above, or straight to the gate engine.
2. **The six silent bots.** Worth measuring before 2.1, since the gates need the answer either way.
3. **`develop`.** Adopt it as the integration branch, or delete it.
4. **Pull requests in Phase 2.** Keep the one-per-slice habit, or push slices and open a single PR per phase.
