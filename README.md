# XAutoTrade

Build, backtest and automate MetaTrader 5 scalping strategies from your phone.

---

## Read this first: why there has to be a server

**The MT5 mobile app cannot run automated strategies.** Expert Advisors execute
only in the MT5 *desktop* terminal. There is no setting, plugin or hidden menu
that changes this — the mobile client simply has no EA runtime.

So automation needs something else to hold the connection to your account. This
project uses **MetaApi**, a cloud service that runs a real MT5 terminal for your
account and exposes it over an API.

```
  Your phone                Your server                   MetaApi cloud        Your broker
┌──────────────┐   HTTPS   ┌──────────────────┐   HTTPS   ┌─────────────┐     ┌──────────┐
│  XAutoTrade  │ ────────► │ strategy engine  │ ────────► │ hosted MT5  │ ──► │  MT5     │
│  (Expo app)  │ ◄──────── │ backtester       │ ◄──────── │ terminal    │ ◄── │  server  │
└──────────────┘    WS     │ live bot runner  │           └─────────────┘     └──────────┘
                           └──────────────────┘
```

The phone is the control surface. The server is where strategies are stored,
backtested and executed. It can run on a laptop, a Raspberry Pi, or a €5 VPS —
but for live trading it must stay online, because that is what watches the market.

---

## What you get

**Strategy builder** — a visual rule editor. Pick indicators, then build entry
and exit conditions from dropdowns: *"ema_fast crosses above ema_slow"*, *"rsi is
below 30"*, *"close is above ema_trend"*. No code.

**Backtester** — bar-by-bar simulation on real historical candles from your
broker, with spread, commission, slippage, stops, targets and trailing modelled.
Equity curve, profit factor, drawdown, expectancy, full trade list.

**Live runner** — the same engine, running against the live feed. Evaluates only
on closed bars, so live behaviour is comparable to the backtest.

**Risk controls, enforced server-side** — percent-of-balance sizing, ATR stops,
R:R targets, trailing stop, break-even, max spread, max positions, cooldown,
max trades per day, **daily loss cap**, session and weekday filters.

**Three M5 scalping presets** to start from: EMA pullback (trend), Bollinger fade
(mean reversion), MACD momentum.

---

## Quick start

### 1. Run the server

```bash
cd server
npm install
npm run dev
```

It prints something like:

```
  XAutoTrade server
  Listening   http://0.0.0.0:4000
  Mode        PAPER (synthetic data — no broker attached)
  Live orders demo accounts only (safe default)
  API key     4f3c9b1e2a...
```

With no MetaApi credentials it starts in **paper mode**: realistic simulated
prices, a simulated account, everything in the app functional. Nothing can reach
a broker. This is the right place to learn the tool.

Find your machine's LAN address (`ipconfig` on Windows, `ifconfig | grep inet`
on macOS/Linux) — you need it in step 2.

### 2. Run the app

```bash
cd mobile
npm install
npx expo start
```

Scan the QR code with **Expo Go** on your phone. On the connect screen enter
`http://<your-computer-ip>:4000` and the API key the server printed.

> Phone and computer must be on the same Wi‑Fi. `localhost` will not work — that
> would mean the phone itself.

### 3. Try it

1. **Strategies → New** → pick *M5 EMA Pullback Scalp* → Create.
2. **Backtest** → Run. Read the equity curve and the profit factor.
3. Tweak rules or risk in the editor, save, backtest again.
4. **Start** the bot. Watch it on the Dashboard and in Activity.

---

## Connecting a real MT5 account

1. Sign up at [metaapi.cloud](https://metaapi.cloud) and create an **API token**.
2. Add your MT5 account there (broker server name, login, investor or master
   password). Use a **demo account**.
3. Copy the account id MetaApi assigns.
4. In `server/`, copy `.env.example` to `.env` and fill in:

```env
METAAPI_TOKEN=your-token
METAAPI_ACCOUNT_ID=your-account-id
METAAPI_REGION=new-york
```

5. Restart the server. It now says `Mode  METAAPI (live MT5 bridge)`.

The server **refuses to place orders on a non-demo account** until you explicitly
set `ALLOW_LIVE_TRADING=true`. That switch exists so going live is a deliberate
act, never an accident.

---

## How the engine works

### Rules

A strategy is JSON. Conditions compare two operands:

| Operand | Meaning |
|---|---|
| indicator | a line of a computed indicator (`macd.signal`, `bb.upper`) |
| price | `open` / `high` / `low` / `close` / `hl2` / `hlc3` / `ohlc4` |
| number | a constant |
| spread | the current spread in points |
| hour (UTC) | the bar's hour, for time-of-day rules |

Any operand can be shifted back N bars, which is how `crosses above` and
`has risen for N bars` are expressed without special-case code.

Operators: `is above`, `is below`, `is at or above`, `is at or below`,
`crosses above`, `crosses below`, `has risen for`, `has fallen for`.

Conditions in a group are joined by AND or OR.

### Indicators

SMA, EMA, WMA, RSI, ATR, MACD, Bollinger Bands, Stochastic, ADX/DMI, CCI.
Every series is aligned to the candle array with `null` during warm-up, so an
indicator that has not warmed up makes its condition false rather than throwing.

### Execution model (backtest and live agree by construction)

- Signals are evaluated on the **close of a completed bar**. The forming bar is
  never read.
- In the backtest, a signal on bar *N* fills at bar *N+1*'s open, plus spread and
  slippage. No look-ahead — there is a unit test that truncates the candle series
  and asserts earlier trades are byte-identical.
- Candle prices are treated as bid. Buys fill at ask, sells at bid, both pushed
  one slippage increment against you.
- When a bar contains both the stop and the target, the **stop is assumed to hit
  first**. The intra-bar path is unknowable, so the simulation takes the
  pessimistic branch.
- Position sizing, stop placement, trailing logic and session gating are the same
  module in both paths (`server/src/engine/risk.ts`).

### Safety behaviour

- The bot only touches positions it opened, tagged with an `XAT:` comment.
  Anything you open by hand in MT5 is left alone.
- Stopping a bot does **not** close its positions — it stops opening new ones.
  Use *Close all* or the Panic button to flatten.
- The daily loss cap is checked against equity, not balance, so floating losses
  count.
- The API is protected by a key. The WebSocket checks it too.

---

## Testing

```bash
cd server
npx tsx --test src/engine/engine.test.ts   # 34 tests
npm run typecheck

cd ../mobile
npm run typecheck
```

The engine tests cover indicator values against published reference data
(the Wilder RSI worked example), rule-evaluator edge cases, position sizing
arithmetic, and backtest invariants: accounting consistency, non-overlapping
trades, stop/target distances, look-ahead freedom, and each risk gate actually
gating.

---

## Project layout

```
server/
  src/engine/       indicators, rule DSL, risk, backtester   ← pure, tested
  src/broker/       MetaApi adapter + paper adapter
  src/live/         bot runner and manager
  src/api/          REST routes
  src/store.ts      SQLite persistence
mobile/
  src/api.ts        typed client + reconnecting WebSocket
  src/store.tsx     app state
  src/screens/      dashboard, strategies, rule builder, backtest, activity
  src/components/   UI kit and the equity chart
```

---

## Going live — a realistic checklist

Scalping M5 is the hardest place to make automation work, because costs are a
large fraction of the edge. Before real money:

1. **Backtest across regimes.** 20,000 bars minimum, and re-run with the spread
   override raised to 2–3× your broker's average. If the edge dies, it was never
   an edge — it was a cost artefact.
2. **Forward-test on demo for at least a month.** Live spread behaviour around
   news and the session open is not in the historical data.
3. **Host the server somewhere that stays up.** A laptop that sleeps is a bot
   that stops mid-position.
4. **Set the daily loss cap low** — 1–2%. It is the only control that limits a
   bad day.
5. **Understand every rule you enable.** The presets are examples of the DSL, not
   recommendations.

None of this is financial advice, and I am not a financial adviser. Automated
trading can lose money faster than manual trading, including more than you
deposit on leveraged accounts. The backtester is deliberately pessimistic and
still flatters live results.

---

## Known limits

- One position per strategy at a time (`maxOpenPositions` is enforced, but the
  runner manages a single position; hedging multiple entries is not implemented).
- Trailing stops update once per bar, not per tick. On M5 that is a 5-minute
  granularity — fine for the strategies here, not for tick-scalping.
- Pending orders (limit/stop entries) are not implemented; entries are market
  orders.
- Commission is not reported by MetaApi, so backtests use the value you enter.
- Backtests run on the candle data your broker returns through MetaApi, which is
  usually bid-only M1+ — no tick-level modelling.
