# XAutoTrade — Runbook (jobin's Windows machine)

Operational guide for the working setup. Paths are specific to `C:\Users\jobin`.

## The three things that must be running

1. **MetaTrader 5 desktop**, logged into demo `<demo-account-redacted>` (MetaQuotes-Demo)
2. **XAutoTrade server** — `npm run dev` in `...\xautotrade\server`
3. **Expo dev server** — `npx expo start` in `...\xautotrade\mobile` (only if using the phone)

The MT5 bridge does NOT need its own window — the server spawns it as a child
process over stdio.

## Daily startup

```
:: Window A
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\server
npm run dev

:: Window B
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\mobile
npx expo start
```

Phone connects to `http://192.168.1.2:4000` with API key
`<API_KEY-redacted>`.

## Key config (`server\.env`)

```env
BROKER=mt5mcp
MT5MCP_TRANSPORT=stdio
MT5MCP_COMMAND=uvx
MT5MCP_ARGS=--from,mcp-metatrader5-server,mt5mcp
MT5MCP_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
MT5MCP_FILL_MODE=ioc
ALLOW_LIVE_TRADING=false
```

`.env` changes need a full server restart — auto-reload doesn't pick them up.

## Diagnostic URLs

- Health: `/api/health`
- Account: `/api/account?key=...`
- Candles: `/api/candles/EURUSD?timeframe=5m&limit=5&key=...`
- Bridge tool list: `/api/debug/tools?key=...`
- Raw tool call: `/api/debug/mcp?name=copy_rates_from_pos&symbol=EURUSD&timeframe=5&start_pos=0&count=5&key=...`

The debug endpoint allows read-only tools only; it cannot place trades.

## Environment facts worth remembering

- **Expo pinned to SDK 54** (`expo ~54.0.36`, react 19.1.0, RN 0.81.5) to match
  the user's Expo Go client 54.0.8. Running `npm install expo@latest` breaks it —
  npm publishes ahead of the Play Store client.
- `uv` installed at `C:\Users\jobin\.local\bin` — needs a fresh terminal for PATH.
- Firewall rule needed for phone access:
  `netsh advfirewall firewall add rule name="XAutoTrade" dir=in action=allow protocol=TCP localport=4000`
- `C:\Users\jobin\mt5mcp\` is a leftover from the abandoned HTTP-transport
  approach. Unused.

## Bugs found and fixed against the real bridge

1. `account_info` → real name is **`get_account_info`**
2. `initialize` requires a `path` arg; MT5MCP_TERMINAL_PATH supplies it
3. **FastMCP wraps list returns** as `{result: [...]}` (dicts come through bare).
   Not unwrapping this caused "broker returned only 0 candles"
4. **Timestamps are ISO-8601 strings**, not epoch seconds. `Number(t) * 1000`
   produced NaN — the dangerous one, since it fails silently
5. Backtest **spread override was ignored** because MT5 candles carry their own
   per-bar `spread` field which took precedence

Lesson: the test fixture had been written from assumptions, so tests passed while
reality failed. It now mirrors the real bridge's serialisation exactly (wrapped
lists, ISO times) and reproduces each bug before the fix.

## Status

- 53 tests passing; server + mobile typecheck clean
- Data path proven end-to-end against the real demo account
- **Order placement still unproven** against the live broker — first real order
  will reveal whether `type_filling: ioc` is accepted; fall back to `fok` then
  `return` via MT5MCP_FILL_MODE
