# XAutoTrade — Learning layer (built 2026-09-23)

Implements the "self-improving agents" design notes from `xautotrade-open-issues.md` (all six steps + per-agent `model` field). Code: `server/src/learning/*`, wired in `server/src/chat/service.ts` and `server/src/api/chat.ts`; app: Agents tab → **Learning** segment (`mobile/src/screens/LearningPanel.tsx`, `components/ProposalChecks.tsx`).

## What happens to a proposal now

1. Agent replies with actions (unchanged).
2. **Unseen-data check** (`learning/validate.ts`, `lab.ts`): server fetches 3000 bars; the last 1500 are what the agent saw (same window as the chat backtest), the older part is the out-of-sample window. Before/after backtested on both.
   - Update that does worse on unseen data → **held back** (not shown; appears as "Held back…" banner; recorded as `blocked`). `VALIDATION_MODE=warn` shows it with a warning instead.
   - Too few trades / too little history → shown as **UNPROVEN**.
   - New strategy that loses on unseen data → shown with warning (user asked for it).
   - Risk Guard changes are judged on drawdown, not profit.
3. **Critic** (5th agent, `learning/critic.ts`): rule checks always (fail/overfit, <30 OOS trades, >2 fields changed, loosens risk, repeats a proven "hurt" lesson, stacks on an unscored change from this week) + one Claude call covering all proposals (`CRITIC_MODE=llm|rules|off`, default llm). Verdict support/caution/oppose shown on the card; never blocks.
4. Every proposal (shown or held back) is written to **outcome memory** (SQLite `learning_records`, kind `change`): agent, model, reason, before/after config, signatures, market snapshot (ATR%, trend%, avg spread), validation, critic, demo stats for 7 days before approval. Proposals now survive server restarts.
5. **Scoring** (`learning/scoring.ts`): learning loop every 30 min (`LEARN_TICK_MINUTES`). Approved changes ≥3 days old (`LEARN_SCORE_MIN_DAYS`) are backtested before vs after on bars formed *after approval*; helped / hurt / inconclusive (±0.25 pt margin). Waits for ≥15 trades (`LEARN_MIN_TRADES`), gives up as inconclusive after 21 days (`LEARN_SCORE_MAX_DAYS`). Deletes/stops scored by whether the removed config would have lost. Demo P&L from trade logs attached as secondary evidence.
6. **Notebooks** (`learning/notebook.ts`): lessons derived from scored outcomes grouped by change signature (e.g. `risk.slPoints:down`) per market and overall. Needs ≥3 decisive results, ≥75% one way. Injected into each agent's prompt with the last 8 outcomes; "hurt" lessons shared across agents. User notes per agent (Learning tab). Mirror files: `server/data/notebooks/<agent>.md`.
7. **Scoreboard**: per agent and per agent+model hit rate, held-back count, critic accuracy, 30-day trend.
8. **Auto-evolve** (`learning/evolve.ts`): OFF by default, explicit per-strategy opt-in. Every 7 days the Optimizer proposes one variant per opted-in strategy (max 3); must pass unseen-data check and never loosen risk (`gateViolation`). Variant is shadow-tested 7 days (backtest on the new bars — no orders placed), then judged winner/loser/inconclusive. **Promote** is one tap; promotion is recorded and scored like any other change.

## Model field

`AgentDef.model` + env `AGENT_MODEL_<ID>` (e.g. `AGENT_MODEL_CRITIC=haiku`) or `CHAT_MODEL`; passed to `claude --model`. Recorded as `claude-cli/<model|default>` on every record. `ChatBackend.complete(prompt, { model })` — a Gemini backend is still one small class.

## Fixed on purpose

Agents cannot touch risk limits beyond existing gates, `ALLOW_LIVE_TRADING`, or the approval step. Learning reads candles + trade logs only; nothing auto-applies.

## API (under /api/chat)

`GET changes`, `GET changes/:id`, `GET scoreboard`, `GET notebooks`, `GET lessons`, `POST notebooks/:agent/notes`, `DELETE notebooks/:agent/notes/:i`, `POST learning/run` ({forceScore}), `GET/PUT evolve`, `POST evolve/run`, `POST evolve/candidates/:id/promote|dismiss`.

## Verification

15 new tests in `server/src/learning/learning.test.ts`. From the remote bridge (compiled with tsc, run with node --test to dodge the esbuild win32/linux mismatch): 113/113 passing across learning, chat, agents, youtube, engine; broker tests too slow to finish there (code untouched). Both packages `tsc --noEmit` clean. **Confirm with `npm test` on Windows** (expect ~145).

## Known limits

Forward window capped at 5000 bars (≈3.5 days on M1). Critic LLM call adds ~30–60 s per chat reply that has proposals (set `CRITIC_MODE=rules` to skip). Validation needs ≥1800 bars of history.
