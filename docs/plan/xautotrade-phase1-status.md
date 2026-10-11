# XAutoTrade — Phase 1 status (11 October 2026)

Supersedes the 9 October status note, which stopped at task 1.7. Phase 1 is built, tested and pushed as nine stacked pull requests on `jobinpjoseph707/xautotrade`, head `d27f3b6` on `phase1/1.9-no-silent-paper`, 21 commits ahead of `main`.

Merge in this order. Each PR's base is the branch below it, so GitHub retargets as you merge. Use "Create a merge commit" — squashing a stacked set turns clean PRs into conflicted ones.

| Order | PR | Task | Branch |
|---|---|---|---|
| 1 | #2 | 1.1 Test foundations, 8-tab shell | phase1/1.1-foundation |
| 2 | #3 | 1.2 Strategy rules (stop, 1.5x target, spread, flat window, UTC fix) | phase1/1.2-strategy-rules |
| 3 | #4 | 1.3 Cleanup and rank scripts, test strategies out of totals | phase1/1.3-cleanup |
| 4 | #5 | 1.4 Inbox replaces Activity | phase1/1.4-inbox |
| 5 | #6 | 1.5 Chat on each strategy, what-if backtests | phase1/1.5-strategy-chat |
| 6 | #7 | 1.6 Safety: loss cap, outage handling, stall watch, key hygiene | phase1/1.6-safety |
| 7 | #8 | 1.7 Help tab says what to do | phase1/1.7-help-actions |
| 8 | #9 | 1.8 Help shows which markets are trading now | phase1/1.8-markets-help |
| 9 | #10 | 1.9 Refuse to start with no broker; `npm run salvage` | phase1/1.9-no-silent-paper |

PR #10 also carries work that was not in the original plan: Strategies > From YouTube (video to strategy on real MT5 history, Inbox proposal, Strategist fallback for narrated videos), every displayed time in Indian Standard Time, and two market-status fixes (a stopped price may not teach the broker clock; a price stamped in the future is never "open").

Counts: server 287 tests, mobile 37, e2e 22 (2 skipped by design). Both type checks clean. CI green on every commit.

## To do by hand
1. Merge the nine pull requests, in order, with merge commits.
2. Rotate the API key: the old one is in git history. Stop the server, `npm run key -- rotate` in `server/`, start it, paste the new key into the app.
3. Run `npm test` and both type checks on the Windows machine.
4. `npm run cleanup` as a dry run, read the list, then `-- --apply`. Then `npm run rank` with MT5 open, and pick the 1-2 keepers.
5. Raise "Bollinger Fade"'s target to at least 1.95x ATR, or the 1.5:1 rule keeps refusing it.
6. Hand checks from the test plan: refused save with target below stop, one demo order at the right lot, a 40-minute outage leaving bots paused with an Inbox card, laptop sleep keeping stops at the broker.

## Open, carried into Phase 2
- Six bots run and none trade. Unexplained. The leading candidate is the broker-clock decay described in `xautotrade-phase2-plan.md`, task 2.0.
- Help still says "In paper mode every market is simulated and always open" while on a real broker.
- `develop` exists at `f5decb4` with nothing based on it.
- Five of the six older strategies remain unproven (profit factor below 1).

## Decisions taken (change if you disagree)
- Gold `maxLot` 0.2, others 0.5.
- "M1 Gold Quick Scalp (test)" on XAUUSD is kept and flagged `isTest`; only the EURUSD copies and "M1 HFT EMA Scalp" are deleted.
- Every agent except the Strategist gets backtest numbers for the strategies in scope.
- Per-strategy conversations are kept in server memory and reset on restart.
- After the daily loss cap fires, bots cannot be started until 00:00 UTC.
- API key accepted in the header only (the `/ws` feed keeps `?key=`).
- Displayed times are Indian Standard Time; the server and bots still work in UTC.
