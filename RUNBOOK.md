# XAutoTrade — Runbook

Everything you type, where you type it, and what has to be open. Written for
**this** machine (`C:\Users\jobin`), not generic instructions.

---

## 1. What has to be running

Three things, all on this PC. If any one stops, the bot stops.

| # | What | Where | Can I close it? |
|---|---|---|---|
| 1 | **MetaTrader 5 desktop**, logged into demo `111189134` | its own window | **No** — the bridge reads prices from it |
| 2 | **XAutoTrade server** (`npm run dev`) | Command Prompt window A | **No** — this is the bot |
| 3 | **Expo dev server** (`npx expo start`) | Command Prompt window B | Only if you don't need the phone app right now |
| 4 | **XATLevels EA attached**, smiley face green | on an MT5 chart | Only if you want chart lines drawn |

Item 4 fails silently: `/api/health` cannot see it, and a chart with no EA looks
exactly like a chart whose EA is broken. The **Lines** tab in the app shows which
half worked — server wrote the file, versus MetaTrader drew it.

You do **not** need a separate window for the MT5 bridge. The server launches it
itself as a hidden child process. (An earlier version needed one — it doesn't now.)

```
Your phone (Expo Go)
      │  Wi-Fi — http://192.168.1.2:4000
      ▼
Window A: XAutoTrade server ──spawns──► mt5mcp bridge (hidden)
                                              │
                                              ▼
                                    MetaTrader 5 desktop
                                              │
                                              ▼
                                     MetaQuotes-Demo broker
```

---

## 2. Daily startup — the routine

**Step 1 — Open MetaTrader 5.** Log into demo account `111189134`. Leave it open.

**Step 2 — Open a Command Prompt.** Press `Win + R`, type `cmd`, press Enter.
Then paste:

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\server
npm run dev
```

Wait for:

```
  Listening   http://0.0.0.0:4000
  Mode        MT5-MCP (local bridge, spawned via uvx)
  Live orders demo accounts only (safe default)
  API key     348bc1189c0347d2ffc1a85d6ab26179
```

**Leave this window open.** Minimise it, don't close it.

**Step 3 — Confirm it can see your account.** Open this in your browser:

```
http://localhost:4000/api/account?key=348bc1189c0347d2ffc1a85d6ab26179
```

You want `"broker":"MetaQuotes Ltd."` and your balance. If you get an error,
jump to section 6.

**Step 4 — Open a SECOND Command Prompt** (`Win + R` → `cmd` again) for the app:

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\mobile
npx expo start
```

A QR code appears. **Leave this window open too.**

**Step 5 — On your phone**, open **Expo Go** and scan the QR code.
If the app asks to connect:

| Field | Value |
|---|---|
| Server address | `http://192.168.1.2:4000` |
| API key | `348bc1189c0347d2ffc1a85d6ab26179` |

Phone must be on the **same Wi-Fi**, not mobile data.

---

## 3. Every command, and what it does

### Server (window A) — run from `C:\Users\jobin\Downloads\xautotrade\xautotrade\server`

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\server
```

| Command | What it does | When |
|---|---|---|
| `npm run dev` | Starts the server; auto-restarts when code changes | Every session |
| `npm install` | Installs/updates dependencies | After I send new files that add a package |
| `npm run typecheck` | Checks the code compiles | If something looks broken |
| `npx tsx --test src/engine/engine.test.ts src/broker/mt5mcp.test.ts` | Runs all 53 tests | To verify nothing's broken |
| `Ctrl + C` | Stops the server | End of session |

### Mobile app (window B) — run from `...\xautotrade\mobile`

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\mobile
```

| Command | What it does | When |
|---|---|---|
| `npx expo start` | Starts the app bundler, shows QR code | Every session |
| `npx expo start -c` | Same, but clears the cache first | If the app behaves oddly after an update |
| `npm install` | Reinstalls app dependencies | Rarely |
| `Ctrl + C` | Stops it | End of session |

### One-off / setup commands (you shouldn't need these again)

| Command | What it does |
|---|---|
| `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` | Installs `uv`, the Python runner the bridge needs |
| `uv --version` | Confirms `uv` is installed and on PATH |
| `set Path=C:\Users\jobin\.local\bin;%Path%` | Adds `uv` to PATH for the current window only |
| `netsh advfirewall firewall add rule name="XAutoTrade" dir=in action=allow protocol=TCP localport=4000` | Lets your phone reach the server. **Needs an Administrator Command Prompt** |
| `ipconfig` | Shows this PC's IP address (look for IPv4 under Wi-Fi) |

To open an **Administrator** Command Prompt: press Start, type `cmd`,
right-click **Command Prompt** → **Run as administrator**.

---

## 4. Checking things in the browser

All of these need `&key=348bc1189c0347d2ffc1a85d6ab26179` on the end (already included).

| What you want to check | URL |
|---|---|
| Is the server alive? | `http://localhost:4000/api/health` |
| Can it see my MT5 account? | `http://localhost:4000/api/account?key=348bc1189c0347d2ffc1a85d6ab26179` |
| Is candle data flowing? | `http://localhost:4000/api/candles/EURUSD?timeframe=5m&limit=5&key=348bc1189c0347d2ffc1a85d6ab26179` |
| What are my open positions? | `http://localhost:4000/api/positions?key=348bc1189c0347d2ffc1a85d6ab26179` |
| Recent bot activity / errors | `http://localhost:4000/api/logs?limit=50&key=348bc1189c0347d2ffc1a85d6ab26179` |
| Which tools does the bridge offer? | `http://localhost:4000/api/debug/tools?key=348bc1189c0347d2ffc1a85d6ab26179` |
| Raw reply from any bridge tool | `http://localhost:4000/api/debug/mcp?name=get_account_info&key=348bc1189c0347d2ffc1a85d6ab26179` |
| Draw S/R lines on the chart | `http://localhost:4000/api/levels/range?symbol=XAUUSD&minutes=30&timeframe=5&key=348bc1189c0347d2ffc1a85d6ab26179` |
| Did the levels file get written? | `http://localhost:4000/api/levels/status?key=348bc1189c0347d2ffc1a85d6ab26179` |

The last one is the diagnostic workhorse. Any extra query parameters become the
tool's arguments, e.g.:

```
http://localhost:4000/api/debug/mcp?name=copy_rates_from_pos&symbol=EURUSD&timeframe=5&start_pos=0&count=5&key=348bc1189c0347d2ffc1a85d6ab26179
```

It only allows read-only tools — it cannot place a trade.

**From your phone**, swap `localhost` for `192.168.1.2`.

---

## 5. Config file — `server\.env`

Full path: `C:\Users\jobin\Downloads\xautotrade\xautotrade\server\.env`

Open it with:
```
notepad C:\Users\jobin\Downloads\xautotrade\xautotrade\server\.env
```

Current working settings:

```env
PORT=4000
BROKER=mt5mcp
MT5MCP_TRANSPORT=stdio
MT5MCP_COMMAND=uvx
MT5MCP_ARGS=--from,mcp-metatrader5-server,mt5mcp
MT5MCP_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
MT5MCP_FILL_MODE=ioc
MT5MCP_DEVIATION_POINTS=20
ALLOW_LIVE_TRADING=false
```

**After editing `.env` you must fully restart the server** — `Ctrl + C`, then
`npm run dev`. The auto-reload does not pick up `.env` changes.

`ALLOW_LIVE_TRADING=false` is the safety switch: the server refuses to place
orders on any account that isn't a demo. Leave it false.

---

## 6. Troubleshooting — errors we have actually hit

| Error you see | Cause | Fix |
|---|---|---|
| `'uv' is not recognized` | New PATH not loaded in this window | Close the window, open a fresh one. Or run `set Path=C:\Users\jobin\.local\bin;%Path%` |
| `'tsx' is not recognized` | Dependencies not installed | `npm install` in the `server` folder |
| `EADDRINUSE: address already in use :::4000` | An older server is still running | Find the old Command Prompt and `Ctrl + C`. Or: `netstat -ano \| findstr :4000` then `taskkill /PID <number> /F` |
| `Project is incompatible with this version of Expo Go` | App's SDK doesn't match the phone's Expo Go | Project is pinned to SDK 54 to match your Expo Go 54.0.8. Don't run `npm install expo@latest` — it breaks this |
| `Cannot reach http://192.168.1.2:4000` on the phone | Firewall, or phone on mobile data | Run the `netsh advfirewall` command as Administrator; check phone is on Wi-Fi |
| `No IPC connection` / `MT5 not initialized` | MT5 desktop closed, or terminal path missing | Open MT5 and log in. Check `MT5MCP_TERMINAL_PATH` in `.env` |
| `Unknown tool: 'xxx'` | Adapter calling a tool name the bridge doesn't have | Check `/api/debug/tools` and send me the list |
| `The broker returned only 0 candles` | Was a parsing bug (fixed). If it returns: MT5 has no history for that timeframe | Open a chart for that symbol in MT5, switch to M5, press Page Up a few times to pull history |
| Backtest shows 0 trades | Session filter, spread filter, or too few bars | Raise **Bars of history** to 8000; check Risk → Trading hours; check Max spread isn't below the actual spread |
| Order rejected with a retcode | Broker doesn't accept `ioc` filling | Change `MT5MCP_FILL_MODE` in `.env` to `fok`, then `return`. Restart server after each change |

---

## 6b. Chart lines (XATLevels EA)

One-time setup, already done:

- `XATLevels.mq5` is installed at
  `C:\Users\jobin\AppData\Roaming\MetaQuotes\Terminal\D0E8209F77C8CF37AD8BF550E51FF075\MQL5\Experts\`
- The server writes to `C:\Users\jobin\AppData\Roaming\MetaQuotes\Terminal\Common\Files\xat_levels.csv`,
  which is exactly what the EA's `FILE_COMMON` flag reads. Verified — the paths match.

Each session:

1. MT5 → **F4** to open MetaEditor → open `XATLevels.mq5` → **F7** to compile.
2. Drag **XATLevels** from Navigator onto a chart of the symbol you want lines on.
3. Tick **Allow Algo Trading**; check the smiley top-right is green.
4. App → **Lines** tab → pick symbol and lookback → **Draw lines**.

The EA is draw-only. It cannot place, modify or close an order.

## 7. Shutting down

Order matters a little — stop the bot before closing MT5, so it isn't
mid-order when the terminal disappears.

1. In the app: **Dashboard → Stop all bots & close positions** (if any are running).
2. Window A (server): `Ctrl + C`
3. Window B (Expo): `Ctrl + C`
4. Close MetaTrader 5.

**Important:** stopping a bot does **not** close its open positions. It only
stops it opening new ones. To flatten everything, use the red
**Stop all bots & close positions** button, or close positions manually in MT5.

---

## 8. Where everything lives

```
C:\Users\jobin\Downloads\xautotrade\xautotrade\
├── server\                     ← run npm commands here
│   ├── .env                    ← your config (edit with notepad)
│   ├── src\
│   │   ├── engine\             ← indicators, rules, risk, backtester
│   │   ├── broker\             ← MT5 bridge, MetaApi, paper simulator
│   │   ├── live\               ← the bot runner
│   │   └── api\                ← the endpoints your phone calls
│   ├── xautotrade.db           ← your strategies + logs (don't delete)
│   └── README-mt5mcp.md        ← detail on the MT5 bridge
├── mobile\                     ← run expo commands here
│   └── src\screens\            ← the app screens
├── README.md                   ← project overview
└── RUNBOOK.md                  ← this file
```

`C:\Users\jobin\mt5mcp\` — leftover from an earlier approach. Not used anymore,
safe to ignore or delete.

---

## 9. If you need to reinstall from scratch

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\server
rmdir /s /q node_modules
del package-lock.json
npm install

cd C:\Users\jobin\Downloads\xautotrade\xautotrade\mobile
rmdir /s /q node_modules
del package-lock.json
npm install
```

Do **not** run `npm install expo@latest` in the mobile folder — the Expo version
is deliberately pinned to SDK 54 to match the Expo Go app on your phone.
