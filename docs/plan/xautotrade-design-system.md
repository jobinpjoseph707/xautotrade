# XAutoTrade — design system (2026-09-23 redesign, updated 2026-09-24)

Built with the `dataviz` skill (reference dark chrome, status palette, stat-tile/hero-figure contract, diverging bar rules) and the `design:design-system` skill. Tokens live in `mobile/src/theme.ts`, components in `mobile/src/components/ui.tsx`, breakpoints in `mobile/src/layout.ts`.

## Tokens
- Surfaces (neutral near-black, hairlines, no shadows): bg `#111110` → surface `#1A1A19` → surfaceAlt `#222221` → surfaceHover `#2A2A28`; border `#2C2C2A`, borderStrong `#383835`.
- Ink: text `#FFF`, textSecondary `#C3C2B7`, muted `#9C9A93` (raised from `#898781` so 12px text is ≥ 6:1).
- Status (fixed, always with glyph/sign + label): good `#0CA30C`, warning `#FAB219`, serious `#EC835A`, critical `#D03B3B` (fills only). **criticalText `#EB7070`** for negative numbers as text (fill red was 3.6:1).
- Button fills carrying white text ≥ 4.5:1: accentStrong `#256ABF`, goodStrong `#0A7F0A`, criticalStrong `#B83232`. Accent `#3987E5` for links/active/icons.
- Type: hero 40/700 (one per view), h1 24, h2 18, h3 15, body 14, small 12, label 11 caps. System sans; tabular figures only in table columns.
- Radius sm 6 / md 8 / lg 12. Layout: wide ≥ 1024 (sidebar 232px, or 64px collapsed), medium ≥ 720 (tables), content max 1320.

## Components
`Page` (responsive gutter + max width), `PageHeader` (title, subtitle, back, actions), `StatusPill` (Running/Paused/Error/Stopped with glyph), `Pnl` (sign glyph + sign + colour), `StatTile` + `KpiRow` (label · value · signed delta vs named period · sub), `DataTable` (header, hairline rows, hover, row press, right-aligned numbers, cells ellipsize). Buttons got hover state, a11y role/label/state; 42/32px heights.

**`Select<T>`** (added 2026-09-23): a labeled dropdown for once a set of choices is too long or too cryptic for a chip row (a dozen bot names, say). Default form has the same shape as `Field` — uppercase micro-label above, current value + a `⌄` caret below, 44px tall. Pass **`compact`** (added 2026-09-24) to collapse that to a single 32px pill (inline micro-label + value + caret) for dense toolbars — used throughout the Journal filter strip. Trigger is accent-highlighted when the value differs from the first ("default") option; pass `emphasizeChange={false}` to suppress that for pure-ordering controls (e.g. "Sort"). Tapping it opens the existing `Sheet` with each option as a full-width row: a radio mark, the label, and an optional right-aligned muted hint (a count, a code).

**`Sticky`** (added 2026-09-24): pins its children to the top of the nearest scrolling ancestor via CSS `position: sticky`, which react-native-web passes straight through (native builds ignore the value and render normally — harmless no-op there, since scroll-pinning isn't meaningful outside a CSS box model). Use for a filter/toolbar strip that should stay visible while a long list scrolls under it — first used on Journal's filter bar.

**Collapsible sidebar** (App.tsx, added 2026-09-24): the desktop sidebar can be minimized to a 64px icon-only rail via a toggle in the brand row (chevron «/»). Collapsed state hides labels, keyboard-shortcut badges and the full account card (replaced by a compact dot/count/dot stack); nav items, the account status and "Stop all bots" remain tappable, all keep full accessibility labels for screen readers. State persists across reloads via AsyncStorage (`xat.sidebar.collapsed`). Phone's bottom tab bar is unaffected (there's no sidebar to collapse there).

## Shell & screens
- Desktop: persistent sidebar (brand + collapse toggle, sections with 1–8 keyboard shortcuts — Dashboard, Journal, Strategies, Agents, Chart lines, Activity, Settings, Help — account equity card, live-feed status, always-visible "Stop all bots"; collapsible to an icon rail, see above); detail/editor/backtest routes open inside the content area. Phone: bottom tabs, full-screen routes.
- Dashboard: header with account/feed pills + "updated Xs ago" (account now refreshed every 10 s — it previously went stale while the websocket was up); alert banners only for real problems (errors, loss/trade limits, spread, market closed — cooldown/max-positions/session are shown quietly); KPI row with Equity hero + day change; Bots table (all strategies, Start/Stop inline, row → detail); "Today's P&L by bot" diverging bars around zero with total; Open positions table with owning bot + Close.
- Strategies: searchable table (market, status, size, stop, daily cap, Details/Backtest/Start-Stop/Delete). Activity: count-labelled type filters + search + table. Bot detail: KPI tiles, "Open now", history table with P&L column. Backtest settings in a 2-column grid. Settings/Chart lines/Agents/Connect use the same header and width rules.
- Journal: a sticky, dense filter strip (chips for period/result, compact `Select` dropdowns for side/closed-by/bot/symbol/sort — see `claude/xautotrade-trade-journal.md` for the full rationale) pinned above the scrolling KPIs/chart/trade list.

## Verified
Mobile `tsc` clean on the Windows copy; web build clean; Playwright UI suite 25/25 at 1440px and at 390px, journal UI script 16/16 (incl. the filter bar staying pinned while scrolling, on both viewport sizes), a dedicated sidebar-collapse check (collapses, navigates while collapsed, persists across reload, expands), no console errors; contrast of every text/background pair computed (all body/small text ≥ 4.5:1).
