# XAutoTrade — Help tab: what to do

Written 8 October 2026. It goes with `PLAN-3-PHASES.md` (task 1.7) and `TEST-PLAN.md` (tests HP-1 to HP-7).

**The change:** today the Help tab (`mobile/src/screens/HelpScreen.tsx`) describes what each tab shows. It does not tell you what to do. After this change it opens with your daily routine, then a "when you see this, do this" list, then one action line per tab. The old descriptions stay, folded under each tab.

This file is the text that goes into the app. Wording can change; the rule is that **every message the app can show you has an action here.**

---

## 1. How it is built

| Part | Detail |
|---|---|
| Text lives in data, not in the screen | New file `mobile/src/logic/help.ts` exports three lists: `ROUTINE`, `WHEN_YOU_SEE`, `TAB_ACTIONS`. `HelpScreen.tsx` only draws them. This is what makes the text testable. |
| One source for message types | Inbox item types and Testboard verdicts are defined once in `mobile/src/types.ts`. A test fails if one of them has no entry in `WHEN_YOU_SEE`. |
| Linked from where the message appears | Each Inbox card and Testboard card gets a small "What do I do?" link that opens Help at that entry. |
| Buttons, not only words | Where the action is one tap (Open Inbox, Open Testboard, Stop all bots), the Help entry carries that button. |
| Components | Existing `Card`, `Explain`, `Page`, `PageHeader`, `SectionTitle`, `Button` from `ui.tsx`. No new look. |
| Grows with each phase | A feature is not finished until its Help entries exist. Phase 1 ships sections 2, 3 (Inbox and error rows) and 4. Phase 2 adds the Testboard and tier rows. Phase 3 adds the learning rows. |

---

## 2. Your routine (top of the Help tab)

**Every day, about 10 minutes**

1. Open **Inbox**. Act on each card: Approve, Reject, Restart or Dismiss.
2. If the Inbox is empty, you are done. Close the app.
3. If a card is red (error, stall, kill switch), read its "What do I do?" line before anything else.

**Once a week, about 20 minutes**

1. Read the weekly summary card in the Inbox.
2. Open **Testboard**. For each strategy, read the one-line verdict.
3. Open **Journal**, set Period to 7 days. Check that average win is bigger than average loss.

**Never needed**

- Watching the Dashboard during the day. The stop and target sit at the broker.
- Changing a strategy by hand because of one bad day. Ask in that strategy's chat and let the test decide.

---

## 3. When you see this, do this

### Inbox cards

| You see | What it means | What to do |
|---|---|---|
| **Proposal** — an agent wants to change a strategy | The change already passed a test on data the agent did not see. The critic's view is on the card. | Read the before and after numbers. Tap **Approve** if after is better and the critic does not oppose. Tap **Reject** if you are unsure. Rejecting costs nothing. |
| **Proposal** with a warning "loosens risk" | The change raises lot size, risk or a limit. | Tap **Reject** unless you asked for exactly this. |
| **Stage passed** — a strategy cleared backtest, paper or demo | It met the pass marks. It has not moved yet. | Tap **Move to next stage** to let it continue. Tap **Keep here** to collect more trades first. |
| **Stage failed** | It missed a pass mark; the card says which. | Nothing is needed. Open the strategy's chat and tap **Diagnose** if you want to try to fix it. Otherwise leave it or delete it. |
| **Bots paused after restart** | The server was off for more than 30 minutes, so bots did not resume by themselves. | Check MT5 is open and logged in. Then tap **Restart bots**. |
| **Bot stalled** | A bot has not seen a new bar for 3 bars while the market is open. | Open MT5 on the PC. If it shows "No connection", fix the internet or log in again. Then tap **Restart**. |
| **Losing streak** | 5 losses in a row, or a 3R loss today, on one strategy. | The bot keeps its limits by itself. Open its chat and tap **Diagnose**. Do not raise the lot size to win it back. |
| **Kill switch fired** | The account lost 3% today. All bots are paused and their positions closed. | Stop for the day. Tomorrow, read the Journal for today, then tap **Restart bots** one strategy at a time. |
| **Safety action applied** | The system paused a bot or tightened a limit by itself. | Read what changed. Tap **OK** to keep it. Tap **Undo** to restore the old value, or **Restart** for a paused bot. |
| **Claude not available** | The agents could not reach Claude (logged out or limit reached). Trading continues with saved strategies. | On the PC, open a terminal and run `claude`, then log in. Tap **Retry**. |
| **Order rejected by broker** | MT5 refused an order; the card shows the code. | See "Broker errors" below. |
| **Weekly summary** | What traded, what was learned, what needs you. | Read it, then tap **Dismiss**. |

### Broker errors

| You see | What to do |
|---|---|
| Error **10027** — AutoTrading disabled | In MT5 on the PC, click the **Algo Trading** button in the toolbar so it turns green. Then tap **Restart**. |
| **Invalid stops** | The stop or target is too close to the price for this symbol. Open the strategy's chat and ask "widen the stop so it is legal". Approve the proposal. |
| **Not enough money** | The lot is too big for the free margin. Lower the lot in the strategy's risk settings, or ask Risk Guard to do it. |
| **Market closed** | Nothing. The bot trades again when the market opens. |
| **Unsupported filling mode** | On the PC, remove `MT5MCP_FILL_MODE` from `server/.env` so the server picks the mode per symbol, then restart the server. |

### Saving a strategy

| You see | What to do |
|---|---|
| "Target must be at least 1.5 × stop" | Raise the target or lower the stop until target ÷ stop is 1.5 or more. |
| "A strategy needs a stop" / "needs a target" | Set both. A strategy without one of them cannot be saved. |
| "Spread is more than 15% of the stop" (in a backtest: many skipped trades) | The stop is too tight for this market's cost. Widen the stop. On gold with a 35-point spread the stop must be about 235 points or more. |
| "Lot capped at maxLot" | The size was cut to your limit. This is the limit working. Change `maxLot` in risk settings only if you mean to. |

### Testboard verdicts (Phase 2)

| You see | What to do |
|---|---|
| **Not enough trades yet (40 / 100)** | Wait. Do not change the strategy, or the count starts to mean less. |
| **Clearing** | Nothing. Let it run. |
| **Failing** | Open its chat and tap **Diagnose**, or stop the bot. Do not move it forward. |
| **Passed, waiting for your tap** | Tap **Move to next stage**. |
| **Not enough evidence** (after 14 days) | Too few trades to judge. Keep it on demo longer, or delete it if it almost never trades. |
| **Paused** | See why in the Inbox, then **Restart**. |
| **Live — locked** (padlock) | Nothing. Live trading is switched off in this version. |
| **Too many attempts — waiting for new bars** | The same test data was used 5 times. Wait until new bars arrive; the card shows how many are left. |

### Risk tiers (Phase 2)

| You see | What to do |
|---|---|
| **Order blocked: tier cap reached** | Nothing. Open risk in that tier is at its limit; the bot trades again when a position closes. |
| **Two strategies count as one bet** | Two bots hold the same direction on the same or a linked market. Stop one of them if you want to keep them separate. |
| **Tier changed** (for example Moderate → Active) | The strategy now behaves as riskier than before. Read its drawdown in the Journal. Ask Risk Guard to tighten it if you did not expect this. |

### Learning (Phase 3)

| You see | What to do |
|---|---|
| **Hold: lessons disagree** | Nothing. The agent found two trusted lessons pointing in opposite directions and chose not to guess. |
| **Why was this proposed?** link on a proposal | Tap it to read the theory, the test, and the lessons used. Reject if the reason does not make sense to you. |
| **New idea from a video or book** on the Testboard | It is an idea at the backtest stage, not a running bot. Leave it; it only moves if it passes. |

---

## 4. One action line per tab

| Tab | Key | What you do here |
|---|---|---|
| Dashboard | 1 | Look, do not act. The one button is **Stop all bots**, for when you want everything closed now. |
| Inbox | 2 | Act on every card. This is the only tab you must open each day. |
| Strategies | 3 | Create a strategy, start or stop a bot, run a backtest. Tap the chat icon on a row to ask about that strategy. |
| Testboard | 4 | Read each strategy's verdict. Tap **Move to next stage** when one has passed. |
| Journal | 5 | Check results by period. Compare average win with average loss. Export to CSV if you want. |
| Agents | 6 | Ask a general question, by typing or by voice. For one strategy, use its own chat on the Strategies tab. |
| Settings | 7 | Reconnect to the server, change tier caps and limits, see how many Claude calls were used today. |
| Help | 8 | This page. |

The current longer explanations (journal filters, the two ways to create a strategy, voice chat, the Learning panel) stay, folded under each tab.

---

## 5. What is removed from Help

- The **Chart lines** card (tab hidden) and the **Activity** card (replaced by Inbox).
- "Agents cannot act on their own" becomes: "Agents cannot change a strategy on their own. The system itself can do two things without asking: pause a bot, and tighten a limit. Each time, it tells you in the Inbox."
- "Pick Auto and it routes your message" becomes the four buttons: Tune, Diagnose, Tighten risk, Critique.
