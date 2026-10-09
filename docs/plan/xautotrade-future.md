# XAutoTrade — future (not in the 3 phases)

Written 8 October 2026. These came up in discussion and are kept here so they are not lost. None of them is needed for the 3-phase plan.

## 1. A fast local decision model ("System 1")

- **Idea:** a small open-source model on your own machine makes the per-candle decision in about a second. The cloud agents stay in the background as the slow thinkers.
- **Fits:** one-minute candles and slower. It is far too slow for tick-by-tick trading.
- **Candidate:** Laya (`NandhaKishorM/laya`), a decision model that answers yes, no or "not sure" with a confidence. Its own README calls it a base to specialise, so it would need training on your own scored trades first.
- **Needs:** a machine with a GPU, and a small Python service. It plugs in behind the same model interface the server already has.
- **Rules that still apply:** decisions only on closed candles, every gate, and your approval for any change to how it decides.
- **Do first:** at least 500 scored demo trades, or there is nothing to train on.

## 2. Methods quant firms use, at small scale

| Method | Small version here | Cost |
|---|---|---|
| Point-in-time data | Every candle and news item stores when it became known. Nothing reads past that line. | Low |
| Walk-forward testing | Test on a slice, step forward, test on the next unseen slice. A loop around the existing backtester. | Low |
| Counting attempts | Already in the plan: the bar rises with each attempt on the same data. | Done in Phase 2 |
| One source of truth | Already true: one database file, one risk module for backtest and live. | Done |
| Fast array backtests | A separate Python research service that only tests and scores, so thousands of variations can run overnight. The Node server keeps trading. | Medium |

## 3. Tick-level execution

- An Expert Advisor inside MT5 follows a fixed rule on every tick. The agents only choose the rule.
- This is a separate MT5 component. It is the only way to act faster than one candle.
- Not worth building until a bar-close strategy has passed the demo stage.

## 4. Limits of MT5 worth remembering

- The smallest candle is one minute.
- There is no live order book. Forex and gold at a retail broker have no central exchange. The spread is the only depth information, and the plan already uses it.
- A real order book needs a different venue (stocks, futures, crypto) and a new broker adapter behind the existing `Broker` interface.

## 5. Polymarket

A separate project in its own repo, `polymarket-research-agents`. It is kept apart because almost nothing in the strategy engine carries over: a prediction market resolves to yes or no, so candles, stops and indicators do not apply. What carries over is the agent design, the approve-before-act rule, the gates and the honest measurement.

## 6. For the profile

- Agent evaluation suite scored on every pull request.
- Tracing of every agent call with OpenTelemetry.
- Docker for the server in paper mode, so anyone can run it without MT5.
- Short decision records: why SQLite, why the agents are a separate service, why no reinforcement learning.
- A results page that shows what passed and what failed, with trade counts.

## 7. Carried over from earlier

Parameter sweep, Monte Carlo stress tests, news with a vector store, Chart lines on MT5 with a health check, more than one position per strategy, pending orders.

## 8. Decided against

- **Rust or Go for the server.** The limit is the broker and the candle clock, not the language, and neither has the agent tooling.
- **Dify, Langflow, n8n for the core.** Visual builders hide the code that enforces the guardrails. n8n could send alerts later.
- **Promising stars or profit.** Neither can be planned.
