# XAutoTrade — build notes

Working prototype delivered 2026-08-16. Two packages: `server/` (Node + TypeScript)
and `mobile/` (Expo SDK 57 / RN 0.86 / React 19.2).

## The constraint that shaped everything

MT5 mobile cannot run Expert Advisors — EAs execute only in the desktop terminal.
Automation therefore needs an always-on process holding the broker connection.
Chosen bridge: **MetaApi cloud** (hosts a real MT5 terminal, exposes REST/WS).

Phone = control surface. Server = strategy storage, backtesting, execution.

## Key decisions

- **RPC connection, not streaming.** For M5 bars the round trip is irrelevant next
  to the bar interval, and RPC survives reconnects far better.
- **Import path gotcha:** `metaapi.cloud-sdk`'s default `.` export is a *browser*
  bundle and crashes Node with `window is not defined`. Must import
  `metaapi.cloud-sdk/esm-node`.
- **Paper broker adapter** generates deterministic synthetic candles so the entire
  app (builder, backtester, live runner, positions, P&L) works with no broker
  attached. This is the default mode.
- **One risk module** (`engine/risk.ts`) shared by backtester and live runner —
  sizing, stops, trailing, session gating. Divergence there would make backtests
  meaningless.
- **No navigation library.** Hand-rolled tab shell + two full-screen routes; at
  five screens a router adds dependency surface for nothing.

## Execution model (backtest ↔ live parity)

- Signals evaluated on the close of a *completed* bar; forming bar never read.
- Backtest: signal on bar N fills at bar N+1 open + spread + slippage.
- Candles treated as bid; buys at ask, sells at bid, slippage always adverse.
- Bar containing both SL and TP → assume SL hit first (pessimistic).
- Live runner only touches positions tagged `XAT:<shortId>` in the comment.

## Safety

- Server refuses orders on non-demo accounts unless `ALLOW_LIVE_TRADING=true`.
- Daily loss cap measured on equity, not balance.
- API key required on REST and WebSocket; generated + persisted on first boot.
- Stopping a bot does not close positions — panic button does.

## Verification

34 engine unit tests, all passing. Notable ones:
- RSI checked against the published Wilder worked example (70.53 / 66.32 / 66.55).
- **Look-ahead test**: truncating the candle series must not change any trade that
  closed inside the shared window.
- Accounting: sum of trade net P&L must reconstruct final balance; trades must not
  overlap.
- Each risk gate (daily loss, daily trades, session, weekday, spread) asserted to
  actually gate.

Server + mobile both typecheck; app bundles clean (707 modules via `expo export`).

## Sanity signal

The three presets *lose* money on synthetic random-walk data (PF 0.5–1.0). That is
correct behaviour: a random walk has no edge and costs eat it. An honest backtester
should show this.

## Known limits

Single position per strategy; trailing updates per bar not per tick; market orders
only (no pending); commission not exposed by MetaApi so it is user-entered;
candle-level not tick-level modelling.
