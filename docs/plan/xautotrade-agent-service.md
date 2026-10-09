# XAutoTrade — agent service (agents that talk to each other)

Written 8 October 2026. It goes with `PLAN-3-PHASES.md` (Phase 3, task 3.3), `TEST-PLAN.md` (tests AG-1 to AG-14) and `ARCHITECTURE.md`.

**This reverses one earlier decision.** The plan said "no agent framework". You then asked for agents that talk to each other and share what they know about each strategy. For that shape a graph framework is the right tool, so the agents move into a small Python service built on LangGraph. What does **not** change: lessons and outcomes stay in SQLite, and the trading server keeps every guardrail.

---

## 1. What you asked for, and what is built

| You asked for | What is built |
|---|---|
| Agents talk to each other | One graph where each agent is a step and passes its findings to the next. |
| Every agent knows each strategy | A shared **dossier** per strategy that all agents read and add notes to. |
| Agents build on each other's reasoning | The Critic can send a proposal back to the Optimizer, at most twice. |
| Reasoning must be there | Every run is saved step by step, so you can read who said what and why. |

---

## 2. Technology

| Part | Choice | Why |
|---|---|---|
| Language | Python 3.12 | The agent tools, and the research service planned later, are Python. |
| Agent graph | LangGraph | Agents as nodes, one shared state object, loops with a limit, saved runs. |
| Saved runs | LangGraph's SQLite checkpointer, in its own file `agents.db` | A run can be replayed and inspected. It never touches `xautotrade.db`. |
| API | FastAPI | Two endpoints: start a run, read a run. |
| Tests | pytest | Same idea as the server tests: a fake model, fixed inputs, no network. |
| Folder | `agents-py/` at the top of the repo | Beside `server/` and `mobile/`. |

LangGraph also has a TypeScript version, so this could live inside the Node server. I chose a separate Python service because you said the first project should use Python, it keeps the agent code away from the code that places orders, and the later research service can share it. If you prefer one language and one process, say so and it becomes a folder inside `server/`.

---

## 3. The one rule: the agent service cannot act

```
 agents-py (Python, LangGraph)                 server (Node)
┌───────────────────────────────┐   HTTP    ┌─────────────────────────────────┐
│ reads dossier                 │──────────►│ GET  /api/agent/dossier/:id     │
│ asks for a backtest           │──────────►│ POST /api/agent/backtest        │
│ asks a model                  │──────────►│ POST /api/agent/llm             │
│ posts a note                  │──────────►│ POST /api/agent/notes           │
│ submits a proposal            │──────────►│ POST /api/agent/proposals       │
└───────────────────────────────┘           │   validate → gates → critic     │
        no broker, no database,             │   → Inbox → YOU approve         │
        no strategy writes                  └─────────────────────────────────┘
```

- The service has **no** broker connection and **no** access to the trading database.
- It uses its own API key that only works on the five `/api/agent/*` routes. It cannot start a bot, approve a proposal, or change a strategy.
- A proposal it submits is treated exactly like one from today's agents: validated, checked against the gates, shown in the Inbox, applied only when you approve.
- Model calls go through the server (`/api/agent/llm`), so the daily call cap, the usage log and the choice of model stay in one place.
- If the service is off or crashes, trading continues and the existing single-agent chat still works. One Inbox item says the agent service is down.

---

## 4. The shared dossier

One per strategy. Built by the server from data it already has; agents read it and add notes.

| Part | From |
|---|---|
| Strategy settings, stage, tier | `strategies` |
| Demo results: trades, profit factor, average win and loss, drawdown | Journal |
| Results sliced by market state, hour and direction | Journal |
| Lessons in scope (same symbol and timeframe only) | Lesson ledger |
| Open theory and past attempts | `hypotheses`, `trials` |
| Last 5 scored changes with the one-line reason | Learning records |
| **Agent notes** — what each agent concluded, with the evidence it used | New table `agent_notes` |

The scope rule holds here too: a note about a gold strategy is never shown in a EURUSD dossier. The dossier has a fixed size limit, like every prompt.

---

## 5. The graph

```
 start
   │
   ▼
 Doctor ── "nothing is wrong" ──────────────────────────► end (note only)
   │ diagnosis
   ▼
 Optimizer (or Strategist for a new idea)
   │ theory + one change + what would prove it wrong
   ▼
 Tester ── fails its own test ──► note "theory dropped" ─► end
   │ survived on unseen data
   ▼
 Critic ── objects ──► back to Optimizer (at most 2 times)
   │ supports or cautions
   ▼
 Risk Guard ── change loosens risk ──► end (refused, noted)
   │ ok
   ▼
 Submit proposal to the server ──► Inbox ──► you
```

| Agent | Reads | Adds to the shared state | Can it submit? |
|---|---|---|---|
| Doctor | Dossier | What is going wrong and where (for example "losses cluster in high volatility") | No |
| Optimizer / Strategist | Dossier + Doctor's finding | A theory, the single change, the line that would prove it wrong | No |
| Tester | The change | Before and after numbers on bars nobody saw | No |
| Critic | Everything so far | Its objections, or its support | No |
| Risk Guard | The change | Whether risk is tighter, equal or looser | No |
| Submit step | The final state | Sends the proposal with the full run attached | Yes, the only one |

The Tester is not a model. It is a plain function that calls the server's backtester. Numbers come from code, never from a model's memory.

### Limits

- At most 2 Critic-to-Optimizer rounds, then the run ends without a proposal.
- At most 8 model calls per run.
- One run per strategy at a time, and none while a change on that strategy is waiting to be scored.
- If two trusted lessons disagree on the setting being changed, the run stops with "hold".

---

## 6. When the graph runs

| Trigger | Default |
|---|---|
| You tap **Diagnose** or **Tune** in a strategy's chat | Runs once, on that strategy. You see each agent's step as it finishes. |
| Weekly research cycle | Runs once per failing strategy, at most 3 strategies. |
| Continuously, all day | **No.** It would burn calls and produce changes faster than they can be scored. |

This is the question the voice call left open. I used "on your tap, and weekly" as the default. Say so if you want something else.

---

## 7. What you see in the app

- In a strategy's chat, a run shows as a short thread: Doctor, Optimizer, Tester, Critic, Risk Guard, each with two or three lines.
- The proposal card in the Inbox has "Why was this proposed?", which opens that thread.
- Help gains: "Agents disagreed and no proposal was made — Nothing. They stopped after two rounds without agreement."

---

## 8. What this costs you

- **Time.** It is the largest single item in the plan. It replaces the hand-built loop in task 3.3, so Phase 3 grows by about a week. The knowledge layer (YouTube, books) moves after it.
- **A second thing to run.** The Windows machine now starts the Node server and the Python service. Docker, or one start script, hides this.
- **More model calls per proposal.** Up to 8 instead of 1 or 2. The daily cap still applies.
- It will not make strategies more profitable by itself. Published tests of multi-agent trading systems have not shown that. Its value is better-argued proposals and a reasoning trail you can read.

---

## 9. Build order inside the task

1. Server: the five `/api/agent/*` routes, the scoped key, the `agent_notes` table, the dossier builder.
2. Service: state type, the Tester function, the graph with a fake model. All tests pass with no real model.
3. Wire the real model through `/api/agent/llm`.
4. App: the run thread in strategy chat and the "Why was this proposed?" link.
5. Weekly trigger.
