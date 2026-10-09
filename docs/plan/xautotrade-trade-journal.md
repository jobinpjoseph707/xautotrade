# XAutoTrade — Trade Journal tab (2026-09-23, updated 2026-09-24)

New sidebar tab **Journal** (shortcut 2; Strategies→3, Agents→4, Chart lines→5, Activity→6, Settings→7, Help→8).

## What it shows
Every trade every bot has taken: bot, symbol, side, lots, open/close time, time held, entry / exit (or live price while open), stop-loss, take-profit, planned reward:risk, spread at entry, how it closed (take-profit, stop-loss, stop-out, bot exit rule, opposite signal, stop-all, manual), net P&L incl. commission + swap, MT5 ticket. KPIs (net P&L, win rate, profit factor, avg win/loss, best/worst, avg hold) and the cumulative P&L chart + per-bot table all follow the filters. Tap a row for the full detail sheet. Export CSV (web).

## The filter bar (redesigned 2026-09-24)
This tab exists to filter the trade list, so the filter bar is built to cost as little screen space as possible and to never need scrolling back into view:
- **Pinned to the top.** The whole filter strip is wrapped in a new `Sticky` component (`position: sticky` under the hood) so it stays visible at the top of the screen while the KPIs / chart / trade table scroll underneath it — on both desktop and phone.
- **One dense strip, not stacked sections.** Period and result stay as small chip rows (self-explanatory, glanced at constantly — "Today", "▲ 4", "▼ 36"…). Side, closed-by, bot, symbol and sort are `Select` dropdowns in `compact` mode: a 32px pill showing a micro-label + current value + caret, opening the existing bottom-sheet picker (radio mark, label, a trade-count hint per option). Search is a plain compact text input. Thin vertical rules separate the groups. Everything wraps naturally at any width instead of stacking into separate labeled rows — the whole bar dropped from roughly 300–400px tall to about 85px on desktop.

## How it's built
- Server: `GET /api/journal?from&to` (server/src/api/journal.ts) → `buildJournal()` (server/src/journal/journal.ts) merges trade logs (entry / position_closed / exit / panic_close), open broker positions and MT5 deal history.
- MT5 deal details are cached in a new SQLite table `position_history` (closed positions only), up to 40 new lookups per request; `pendingDetails` tells the app more are still loading.
- Trade-level log rows are no longer pruned (`logs.prune` skips level='trade'), so the journal keeps full history.
- Entry logs now record side, symbol and entry price.
- Paper broker position ids are now unique across restarts (`paper-<time36>-<n>`) so paper trades never merge.
- App: mobile/src/screens/JournalScreen.tsx; types JournalTrade / JournalResponse; `api.journal()`.

## Design-system additions (2026-09-23 / 2026-09-24)
- `Select<T>` (mobile/src/components/ui.tsx): a labeled dropdown for a filter with more/longer options than a chip row should carry. Two-line form (label above, value+caret below, like `Field`) by default; pass `compact` for the one-line 32px pill used in dense toolbars. `emphasizeChange={false}` for a pure-ordering control (e.g. "Sort") that shouldn't read as an active filter.
- `Sticky` (same file): pins its children to the top of the nearest scrolling ancestor via CSS `position: sticky` (react-native-web passes it straight through; native builds just ignore the value and render in normal flow). Reusable anywhere a toolbar/filter strip should stay in view above a scrolling list.

## Tests
Server 170/170 (incl. 5 journal unit tests), e2e 127/127, UI regression 25/25, journal UI script 16/16 (desk + phone: KPIs, filter bar stays pinned while scrolling, bot dropdown opens, losers filter narrows the shown count, CSV export, detail sheet, no console errors).
