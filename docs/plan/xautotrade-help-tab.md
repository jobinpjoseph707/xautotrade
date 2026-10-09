# XAutoTrade — Help / user manual tab (2026-09-23)

New sidebar tab **Help** (last item, shortcut 8) — a static in-app manual, no API calls needed.

## What it covers
- How the app works overall: strategies → bots, the approval gate (agents only propose, you approve), demo/paper/live, keyboard shortcuts.
- One card per tab (Dashboard, Journal, Strategies, Agents, Chart lines, Activity, Settings), each with a short always-visible summary and expandable "Explain" blocks (reusing the app's existing `Explain` component) for how-to detail and FAQs: Stop all, journal filters, the two ways to create a strategy, how proposals are checked, voice chat, the Learning panel, drawing on the real MT5 chart, etc.
- Ends by pointing the user at the Agents tab (typed or spoken) for anything not covered.

## Files
- mobile/src/screens/HelpScreen.tsx (new).
- mobile/App.tsx — NAV entry + Tab type + route.

## Tests
Server 170/170 (unchanged), UI regression 25/25 (added a Help-tab check), journal 12/12, voice 16/16 — all unaffected by this change since it only adds a tab.
