# XAutoTrade — Manual test plan (17 October 2026)

For checking by hand, in the browser, that every feature and every rule works. It covers everything in `develop` once pull requests #11 to #22 are merged: Phase 1, Phase 2, Phase 3 and saved chats.

It has three parts:

- **Part A — Sandbox.** A second server in paper mode with its own empty database and **known test data**. Nothing here touches your real strategies, your MT5 or your real bots. Do all of Part A first. It takes about 90 minutes the first time and about 10 minutes as a daily routine (section 5).
- **Part B — Your real MT5 demo account.** The checks that need real prices. About 45 minutes, once, then the daily routine.
- **Part C — Daily routine and a bug report template.**

How to read a case: do the **Do** column, compare with **Expect**, tick the box. A case that does not match is a bug: write it in the template at the end (what you did, what you saw, what you expected). Cases marked **Claude** need the `claude` command logged in on your PC; they work in the sandbox too, because chat does not depend on the broker.

No profit is promised anywhere. The plan checks that rules work, not that strategies win.

---

## 0. Setup

### 0.1 Start the sandbox server (window A)

Use a **separate** window from your real server. The server reads these settings from the window, so they override `server\.env`.

Command Prompt:

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\server
set E2E_SEED=1
set BROKER=paper
set PORT=4100
set API_KEY=sandbox-key
set DB_PATH=./sandbox.db
set MT5_COMMON_FILES=%TEMP%\xat-sandbox
npm run dev
```

PowerShell:

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\server
$env:E2E_SEED="1"; $env:BROKER="paper"; $env:PORT="4100"; $env:API_KEY="sandbox-key"; $env:DB_PATH="./sandbox.db"; $env:MT5_COMMON_FILES="$env:TEMP\xat-sandbox"
npm run dev
```

Check: open `http://localhost:4100/api/health` in the browser. You should see `"mode":"paper"` and `"liveTradingAllowed":false`.

`E2E_SEED=1` switches on the test-only routes that put data into the sandbox. **Never set it on your real server.**

To start again from empty: stop the server, delete `server\sandbox.db`, start it again, and run the seed script again.

### 0.2 Load the test data (window B)

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\server
npm run seed:manual -- http://localhost:4100 sandbox-key
```

Every line must say `PASS`. The script refuses to run against anything that is not a paper-mode server. Run it again whenever you want the data back to its starting state (it removes its own `MT ...` strategies first; it does not remove Inbox cards or chats, so for a perfectly clean start delete `sandbox.db`).

### 0.3 Start the web app (window C)

```
cd C:\Users\jobin\Downloads\xautotrade\xautotrade\mobile
npx expo start --web
```

A browser tab opens (usually `http://localhost:8081`). On the connect screen enter `http://localhost:4100` and the key `sandbox-key`, then tap **Connect**.

Tips:
- Keys **1** to **8** jump between the eight tabs (not while typing).
- To see the phone layout, open the browser's developer tools, switch on the device toolbar and pick a width of 390.
- To go back to your real server later: Settings > **Log out**, then connect to `http://localhost:4000` with your real key.

### 0.4 What the seed script created (the test data)

| Item | What it is | Why it exists |
|---|---|---|
| **MT EMA Pullback EURUSD** | Preset, M5, EURUSD | A normal, valid strategy. Has a backtest. |
| **MT MACD Momentum XAUUSD** | Preset, M5, gold | Second valid strategy, different symbol (tier and market checks). |
| **MT Bollinger Fade EURUSD** | Preset, M5, EURUSD | Third valid strategy, same symbol as the first (correlation / "one bet"). |
| **MT Order Test rig** | Preset, M1, marked **test** | Must be left out of every total and the Testboard. |
| **MT Live Scalp BTCUSD** | Fast scalp, M1, marked **test**, allowed to trade at any hour | The one you start by hand to watch real paper trades. |
| **MT Demo 5 trades / 40 trades / 120 trades** | Strategies at the demo stage with 5, 40 and 120 closed trades in their history (each win +10.00, each loss -8.00) | Testboard progress, verdicts, and the Journal. Together they give the Journal **120 closed trades, net +480.00** (case 6.1). Side, lots and prices show as "?" or a dash because the trades are seeded, not real. |
| 3 Inbox cards (plus one probe card) | "MT card A / B / C" and "MT probe". All four are of the type **Losing streak** with only a **Dismiss** button, whatever their title says | Inbox actions and the tab badge (4). Cards with Restart, Approve and so on come from real events (cases 7.6 and 8.8). |
| 3 saved chats | "MT chat 1", "MT chat 2" on the Agents tab; "MT chat 3" on MT EMA Pullback | Previous chats, scoped per strategy. |
| 1 idea | "MT Asian range break" from "MT Cup" | Ideas sheet. |

Remember: the sandbox prices are made up by the paper broker. Backtest numbers are therefore only checked for **shape and sanity** (they run, they are consistent, the rules apply), never for whether a strategy is any good.

A note on weekends and nights: presets close trades at 21:45 UTC (03:15 IST) and before the weekend, and open nothing then. Only **MT Live Scalp BTCUSD** has been opened up so it can trade at any hour. If another bot says "Flat window ... no new entries", that is the rule working (case 4.6), not a fault.

---

## 1. Connect and the shell

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-1.1 | Open the app with no saved connection. Enter the right URL and a **wrong** key. Tap Connect. | A red note **"Invalid or missing API key."** You are not let in. | ☐ |
| MAN-1.2 | Enter the right URL and `sandbox-key`. Tap Connect. | The Dashboard opens. The header shows **Paper Account**, a **Demo** pill, equity 10,000.00, and the note **"Paper mode — simulated prices, no broker attached."** | ☐ |
| MAN-1.3 | Press keys 1 to 8 one after another. | The tabs open in this order: Dashboard, Inbox, Strategies, Testboard, Journal, Agents, Settings, Help. No error banner on any. | ☐ |
| MAN-1.4 | On a wide window, collapse and expand the sidebar. Then narrow the window to 390 wide. | Sidebar becomes a rail and expands again. At 390 wide a bottom tab bar shows all 8 tabs. | ☐ |
| MAN-1.5 | Reload the page (F5). | You stay connected (no connect screen) and land on the Dashboard. | ☐ |
| MAN-1.6 | Settings > **Log out**. | The connect screen returns. Connect again and everything is still there. | ☐ |
| MAN-1.7 | Open the browser console (F12) after connecting and repeat 1.3. | No red errors. (A red "401" line from the wrong key in 1.1, and a "400" line when a save is refused in section 2, are expected and are not faults.) | ☐ |

## 2. Strategies: create, refuse, edit, delete

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-2.1 | Open **Strategies**. | The header says **8 strategies · 0 running**. Each row shows name, market, an Open pill, a Stopped pill, size, stop, daily cap, and the buttons **💬, Details, Backtest, Start, ✕**. | ☐ |
| MAN-2.2 | In **Search** ("Name or symbol…") type `xau`. Then `gold`. Then clear it. | `xau` shows only MT MACD Momentum XAUUSD. `gold` shows **No strategy matches “gold”** (search is on the name and symbol, not on nicknames). Clearing brings all 8 back. | ☐ |
| MAN-2.3 | Tap **New strategy**. Tap the market (it shows XAUUSD), pick **GBPUSD** (the list shows 5 symbols). Leave **Balanced**, tap **Small**, tap **Create this strategy**. | A summary first says what will be set up (risk per trade, daily loss, trades per day). After Create it opens the **Backtest** screen for **Balanced GBPUSD** ("GBPUSD · 5m"). Back on Strategies the list says 9 strategies, and the new row shows 0.5% risk, 1.5× ATR stop, 2% daily cap. | ☐ |
| MAN-2.3b | New strategy > tap **I know what I am doing — full editor**. | A list of ready-made strategies. The test rigs carry a **TEST ONLY** tag. Cancel out. | ☐ |
| MAN-2.4 | On Strategies tap the **Balanced GBPUSD** row (opens the editor), go to the **Risk** tab. Under **Stop loss** tap **None**, then **Save**. | A pop-up titled **Could not save**: "No stop-loss: every strategy needs one (set the stop mode to points or ATR)." Nothing is saved. | ☐ |
| MAN-2.5 | Set the stop back to **ATR**. Under **Take profit** tap **None**, then Save. | **Could not save**: "No take-profit: every strategy needs a target (set the target mode to points, ATR or reward:risk)." | ☐ |
| MAN-2.6 | Stop loss **ATR** multiple 2, take profit **ATR** multiple 1. Save. | **Could not save**: "Target 1×ATR is smaller than 1.5 × the stop (2×ATR). Use at least 3×ATR." | ☐ |
| MAN-2.7 | Stop loss **Points** (200), take profit **ATR** (3). Save. | **Could not save**: "Stop and target use different units (ATR vs points), so they cannot be compared. Use reward:risk for the target, or the same unit for both." | ☐ |
| MAN-2.7b | Stop loss **Points** 200, take profit **R:R** 1.0. Save. | **Could not save**: "Reward:risk 1 is below the minimum 1.5. Use 1.5 or more." | ☐ |
| MAN-2.8 | Set a valid pair: stop **ATR** 2, take profit **ATR** 3. Save. | Saved (the **UNSAVED** badge disappears). | ☐ |
| MAN-2.9 | Open Help (key 8) > "Saving a strategy". Compare the messages you just saw. | Each refusal you met has a matching Help entry saying what to do. | ☐ |
| MAN-2.10 | On the Strategies list tap **✕** on the `Balanced GBPUSD` row and confirm. | It disappears from the list (back to 8). | ☐ |
| MAN-2.11 | Tap **✕** on another strategy and press Cancel in the confirm box. | Nothing is deleted. | ☐ |
| MAN-2.12 | If the full-editor list offers a **blank** or custom option, create one from it. (If it does not, mark this case N/A.) | It either saves with sensible defaults or is refused with a clear reason. It must not crash and must not save without a stop and target. | ☐ |

## 3. Backtests

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-3.1 | On MT EMA Pullback EURUSD tap **Backtest**. Leave the settings (3,000 bars, balance 10,000). Tap **Run backtest**. | Tiles for **Net profit, Trades, Win rate, Profit factor, Max drawdown, Expectancy**, an **Equity curve**, then Average win / loss, Largest win / loss, Worst losing streak, Total commission, Average hold, Final balance. | ☐ |
| MAN-3.2 | Check the arithmetic: Final balance = Starting balance + Net profit; Win rate = wins / trades; Profit factor = gross profit / gross loss (average win x wins divided by average loss x losses, roughly). | All hold within rounding. | ☐ |
| MAN-3.3 | Run the same backtest twice with identical settings. | Identical numbers (a backtest has no randomness). If they differ, write down both. | ☐ |
| MAN-3.4 | Change **Spread override (points)** to a very large value (for example 200). Run. | Fewer trades or a worse result, and warnings about skipped entries (the spread is above the cap or above 15% of the stop). | ☐ |
| MAN-3.5 | Change **Starting balance** to 1,000. Run. | The equity curve starts at 1,000. With "% of balance" sizing the lots are smaller, so money amounts are smaller. | ☐ |
| MAN-3.6 | Tap **Optimize test settings** (the small link in the Test settings card). | It fills **Spread override**, **Commission per lot**, **Starting balance** and **Bars of history** (about 30 days of bars) and shows one line saying exactly what it filled. It never changes the strategy. | ☐ |
| MAN-3.7 | Run a backtest of the **MT Order Test rig** (a test rig that trades almost every minute). | It trades a lot and loses to spread. This is expected. | ☐ |
| MAN-3.8 | Run any backtest that loses money. | A card **"Not profitable under these settings"** appears with **Get a fix suggestion**. (Claude) tap it: a reply and a proposal card with before/after numbers and Approve / Reject. Reject it. | ☐ |

## 4. Bots: start, stop, flat window, trades

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-4.1 | On Strategies tap **Start** on **MT Live Scalp BTCUSD**. | The button turns into **Stop**. The header changes to "... · 1 running". | ☐ |
| MAN-4.2 | Open the Dashboard. | The tile **Bots running** reads **1 / 8** (9 if you kept the extra strategy from 2.3). The Bots table lists the scalp with a **Stop** button. | ☐ |
| MAN-4.3 | Tap the bot name (Details). | The page says "BTCUSD · 1m · running since <time>", a **Market: open** pill, a **Running** pill, a Today / All time / Custom range switch, tiles **Trades today / Realised today / Floating / Last signal**, then **OPEN NOW** and **TRADE HISTORY**. | ☐ |
| MAN-4.4 | Wait up to 15 minutes. | In the sandbox the scalp opened a paper trade within about a minute. Each open trade shows under **OPEN NOW**, and in Trade history as "OPEN Opened SHORT/LONG 0.01 BTCUSD @ price (SL ..., TP ...)"; when closed it gets a CLOSE row with P&L. | ☐ |
| MAN-4.5 | While a position is open, go to the Dashboard > **Open positions** and tap **Close**. | The position closes at once; the bot's Trade history gets a CLOSE row; Realised today changes by that profit. | ☐ |
| MAN-4.6 | Start **MT EMA Pullback EURUSD** at a time after 21:45 UTC (03:15 IST) or on a weekend. | Its page says **Flat window (end of day or weekend): positions closed, no new entries**. No order is placed. (On a weekday daytime it will say something else, or trade. The scalp ignores this rule because the seed loosened it for the sandbox.) Help > "Why a bot is not trading" has the same sentence. | ☐ |
| MAN-4.7 | Tap **Stop** on the running bot. | Status goes to stopped. Open positions stay open (closing them is a separate action). | ☐ |
| MAN-4.8 | Start the bot again, then on the Dashboard tap **Stop** in its Bots row. | The bot stops and **Bots running** returns to 0. | ☐ |
| MAN-4.9 | Start a bot, then Settings > **Stop all bots & close positions**. Confirm. | Bots stop and bot-opened positions close. Cancel in the confirm box keeps everything. | ☐ |
| MAN-4.10 | Stop the sandbox server (Ctrl+C) while the web app is open. | The app shows a connection problem, not a blank screen. Start the server again: the app reconnects by itself. | ☐ |
| MAN-4.11 | After 4.10, check the bot you left running. | The bot restarts by itself (the outage was under 30 minutes). If you wait **more than 30 minutes** with the server off, the bot stays paused and an Inbox card says so (see 9.4). | ☐ |

## 5. Dashboard

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-5.1 | Open the Dashboard with the scalp running. | Tiles: **Equity (USD), Balance, Free margin, Floating P&L, Realised today, Bots running**. Tables: Bots, Open positions (with a **Close** button), Risk tiers. The **Activity log** button opens the Inbox. | ☐ |
| MAN-5.2 | Compare "Realised today" with the sum of closed trades shown on the scalp's Details page for Today. | They match. | ☐ |
| MAN-5.3 | Compare what the Journal and Testboard include. | **Test strategies are in neither.** The scalp and the Order Test rig are test strategies, so their trades show on the Dashboard and on their own Details page only. (The list rows do not show a TEST ONLY tag; you recognise a test rig by its absence from the Testboard and from the Journal's Bot filter.) | ☐ |
| MAN-5.4 | Find the **Risk tiers** panel. | Tiers 1 to 5 with caps 1.50%, 1.20%, 0.90%, 0.75%, 0.60%. Each lists the strategies in it and the open risk. The seeded demo bots sit provisionally in the first tiers; which tier a bot lands in can differ from run to run. | ☐ |
| MAN-5.5 | Pull to refresh / tap Refresh. | The "updated" time moves. | ☐ |
| MAN-5.6 | Check every time on screen against India time (IST, UTC+5:30). | The app shows IST everywhere, whatever your computer's clock says. | ☐ |

## 6. Journal

The Journal reads closed trades of **real** (non-test) strategies. In the sandbox the three seeded demo bots give it **120 closed trades**, so it is not empty. The test rigs (Order Test rig, Live Scalp) are left out on purpose.

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-6.1 | Open the Journal, choose **All time**. | Summary: **Net P&L +480.00**, **win rate 67%** (80 won, 40 lost), **profit factor 2.50**, **average win +10.00**, **average loss -8.00**, **best +10**, **worst -8**. Check by hand: 80 x 10 - 40 x 8 = 480; 800 / 320 = 2.50. | ☐ |
| MAN-6.2 | Open the Bot filter. | By bot: **MT Demo 120 trades = 80 trades (+332)**, **MT Demo 40 trades = 35 (+134)**, **MT Demo 5 trades = 5 (+14)**. They add to 120 and +480. (The seed shares trades between the three demo bots; the exact split is a quirk of the seed data, the total is what matters.) The Order Test rig and Live Scalp are **not** in the list. | ☐ |
| MAN-6.3 | Tap the period chips (**Today, 7d, 30d, All time, Custom**) and the outcome chips (**All, ▲, ▼, BE, Open**). | The list and the totals follow the filters; wins + losses + BE + open = All (80 + 40 + 0 + 0 = 120). **Clear filters** resets them. | ☐ |
| MAN-6.4 | Open one trade row. | The seeded trades show a "?" for side and a dash for prices (they are demo data). Real trades (Part B) show entry, stop, target, lots, planned reward : risk, spread at entry, held time, closed-by, commission, swap, ticket. | ☐ |
| MAN-6.5 | Tap **Export CSV**. | A CSV downloads. Open it: 120 rows, and the net adds up to 480. Times are in IST. | ☐ |
| MAN-6.6 | Confirm the test rigs' trades never appear. | Correct: the scalp trades on the Dashboard but the Journal total stays 120 / +480.00. | ☐ |

## 7. Inbox

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-7.1 | Look at the tab bar. | The Inbox tab shows a badge **4** (the three "MT card" cards and the "MT probe" card). | ☐ |
| MAN-7.2 | Open the Inbox. | Four cards, each labelled **Losing streak** with two buttons: **Dismiss** and **What do I do?**. (The seed makes all cards this type, whatever their title.) | ☐ |
| MAN-7.3 | Tap **Dismiss** on a card. | The card goes away and the badge falls from 4 to 3. | ☐ |
| MAN-7.4 | Tap **What do I do?** on a card. | Help opens with a banner "From your Inbox card — Losing streak" and the entry for it highlighted, with the buttons **Open Strategies** and **Back to Inbox**. | ☐ |
| MAN-7.5 | Dismiss every card. | The page says **Nothing needs you / You can close the app.** | ☐ |
| MAN-7.6 | Cause a real card: start **MT EMA Pullback EURUSD** while the market status is closed (or stop the sandbox server for a minute with a bot running). | An error or stall card appears with **Restart bot**. Tapping it restarts the bot and the card closes. | ☐ |
| MAN-7.7 | A repeated problem. | One card with **Happened N times**, not N cards. | ☐ |

## 8. Testboard (stages and verdicts)

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-8.1 | Open the Testboard. | Subtitle **Which stage each strategy has reached**. Six strategies are listed (the three MT strategies and the three demo bots). The two test rigs are **not** listed. | ☐ |
| MAN-8.2 | Find **MT Demo 5 trades**. | The chain reads **✓ Backtest | ✓ Paper | Demo | 🔒 Live**. Progress shows **5 trades** against 100 and **0 / 7 days**. Verdict **Not enough trades yet**. | ☐ |
| MAN-8.3 | Find **MT Demo 40 trades**. | **40 / 100 trades**, **0 / 7 days**, **Not enough trades yet**. | ☐ |
| MAN-8.4 | Find **MT Demo 120 trades**. | **120 / 100 trades** and about **0.1 / 7 days**; the verdict is **Not tested yet** (not "Not enough trades yet") until you tap **Test now**. After testing, the demo stage must not pass: the history spans minutes, not the 7 days required. The three MT backtest-stage strategies also say **Not tested yet**. | ☐ |
| MAN-8.5 | Find the **Live** stage on every card. | A padlock. Tapping it does nothing. The line says **Locked. Nothing in this app can move a strategy to live.** | ☐ |
| MAN-8.6 | Tap **Test now** on MT EMA Pullback EURUSD. | A test runs against candles. In the sandbox it ended with **Not enough trades yet**: "Only 32 trades in total (need 100)." and "Only 10 trades on bars it was never tuned on (need 30)." Your numbers will differ (the sandbox candles are synthetic and change with the day) but the two reasons and the need-100 / need-30 wording should match. | ☐ |
| MAN-8.7 | Tap **Test now** on the same strategy four more times (5 attempts). | Each attempt needs a higher profit factor (+0.05). After 5 attempts on the same bars it says it must wait for new bars. | ☐ |
| MAN-8.8 | If any strategy shows **Passed**: open the Inbox. | A "passed" card with **Move to next stage** and **Keep here**. Tap **Move to next stage**: the Testboard stage moves exactly one step. Tap **Keep here** on another: nothing moves. | ☐ |
| MAN-8.9 | Look for any way to move a strategy to **live**. | There is none. | ☐ |
| MAN-8.10 | Help > "Testboard verdicts". | One entry for each verdict you saw. | ☐ |

## 9. Safety and risk tiers

Most safety rules are triggered by things that rarely happen (a 3% day loss, a 30-minute outage). They are covered by the automated tests (`S-1` to `S-11`, `M-1` to `M-9`, `T-1` to `T-13`). The checks below are the parts you can see by hand.

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-9.1 | Dashboard risk tiers with the scalp running. | The scalp's lot is small (0.01); open risk stays well under the tier cap. | ☐ |
| MAN-9.2 | Edit a **non-test** strategy to risk 5% per trade (Risk: percent 5) and start it when it can trade. | When it signals, either the lot is cut to your max lot, or the order is blocked with **Order blocked: tier cap reached**. Both are the rule working. Help > "Risk tiers" explains it. | ☐ |
| MAN-9.3 | Start two bots on the same symbol and direction (MT EMA Pullback EURUSD and MT Bollinger Fade EURUSD). | The second order is held back with **counted as one bet** if together they would exceed the stricter cap. | ☐ |
| MAN-9.4 | (Optional, 35 minutes.) Stop the server, wait **35 minutes**, start it again. | Bots do **not** restart. Each gets an Inbox card **"A bot was left paused after an outage"** with **Restart bot**. With an outage under 30 minutes (case 4.11) they restart by themselves. | ☐ |
| MAN-9.5 | Settings > **Stop all bots & close positions** after starting two bots. | Both stop; their positions close. This is the manual emergency stop. | ☐ |
| MAN-9.6 | (Claude) Ask in a strategy's chat for something that loosens risk, for example "double the lot size". | The proposal carries the warning **loosens a risk limit**, and the Help entry says to Reject it. A safety move itself (pause or make safer) shows an Inbox card with **OK** and **Undo**. Tap **Undo**: the old value returns. | ☐ |

## 10. Chat on the Agents tab and per strategy (Claude)

### 10.1 Agents tab

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-10.1 | Open **Agents**. | Agent chips: Auto, Strategist, Optimizer, Strategy Doctor, Risk Guard, Critic. The note says nothing changes until you tap Approve. | ☐ |
| MAN-10.2 | Tap **Previous chats**. | A list with **TODAY**, then "MT chat 2" and "MT chat 1" (newest first), each with its first lines and a message count. | ☐ |
| MAN-10.3 | Tap "MT chat 1". | The list closes and the conversation opens with both messages. | ☐ |
| MAN-10.4 | Tap **＋ New chat**. | The screen clears to **Talk to your strategy agents**. The old chats are not deleted. | ☐ |
| MAN-10.5 | Send: `Why isn't my bot trading?` | "Thinking..." then a reply from an agent (Strategy Doctor). The new chat appears in Previous chats, titled from your first message. | ☐ |
| MAN-10.6 | Reload the page (F5) and open Agents. | You are back in the chat you were in, with all messages. | ☐ |
| MAN-10.7 | Send: `Create a fast scalping strategy for BTCUSD on the 1 minute chart` with Strategist selected. | A proposal card: summary, reason, warnings, checks (unseen-data test and the critic), **Approve** and **Reject**. | ☐ |
| MAN-10.8 | Tap **Approve**. | The card turns **APPROVED**; the strategy exists in Strategies. Reload and reopen the chat: the card still says APPROVED. | ☐ |
| MAN-10.9 | Ask another thing that proposes a change. Tap **Reject**. | Card turns REJECTED; nothing changed. | ☐ |
| MAN-10.10 | Previous chats > **Delete** on one chat, confirm. | It disappears from the list. If it was open, the screen clears. Cancel keeps it. | ☐ |
| MAN-10.11 | In a new chat, Auto-select an agent and send `make all my strategies safer`. | A reply and, if it proposes, a proposal. A failed send (turn Claude off or log out of it) saves nothing and shows an error. | ☐ |
| MAN-10.12 | Tap **🔊 Read replies aloud** and **🗣 voice** (Chrome). | The reply is read out loud; the voice list opens. | ☐ |
| MAN-10.13 | Tap the mic and ask by voice (Chrome, allow the microphone). | Your words appear, then send after a pause. | ☐ |

### 10.2 One strategy's chat

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-10.20 | On **MT EMA Pullback EURUSD** tap the 💬 icon. | A sheet **Chat: MT EMA Pullback EURUSD** opens on its latest chat ("MT chat 3"). Four buttons: **Tune**, **Diagnose**, **Tighten risk**, **Critique**. | ☐ |
| MAN-10.21 | Tap **Previous chats** in that sheet. | Only "MT chat 3" is listed (the chats on the Agents tab are not). | ☐ |
| MAN-10.22 | Tap **Diagnose**. | A reply about this strategy only. It never mentions another strategy's details. | ☐ |
| MAN-10.23 | Tap **Tune** (or ask `try a wider stop`). | A proposal with a **NOW / WITH CHANGE** table (trades, profit factor and so on). With fewer than 30 trades it says **weak evidence**. | ☐ |
| MAN-10.24 | Close the sheet and reopen it. | Same conversation, nothing lost. | ☐ |
| MAN-10.25 | **＋ New chat** then close and reopen the sheet. | Still the new (empty) chat for that strategy, not the old one. | ☐ |
| MAN-10.26 | Open the chat of **MT MACD Momentum XAUUSD**. | A different (empty) chat. | ☐ |

## 11. Agent team, learning and ideas

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-11.1 | **Without** the Python agent service running: in a strategy chat open the **Agent team** panel and run *diagnose*. | A clear message, and an Inbox card **The agent service is not running**. Nothing changes; trading is not affected; the single-agent chat still works. | ☐ |
| MAN-11.2 | (Optional, needs `agents-py` installed.) Run *diagnose* with the service on. | The panel shows the run step by step (Doctor, Tester, Critic...) and ends with a note or a proposal. **No** proposal without a test on unseen bars. | ☐ |
| MAN-11.3 | On a proposal card from an agent run open **Why was this proposed?** | The checklist: market, timeframe, market state, tier, evidence, what would prove it wrong, and the lessons it used. | ☐ |
| MAN-11.4 | Agents > **Learning**. | Lesson ledger (lessons are listed with their market and symbol, trusted only after 5 agreeing outcomes of 30+ trades), the scoreboard per agent, notebooks. Empty is fine on a new database. | ☐ |
| MAN-11.5 | Strategies > **Ideas**. | The sheet **Ideas and books**: "MT Asian range break" is listed with status *untested*. The text explains that status comes only from how strategies built from it actually did. | ☐ |
| MAN-11.6 | In Ideas, save a competition idea with the name blank. | Refused: **Say which competition it came from.** (or the matching field message). | ☐ |
| MAN-11.7 | Save a competition idea with a **sizing** field filled in. Reload and view it. | The entry idea is kept; the sizing is **not** shown anywhere ("How the winner sized positions is thrown away"). | ☐ |
| MAN-11.8 | (Claude) Paste a short chapter of a book you own into the book form with a page number. | A short concept note is saved with the page. The pasted text itself is **not** kept (the sheet says it is used once and not saved). | ☐ |
| MAN-11.9 | Strategies > **From YouTube**: paste `https://example.com`. | Refused: not a YouTube link. Nothing is sent. | ☐ |
| MAN-11.10 | (Needs internet, MT5 for real history.) Paste a real YouTube trading video link. | A strategy is built and backtested on real candles, and an Inbox proposal appears. Approve is your decision. | ☐ |

## 12. Settings and Help

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-12.1 | Open Settings. | Server address, API key (masked), mode **paper**, live orders note **"demo accounts only"**, and the buttons **Stop all bots & close positions** and **Log out**. | ☐ |
| MAN-12.2 | Find the **CLAUDE USE** panel. | Tabs **Today | 7 days | 30 days** and the line **"0 of 40 automatic calls used today"** on a fresh sandbox. After your chat messages in section 10 the count has gone up. | ☐ |
| MAN-12.3 | Open Help. | A daily routine (about 10 minutes), a weekly one (about 20), "Never needed", then "when you see this" groups: Inbox cards, Broker errors, Saving a strategy, Why a bot is not trading, Risk tiers, Testboard verdicts. | ☐ |
| MAN-12.4 | Find the markets board in Help. | In the **paper sandbox** it says "13 of 13 open" and "In paper mode every market is simulated and always open." The closed-at-weekend behaviour only exists on the real MT5 server, so test it in Part B (MAN-B.4). | ☐ |
| MAN-12.5 | Click through 10 entries at random. | Every one has *You see*, *It means* and *Do* lines. No empty entries. | ☐ |

## 13. Phone width and robustness

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-13.1 | Repeat 1.3, 7.2, 8.1 and 10.2 at 390 px wide. | Nothing overflows; tables become cards; buttons stay tappable. | ☐ |
| MAN-13.2 | Type a very long message (about 1,000 characters) into a chat. | It sends or is refused politely; the page does not break. | ☐ |
| MAN-13.3 | Send two messages quickly one after another in a chat. | The second waits (the Send button shows loading). | ☐ |
| MAN-13.4 | Open the app in two browser tabs. Delete a chat in one. Open Previous chats in the other. | The deleted chat is gone after reopening the list. Opening a chat that no longer exists shows a clear message, not a blank page. | ☐ |
| MAN-13.5 | Stop the Claude login (run `claude logout` in a terminal) and send a chat message. | The chat shows an error, an Inbox card **Claude not available** appears, nothing is saved in the chat, and trading continues. Log in again and the card closes by itself at the next answer. | ☐ |

---

# Part B — Your real MT5 demo account

Do this on your real server (`http://localhost:4000`, your real key), with MT5 open and logged in to the **demo** account. `ALLOW_LIVE_TRADING` must stay `false`. Before you start: merge #11 to #22, `git pull`, restart the server (a changed `.env` needs a full restart), and run `npm run cleanup` as a dry run.

| ID | Do | Expect | ✔ |
|---|---|---|---|
| MAN-B.1 | Dashboard account block. | Balance, equity and server match the numbers in the MT5 window. Mode says the real broker, not paper. | ☐ |
| MAN-B.2 | Open `http://localhost:4000/api/health`. | `"liveTradingAllowed":false`. | ☐ |
| MAN-B.3 | Open `http://localhost:4000/api/candles/EURUSD?timeframe=5m&limit=5&key=YOURKEY`. | Five real candles whose times match MT5 (shown in UTC in the raw data; the app shows IST). | ☐ |
| MAN-B.4 | Help > markets board. | Forex closed on Saturday and Sunday; gold likewise; BTC open. After the weekend ends it flips to open. | ☐ |
| MAN-B.5 | `npm run cleanup` (dry run), read it, then run it for real. | It lists what it will change (backup first, test flags, max lot clamped to 0.5 or 0.2 on gold, duplicate gold scalps removed). After it, the Journal and Dashboard totals leave out the test strategies. | ☐ |
| MAN-B.6 | `npm run rank` with MT5 open. | A table: trades, profit factor and drawdown for each strategy under the new rules. You choose the keepers. | ☐ |
| MAN-B.7 | Save a strategy whose target is below 1.5 x its stop. | Refused (same as 2.6). | ☐ |
| MAN-B.8 | Start the **Order Test rig** on EURUSD on demo during market hours. | A real demo order appears in MT5 with the right lot (0.01) and comment starting `XAT:`. Watch two or three trades, then Stop and delete it. | ☐ |
| MAN-B.9 | Open a keeper strategy's Details at a time when its market is open. | The market pill says open; the bot page explains each wait ("Waiting for history", "Flat window", spread above cap). | ☐ |
| MAN-B.10 | Testboard > **Test now** on a keeper. | It uses real candles: the reasons mention real trade counts and the unseen bars. Fewer than about 23,000 one-minute bars makes a 1-minute strategy say it cannot test; MT5 may return fewer. | ☐ |
| MAN-B.11 | Cause a known broker error: turn off **Algo Trading** in MT5 and let a bot signal. | An Inbox error card appears with the right Help entry (**Error 10027**). Turn it back on and tap **Restart bot**. | ☐ |
| MAN-B.12 | Close MT5 for two minutes with a bot running. | A **stall** card appears (no new bar for three bars while the market is open). Reopen MT5 and tap **Restart bot**. | ☐ |
| MAN-B.13 | Open the Journal after a few real demo trades. | Each trade has entry, stop, target, lots, spread at entry, MT5 ticket. The count matches MT5's History tab. | ☐ |
| MAN-B.14 | Chart lines (the strategy overlay panel on a strategy). | Lines for the strategy's indicators are written to the MT5 chart files; a loud message tells you if the health check fails. | ☐ |
| MAN-B.15 | The six silent bots: start your keepers on a weekday daytime and note when each last had a signal. | Bots trade, or say why not. If a bot says nothing for hours while the market is open, write down its name and the exact "Now:" line. This is the open question from Phase 1. | ☐ |

---

# Part C — Daily routine and bug report

## Every day, about 10 minutes (real server)

1. **Inbox.** Act on every card. If it is red, tap **What do I do?** first.
2. **Dashboard.** Account matches MT5. Bots running is the number you expect. Nothing in red.
3. **Testboard.** Read the one-line verdict for each strategy. Tap **Move to next stage** only on one you trust.
4. **Journal** (weekly, 7 days). Average win bigger than average loss? Profit factor above 1?
5. **Settings.** Claude use is under the daily limit.
6. **One chat check.** Open a strategy's chat, tap **Diagnose**, read it. Approve nothing you do not understand.

## After every update (merge or pull)

Restart the server. Run `npm test` and `npm run typecheck` in `server`, and `npm test` and `npx tsc --noEmit` in `mobile`. Then walk sections 1, 7, 8 and 10.2 of Part A in the sandbox (15 minutes) before you trust the real server again.

## Bug report template

```
Case ID:          (for example MAN-8.6)
Where:            sandbox / real demo      Date and time (IST):
What I did:
What I saw:       (copy the exact text; add a screenshot)
What I expected:
Server window:    (copy any red lines)
Browser console:  (F12 > Console, red lines)
```

## Results

| Section | Cases | Passed | Failed | Notes |
|---|---|---|---|---|
| 1 Connect and shell | 7 | | | |
| 2 Strategies | 14 | | | |
| 3 Backtests | 8 | | | |
| 4 Bots | 11 | | | |
| 5 Dashboard | 6 | | | |
| 6 Journal | 6 | | | |
| 7 Inbox | 7 | | | |
| 8 Testboard | 10 | | | |
| 9 Safety and tiers | 6 | | | |
| 10 Chat | 20 | | | |
| 11 Agent team, learning, ideas | 10 | | | |
| 12 Settings and Help | 5 | | | |
| 13 Phone width and robustness | 5 | | | |
| B Real MT5 demo | 15 | | | |

## What this plan cannot show

- Whether any strategy makes money. Sandbox prices are invented, and 100 demo trades at profit factor 1.2 is only about 84% confidence the edge is real.
- The rare safety events (a 3% day loss, a broker clock fault) except through the automated tests listed in `xautotrade-test-plan.md`.
- The agent team on real data until the Python service is installed and Claude is logged in.
