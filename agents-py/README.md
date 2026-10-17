# agents-py: the agent team (Phase 3.3)

A small Python service (LangGraph + FastAPI) that runs the agent team on one strategy:
**Doctor → Optimizer → Tester → Critic → Risk Guard → submit**.

It **cannot trade**. It has no broker, no database of the bot's, and no way to approve anything. Its only
connection to the system is five routes on the trading server, reached with its own key
(`x-agent-key`). That key is refused everywhere else (test AG-10). A surviving idea ends up as an
ordinary card in your Inbox, and nothing changes until you tap Approve.

## Run it (Windows, next to the server)

1. Python 3.11+. In this folder: `pip install -e .`
2. In `server/.env` add `AGENT_SERVICE_URL=http://127.0.0.1:8000` and start the server once. It makes an
   agent key by itself; `npm run key -- agent` (in `server/`) prints it. (Or set `AGENT_API_KEY` in the
   server's environment to choose your own.)
3. Start the service with the same key in its environment. The service reads environment variables, not a
   `.env` file (`.env.example` lists them), so in PowerShell:
   `$env:AGENT_API_KEY="<key>"; $env:SERVER_URL="http://127.0.0.1:4000"; python -m agents_py.app`
4. In the app, open a strategy's chat. The **Agent team** card has *diagnose* and *tune*.

Without `AGENT_SERVICE_URL` nothing accepts the agent key, the weekly cycle is off, and a run says
"The agent service is not running". Everything else works as before.

Useful server settings: `AGENT_EVIDENCE_DAYS` (default 14: how many recent days the Doctor and Optimizer
may look at; the Tester's test runs on bars *before* those days, which they have never seen).

## Tests

`python -m pytest -q` (no network, no Claude: every model answer is a fake). The Risk Guard here
mirrors the server's `gateViolation`; both are checked against one shared file,
`tests/fixtures/risk_cases.json`, produced by `npx tsx src/scripts/riskCases.ts` in `server/`.

## What was and was not verified

Verified: the graph, budgets, refusals, saved runs surviving a restart, and one end-to-end run with the
real server and this real service against a **fake** `claude` script.
Not verified: a run with the real Claude, and a run on real MT5 history. A strategy on 1-minute bars needs
about 23,000 bars of history for the unseen-bars test; if the broker returns fewer, the run ends with
"dropped" and says why.
