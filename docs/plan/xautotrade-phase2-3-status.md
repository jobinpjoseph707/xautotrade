# XAutoTrade — Phase 2 and 3 status (16 October 2026)

Phase 1 (PRs #2 to #10) is merged into `develop`. Phase 2 and Phase 3 are built, tested and pushed as ten more pull requests, **all with base `develop`**, stacked on each other. Merge them in this order with "Create a merge commit" (squashing a stacked set turns clean PRs into conflicted ones). After each merge, GitHub shows the next one as mergeable.

| Order | PR | Task | Branch |
|---|---|---|---|
| 1 | #11 | 2.1a Gate engine on real candles, pass marks, attempts | phase2/2.1a-gate-engine |
| 2 | #12 | 2.1b Paper replay of real candles | phase2/2.1b-paper-replay |
| 3 | #13 | 2.1c Testboard screen, Inbox "Move to next stage" | phase2/2.1c-testboard |
| 4 | #14 | 2.2 Risk tiers enforced before every order | phase2/2.2-risk-tiers |
| 5 | #15 | 2.3 Safety moves that apply themselves (pause or tighten, with Undo) | phase2/2.3-safety-moves |
| 6 | #16 | 2.4 Token panel, weekly digest, daily Claude call cap | phase2/2.4-usage-digest-cap |
| 7 | #17 | 3.1 One learning system (old rotation and weekly loop removed) | phase3/3.1-one-learning-system |
| 8 | #18 | 3.2 Scoped lesson ledger (replaces the notebook) | phase3/3.2-lesson-ledger |
| 9 | #19 | 3.3 Agent team (Python/LangGraph service), theory-and-test | phase3/3.3-agent-service |
| 10 | #20 | 3.4 Knowledge layer, synthetic gate removed (also adds the Python CI job) | phase3/3.4-knowledge-layer |

Counts at the head of #20: server 394 tests, mobile 65, Python 54, e2e 32 (2 skipped, as before). Type checks clean on server and mobile. CI was green on #11 to #19 when checked (server, mobile, GitGuardian). **CI does not run e2e on pull requests** (it is manual by design), so the e2e result is from my runs here.

## When you can check

Phase 2 and Phase 3 are both ready. Each PR body lists what to look at and what it does not prove.

## What the checks do not prove

- **No run with the real Claude.** The agent team and the book-note summariser were exercised only with fakes, plus one end-to-end run of the real server and real LangGraph service against a fake `claude` command.
- **No real MT5 data.** The market buckets (3.2), the unseen-bars test for 1-minute strategies (about 23,000 bars needed) and the gates on real candles were tested on paper-broker and synthetic data. If the MT5 bridge returns fewer bars, agent runs end "dropped" and say so.
- **Thresholds are my choices** (market edges, trust numbers, tier rules, idea status counts). They are listed in each PR body. None are tuned on your data.
- **The dossier's market state has only a spread reading**, so lesson keys may say unknown for volatility and trend until it carries a full snapshot.
- **Still open from Phase 1:** six bots run and none trade (leading suspect: broker clock decay, task 2.0), and Help still says paper mode is always open while on a real broker.

## To do by hand

1. Merge #11 to #20 in order.
2. Install the agent service if you want it: `agents-py/README.md` (Python 3.11+, set `AGENT_SERVICE_URL` in `server/.env`). Without it nothing changes.
3. Rotate the API key if you have not (the old one is in git history).
4. Run the server tests and both type checks on the Windows machine.
5. First run on real data: open a strategy's chat, **Agent team > diagnose** first (cheap, proposes nothing), then **tune**. Read the steps it shows before approving anything.
6. `npm run cleanup` (dry run first) and `npm run rank` if not done.

## Not built from the plan

- Task 3.5 (parameter sweep, walk-forward, Monte Carlo, news with a vector store, a second model).
- Task 3.6 extras: a per-pull-request agent evaluation suite, Docker for paper mode, a results page that shows failures.
- The YouTube Strategist route does not record ideas; nothing closes a contradicted idea link automatically (see `xautotrade-knowledge-layer.md`).

## Decisions that are still yours

The nine defaults in `xautotrade-plan-3-phases.md` are in force until you say otherwise. New ones this round: the agent runs only on your tap and weekly (and weekly only when the service is configured); the lesson trust numbers (5 agreeing, weight 2.5, 75% share); idea status (supported after 1 helped, contradicted after 2 hurt).
