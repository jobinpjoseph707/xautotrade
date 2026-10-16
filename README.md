# XAutoTrade

Build, backtest and run MetaTrader 5 scalping strategies from your phone or browser. **Demo accounts only.**
Nothing here promises a profit; most strategies lose money, and the tool exists to find that out cheaply.

## Why there is a server

The MT5 mobile app cannot run automated strategies; only the MT5 desktop terminal can. So a small server holds the
connection to your account, stores strategies, backtests them and runs the bots. The app is the control surface.

```
 Phone / browser  ──HTTP + WebSocket──►  Server (Node)  ──►  MT5 desktop terminal  ──►  broker (demo)
   Expo app                              strategies, backtests,    via the mt5mcp bridge
                                         bots, Inbox, agents       (or MetaApi, or paper mode)
```

Three broker modes, chosen by `server/.env`: **paper** (default: simulated prices, nothing can reach a broker),
**mt5mcp** (a local MT5 terminal; see `RUNBOOK.md`) and **metaapi** (a cloud MT5).

## What is in the app

| Tab | What it is for |
|---|---|
| Dashboard | Account, running bots, open positions, today's result. One button: stop everything. |
| Inbox | **Everything that needs you**: proposals to approve, errors, losing streaks, stalls, safety stops. The one tab to open each day. |
| Strategies | Create, edit, backtest, start/stop. The chat button on a row opens a chat about that one strategy (Tune, Diagnose, Tighten risk, Critique). |
| Testboard | Which stage each strategy has reached. |
| Journal | Every trade, filterable, exportable to CSV. Test strategies are left out of the totals. |
| Agents | General questions to the AI agents. Agents only *propose*; nothing changes until you tap Approve. |
| Settings | Server connection and account. |
| Help | What to do each day, and what to do when something goes wrong. |

## Run it

```bash
cd server && npm install && npm run dev      # starts in paper mode
npm run key                                  # shows the API key (once, on request)
cd ../mobile && npm install && npx expo start
```

Scan the QR code with Expo Go, or press `w` for the browser. On the connect screen enter `http://<this-computer's-IP>:4000`
and the key. The phone must be on the same Wi-Fi (or Tailscale; see `TAILSCALE.md`). For a real MT5 demo account follow
`RUNBOOK.md`.

The API key is not printed in full at start-up, is never accepted in a web address (header only; the live feed `/ws` is
the one exception), and web pages may only call the API from this computer, your home network or Tailscale
(`CORS_ORIGINS` in `.env` adds more). `npm run key -- rotate` replaces it.

## Rules the code enforces

These are limits, not suggestions. A strategy can only make them stricter.

- Every strategy needs a **stop-loss and a take-profit**, and the target must be at least **1.5 × the stop**.
- No entry when the spread is more than **15% of the stop distance**.
- **Flat before 21:45 UTC and over the weekend**: positions are closed and nothing opens, in backtests and live alike.
- Default maximum lot is **0.5** (0.2 on gold). Percent-risk sizing can never exceed it.
- Each strategy has a daily loss cap. On top of that an **account-level cap** (3% of the day's starting equity, measured on
  equity so open losses count) pauses every bot and closes the positions the bots opened. It fires once a day and tells
  you in the Inbox. Positions you opened by hand are never touched.
- After a **server outage longer than 30 minutes**, bots stay paused and the Inbox asks. A bot paused by safety never
  restarts by itself.
- A bot with **no new bar for 3 × its timeframe** while the market is open raises a stall card.
- Agents cannot mark their own strategy as a test, skip a stage, or loosen a limit (Risk Guard may only tighten).
- `ALLOW_LIVE_TRADING` is `false`. While it is false the server refuses orders on any account that is not a demo.
  No code promotes a strategy to live.

## How the engine works

A strategy is JSON: indicators (SMA, EMA, WMA, RSI, ATR, MACD, Bollinger, Stochastic, ADX, CCI), entry and exit rule
groups, and a risk block. Signals are evaluated on the close of a completed bar; a signal on bar N fills at bar N+1's
open plus spread and slippage. When one bar contains both stop and target, the stop is assumed to hit first. The backtester
and the live runner share the same risk and rule code (`server/src/engine/risk.ts`, `rules.ts`), so they agree by
construction. MT5 stamps candles in broker server time; the engine subtracts the measured offset so sessions, the flat
window and the daily reset use real UTC.

## Tests

```bash
cd server && npm test && npm run typecheck     # unit tests; temporary in-memory database, never your real one
cd mobile && npm test && npx tsc --noEmit
cd e2e && npm install && npx playwright test   # browser tests, desktop and phone size, against a paper-mode server
```

Tests never write to your real database. A pull request is checked by the same commands (`.github/workflows/ci.yml`).

## Layout

```
server/src/engine/    indicators, rules, risk, backtest (pure, tested)
server/src/live/      bot runner and manager (heartbeat, outage handling)
server/src/safety/    daily loss cap, stall watch
server/src/inbox/     the Inbox: cards, one-time actions, feed from bot logs
server/src/chat/      agents, proposals, per-strategy chat and what-if backtests
server/src/learning/  outcome memory, critic, unseen-data validation
server/src/broker/    paper, mt5mcp and MetaApi adapters
server/scripts/       cleanup, rank, key
mobile/               Expo app (src/screens, src/logic = pure, tested rules)
e2e/                  Playwright tests
docs/plan/            the plan and test plan this work follows
```

## Known limits

- One position per strategy at a time; entries are market orders; trailing stops update once per bar.
- Backtests use the candles the broker returns (bid-only, no tick data) and flatter live results.
- Conversations with the strategy chat are kept in memory and reset when the server restarts.
- The daily-loss cap compares equity with the day's first reading; a deposit or withdrawal during the day skews it.

This is not financial advice. Automated trading can lose money faster than manual trading.
