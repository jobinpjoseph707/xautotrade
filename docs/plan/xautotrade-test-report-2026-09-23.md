# XAutoTrade — full functional test, 2026-09-23

Method: copied server + mobile source into a Linux cloud workspace, `npm ci`, ran the real server in PAPER mode (synthetic candles) with a fake Claude CLI (`CHAT_CLAUDE_COMMAND` → script that returns canned agent replies and logs every prompt + argv). Real MT5 order placement was NOT exercised (needs the Windows box + MT5 terminal).

## Results

- **Unit tests** (`npm test`, Linux, incl. MT5 bridge fake): **147 / 147** (146 + 1 new); **151 / 151** after the dashboard fix; **159 / 159** after the trade-accounting fix.
- **Server end-to-end API test**: **127 / 127**, sections:
  A basics & security (health, 401 on missing/wrong key, ?key=, catalog, account=demo, symbols, spec, quote, candles, settings whitelist, debug endpoint in paper mode) ·
  B strategy CRUD & validation · C backtesting (accounting reconstructs balance, no overlapping trades, spread stress, history) ·
  D bots (start, snapshot, positions, close-all, stop, panic, activity log incl. bot_stop name/duration/P&L, client logout log) ·
  E WebSocket (initial push, live bot/log push, 4001 on bad key) · F chart levels (range GET/POST, custom, status, clear manual/all) ·
  G chat agents (5 agents + model labels, AGENT_MODEL_CRITIC override passed as `--model haiku`, auto-routing, create→approve, double-approve refused, role whitelist, malformed JSON, Risk Guard tighten-only, reject, backtest trigger vs greeting, expired-login message) ·
  H unseen-data validation (10× lot on a losing strategy held back and recorded `blocked`; windows never overlap; pending proposal survives restart and is approvable) ·
  I scoring (nothing before 3 days; scored with reasons after; nothing pending after 21 days) ·
  J notebooks (lesson after 3 consistent results, shared hurt lessons, user notes add/remove, prompt injection of notebook + recent outcomes, markdown mirror), critic memory, scoreboard (per agent, per model, critic accuracy, trend) ·
  K/M auto-evolve (off by default, interval/testDays bounds, loosening variant refused, insufficient-evidence variant held back, nothing auto-applied, one variant at a time, not judged early, judged winner on forward bars: cooldown 1→15 on fast scalp −3.76% → −0.69%, one-tap promote, promote twice refused, promotion enters outcome memory, activity log) ·
  VALIDATION_MODE=warn and CRITIC_MODE=rules paths; approved-anyway failing update later scored HURT (validation's prediction confirmed).
- **Mobile**: `tsc --noEmit` clean; `expo export --platform web` bundles. **Browser UI test (Playwright, web build) 24 / 24**: connect, dashboard, strategies, backtest screen, agents chat → proposal card with critic → approve, Learning tab (scoreboard, auto-evolve, promoted variant, notebooks, add note, Score now), Lines, Activity, Profile, Stop-all and Log-out via web confirm, zero console errors.

## Bug found and fixed — presets on gold never traded

`ema-pullback` (20-pt spread cap), `bollinger-fade` (18) and `macd-momentum` (40) keep EURUSD-sized caps; gold's spread is ~30–35 pts, so every entry was blocked (backtest: 0 trades in 3000 bars). Fix: `fitSpreadCap()` in `engine/presets.ts` raises the cap to 2.5× the symbol's typical spread on preset creation (`POST /api/strategies`), never lowers it, leaves 0 (off) alone; `agents/weekly.ts` uses the same helper. Only affects newly created strategies.

## Dashboard mismatch (fixed)

Root causes: (1) MT5 bar/tick times are broker server time (UTC+3) labelled UTC → "last bar 9:00 PM" at 6 PM IST; (2) bot cards never showed floating P&L or the open position; (3) "Trades today"/"Realised" lived only in memory and reset on every server restart (and re-based the daily loss cap).

Fixes: `live/daily.ts` (`estimateServerOffset`, `dailyStatsFromLogs`, UTC day helpers); runner snapshot `lastBarTime` in real UTC + `serverOffsetMinutes` + `floatingProfit`; counters rebuilt from the trade log on start; day-start equity persisted per account + UTC day (`dayStartEquity:<broker>|<server>|<name>:<day>`, reset if >50% away from equity = deposit/reset). Dashboard bot cards show Floating + one row per open position.

## Realised / trades-today wrong (fixed, verified on the live demo account)

Symptom: M1 HFT EMA Scalp detail screen said "Trades today 0 / Realised 0.00" while its list showed "11 closed trades · +1.64"; logs had 16 entries but only 11 closes.

Root causes (from the live DB + MT5 deal history):
1. **Closes lost since the 4-second floating refresh was added.** `applyPositions()` replaced the bot's position list before the bar-close tick could compare it, so TP/SL closes between bars were never logged or added to realised. Every close after ~08:40 UTC today was missing.
2. **Other bots' positions booked to the wrong bot.** After placing an order the runner set its list to ALL broker positions (unfiltered); the next sync logged other bots'/manual positions as closed by this bot, sometimes twice (e.g. GBPUSD #10633832393 booked to HFT twice, EURUSD positions of both Gold Quick bots cross-booked).
3. **Closes while a bot is stopped / server restarting were never recorded.**
4. **Detail screen header came from the in-memory bot snapshot** (zero for a stopped bot) while the list came from the log, and "Today" used local midnight vs the server's 00:00 UTC.
5. Realised used the last floating value seen, not the broker's actual result.

Fixes:
- `Broker.getPositionHistory()` (MT5 `history_deals_get(position=…)`, real deal shape pinned in a test): closed?, close price/time, reason (tp/sl/stop_out/bot/manual), profit incl. commission+swap+fee.
- Runner `syncPositions()` records closes from BOTH the tick and the 4s refresh, de-duplicated by a `closedHandled` set; stale refresh snapshots (fetched before the bot's own last order) are ignored; post-entry list filtered to this bot's tag; exit/panic/TP/SL closes all book the broker's real profit.
- `live/reconcile.ts`: for logged entries with no logged close that are no longer open, look up the broker history and log the close at its real (UTC-corrected) time with `source: 'broker_history'`. Runs on bot start and on every detail-screen load.
- `ownCloses()`: when counting, ignore close rows whose comment tag belongs to another strategy and keep one row per position (prefers the broker-history row). Used by the detail endpoint, restart counters and learning demo stats. Old rows are not deleted.
- New `GET /api/strategies/:id/trades?from&to` → opened, closed, wins, losses, realised, open positions + floating from the broker, events (newest first). Detail screen rebuilt on it: header and list always from the same rows, works for stopped bots, "Today" = 00:00 UTC trading day (shown as local time), OPEN/CLOSE badges, "Open now" section, auto-refresh.
- Verified live: after the fix every strategy's opened = closed for today (HFT 16/16, realised +0.56, 9 won / 7 lost; Gold Quick 25/25; New Strategy 3/3; both EMA Pullbacks 1/1), 20 missing closes recovered from MT5 history. Runner scenario script (closes between bars, no double count, foreign positions ignored, stale snapshot ignored, restart recovery): 8/8. E2E 127/127 again.

## Still open

- Real MT5 order path (fill mode) still only provable on the Windows machine.
- M1 HFT EMA Scalp: break-even 20 / trailing start 30 points sit inside gold's spread → `INVALID_STOPS`.
- Percent-risk sizing opened **5 lots** EURUSD (M5 EMA Pullback, 4-pip stop) and 0.83 lots XAUUSD today (+305 / +331 realised) — legal per config, but large; consider a `maxLot` cap.
- `hourUTC` rule operand and backtest dates still use broker server time.
