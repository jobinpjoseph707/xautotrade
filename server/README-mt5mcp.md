# Free path: MT5 desktop + MCP, instead of MetaApi

This is the self-hosted, no-subscription alternative to MetaApi. Trade-off:
**your PC has to run MT5 desktop and one extra small server, continuously.**
If this machine sleeps, restarts, or loses internet, the bot goes dark until
it's back — there's no cloud fallback the way there is with MetaApi.

This whole path is newer and far less battle-tested than the MetaApi adapter.
Expect to debug it together the first time it runs.

---

## What you're setting up

```
  Your phone                This same Windows PC
┌──────────────┐   HTTPS   ┌───────────────────────────────────────────┐
│  XAutoTrade  │ ────────► │  XAutoTrade server (npm run dev)           │
│  (Expo app)  │ ◄──────── │        │                                   │
└──────────────┘           │        │ MCP over HTTP (127.0.0.1:8000)   │
                            │        ▼                                  │
                            │  mt5mcp (Python, uv run mt5mcp)           │
                            │        │ COM interface                    │
                            │        ▼                                  │
                            │  MT5 desktop terminal (logged in)         │
                            └───────────────────────────────────────────┘
```

Three things need to be running on this PC at the same time: MT5 desktop,
the Python `mt5mcp` bridge, and our Node server.

---

## 1. Install `uv` (a Python package manager/runner)

Open PowerShell and run:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Close and reopen your terminal afterward so `uv` is on your PATH. Check with:

```
uv --version
```

## 2. Make sure MT5 desktop is installed and logged in

Open your MetaTrader 5 desktop terminal (not the mobile app), log into your
**demo account**, and leave it open. `mt5mcp` talks to this terminal directly —
it does not need its own copy of your password if the terminal is already
logged in.

## 3. Run the MT5 MCP server in HTTP mode

In a new terminal window:

```powershell
mkdir C:\mt5mcp
cd C:\mt5mcp
```

Create a file named `.env` in that folder with:

```env
MT5_MCP_TRANSPORT=http
MT5_MCP_HOST=127.0.0.1
MT5_MCP_PORT=8000
```

Then start it:

```powershell
uvx --from mcp-metatrader5-server mt5mcp
```

Leave this window open. Watch its output for the exact URL it's serving on —
it should be something like `http://127.0.0.1:8000/mcp`. If the path differs
from `/mcp`, note the real one; we'll need it in the next step.

## 4. Point the XAutoTrade server at it

In `server/.env` (create it from `.env.example` if you haven't), set:

```env
BROKER=mt5mcp
MT5MCP_URL=http://127.0.0.1:8000/mcp
```

Leave `MT5MCP_LOGIN` / `MT5MCP_PASSWORD` / `MT5MCP_SERVER` blank — since MT5
desktop is already logged in, the server doesn't need your password too.

Restart the XAutoTrade server:

```
npm run dev
```

It should print `Mode   MT5-MCP (local bridge at http://127.0.0.1:8000/mcp)`
and, once it first connects, a line listing every tool the MCP server actually
offers — something like:

```
[mt5mcp] Connected. Server exposes 18 tools: initialize, login, get_symbols, ...
```

**Send me that exact line if anything errors after this point.** The broker
adapter's tool names were written from the underlying MetaTrader5 Python
library's well-documented API, but the specific MCP wrapper is new enough that
I couldn't verify every field against a live server — that log line is exactly
what we need to fix any mismatch fast.

## 5. Try it

In the app: Strategies → your strategy → Start. Watch the Activity tab. If an
order fails with something like *"retcode 10030"* or *"Unsupported filling
mode"*, that's almost always the `type_filling` setting — try changing
`MT5MCP_FILL_MODE` in `server/.env` from `ioc` to `fok` or `return` and
restart.

---

## Keeping this running long-term

For real use, all three processes (MT5 terminal, `mt5mcp`, the XAutoTrade
server) need to survive you closing your laptop lid, Windows updates, and
overnight. At minimum:

- **Windows Settings → System → Power** — turn off sleep, or use
  `powercfg /change standby-timeout-ac 0` in an admin terminal.
- Keep both terminal windows (mt5mcp, and `npm run dev`) open — minimized is
  fine, closed is not.

If this PC isn't realistically going to stay on around the clock, MetaApi
remains the better fit — that's the whole reason it's a paid cloud service:
someone else keeps the terminal running so you don't have to.
