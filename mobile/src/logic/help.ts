/**
 * The text of the Help tab, as data, so a test can check that every message the app can show has an action.
 * Rule: a feature is not finished until its entry exists here.
 * Pure (no React Native imports).
 */
import { INBOX_KINDS, TESTBOARD_VERDICTS, type InboxKind } from '../types';
import { NAV, type Tab } from './nav';

export interface HelpEntry {
  id: string;
  /** Which Inbox card kind this explains, if it is about a card. */
  kind?: InboxKind;
  /** Testboard verdict this explains (Phase 2). */
  verdict?: string;
  see: string;
  means: string;
  do: string;
  /** A one-tap shortcut shown with the entry. */
  open?: { label: string; tab: Tab };
}

export interface HelpGroup {
  id: string;
  title: string;
  entries: HelpEntry[];
}

export const ROUTINE: { title: string; steps: string[] }[] = [
  {
    title: 'Every day, about 10 minutes',
    steps: [
      'Open the Inbox. Act on each card: Approve, Reject, Restart bot, Dismiss or OK.',
      'If the Inbox is empty, you are done. Close the app.',
      'If a card is red (an error, a stall or the daily loss cap), tap "What do I do?" on it before anything else.',
    ],
  },
  {
    title: 'Once a week, about 20 minutes',
    steps: [
      'If a weekly summary card is in the Inbox, read it and tap Dismiss.',
      'Open the Testboard and read the one-line verdict for each strategy.',
      'Open the Journal, set Period to 7 days, and check that the average win is bigger than the average loss.',
    ],
  },
  {
    title: 'Never needed',
    steps: [
      'Watching the Dashboard during the day. Each trade has its stop and target at the broker.',
      'Changing a strategy by hand because of one bad day. Ask in that strategy\'s chat and let the test decide.',
    ],
  },
];

const inboxCards: HelpEntry[] = [
  {
    id: 'proposal',
    kind: 'proposal',
    see: 'Proposal: an agent wants to change a strategy',
    means: 'The change was tested on data the agent did not see. The critic\'s view and, for a tested change, the before and after numbers are on the card.',
    do: 'Read the numbers. Tap Approve if the result is better and the critic does not object. Tap Reject if you are unsure; rejecting costs nothing.',
  },
  {
    id: 'proposal-loosens',
    kind: 'proposal',
    see: 'A proposal with the warning "loosens a risk limit"',
    means: 'The change raises the lot size, the risk or another limit.',
    do: 'Tap Reject unless you asked for exactly this.',
  },
  {
    id: 'gate_result',
    kind: 'gate_result',
    see: 'Stage passed or Stage failed',
    means: 'A strategy cleared or missed the pass mark of a stage. These cards start to appear when the Testboard gates arrive; they are not produced yet.',
    do: 'Nothing for now. When they appear: tap Move to next stage on a pass, and open the strategy\'s chat and tap Diagnose after a fail.',
    open: { label: 'Open Testboard', tab: 'testboard' },
  },
  {
    id: 'error',
    kind: 'error',
    see: 'Error: a bot reported an error',
    means: 'Something stopped the bot from working, for example MT5 is not connected or the broker refused an order. The card shows the message and how many times it happened.',
    do: 'Find the message under "Broker errors" below, fix the cause, then tap Restart bot. Tap Dismiss if it no longer matters. The card closes by itself when the bot starts again.',
  },
  {
    id: 'stall',
    kind: 'stall',
    see: 'Bot stalled: no new bar for three bars while the market is open',
    means: 'The bot is running but the price feed has stopped. Usually MT5 lost its connection.',
    do: 'Open MT5 on the PC. If it shows "No connection", fix the internet or log in again. Then tap Restart bot.',
  },
  {
    id: 'losing_streak',
    kind: 'losing_streak',
    see: 'Losing streak: five losing trades in a row on one strategy',
    means: 'A heads-up, not an emergency. The bot keeps its own limits by itself.',
    do: 'Open that strategy\'s chat on the Strategies tab and tap Diagnose. Do not raise the lot size to win it back. Tap Dismiss when you have read it; a winning trade also closes the card.',
    open: { label: 'Open Strategies', tab: 'strategies' },
  },
  {
    id: 'safety-cap',
    kind: 'safety_action',
    see: 'Daily loss cap hit (red card)',
    means: 'The account lost 3% of the day\'s starting equity. Every bot was paused and the positions the bots opened were closed. Positions you opened by hand were not touched.',
    do: 'Stop for the day and tap OK. After 00:00 UTC (05:30 IST), read today in the Journal, then tap Restart bot on one strategy at a time.',
    open: { label: 'Open Journal', tab: 'journal' },
  },
  {
    id: 'safety-outage',
    kind: 'safety_action',
    see: 'A bot was left paused after an outage',
    means: 'The server was off for more than 30 minutes, so the bot did not restart by itself. The market may have moved while nothing was watching.',
    do: 'Check that MT5 is open and logged in and that the open positions look right. Then tap Restart bot on each card you want running.',
  },
  {
    id: 'claude_unavailable',
    kind: 'claude_unavailable',
    see: 'Claude not available',
    means: 'The agents could not reach Claude (signed out, or a limit was reached). Trading continues with the saved strategies.',
    do: 'Open a terminal on the PC, run claude, and log in again. Then tap Dismiss; the card also closes by itself the next time an agent answers.',
  },
  {
    id: 'digest',
    kind: 'digest',
    see: 'Summary: what traded, what was learned, what needs you',
    means: 'A report, not a request.',
    do: 'Read it, then tap Dismiss.',
  },
];

const brokerErrors: HelpEntry[] = [
  {
    id: 'err-autotrading',
    see: 'Error 10027: AutoTrading disabled',
    means: 'MetaTrader 5 is refusing automated orders.',
    do: 'Click the Algo Trading button in the MT5 toolbar so it turns green. Then tap Restart bot.',
  },
  {
    id: 'err-invalid-stops',
    see: 'Invalid stops',
    means: 'The stop or target is too close to the price for this symbol.',
    do: 'Open the strategy\'s chat, ask "widen the stop so it is legal", and approve the proposal.',
    open: { label: 'Open Strategies', tab: 'strategies' },
  },
  {
    id: 'err-no-money',
    see: 'Not enough money',
    means: 'The lot is too big for the free margin.',
    do: 'Lower the lot in the strategy\'s risk settings, or tap Tighten risk in its chat and approve the proposal.',
  },
  {
    id: 'err-market-closed',
    see: 'Market closed',
    means: 'The market is not trading right now. This is normal at night and over the weekend.',
    do: 'Nothing. The bot trades again when the market opens.',
  },
  {
    id: 'err-filling',
    see: 'Unsupported filling mode',
    means: 'The server is forcing an order type this broker does not accept for the symbol.',
    do: 'Remove MT5MCP_FILL_MODE from server/.env so the server picks the mode per symbol, then restart the server.',
  },
];

const savingErrors: HelpEntry[] = [
  {
    id: 'save-target',
    see: '"Target ... is smaller than 1.5 × the stop" or "Reward:risk ... is below the minimum"',
    means: 'The target must be at least 1.5 times the stop.',
    do: 'Raise the target or lower the stop until target divided by stop is 1.5 or more.',
  },
  {
    id: 'save-missing',
    see: '"No stop-loss" or "No take-profit"',
    means: 'Every strategy must have both a stop and a target.',
    do: 'Set both. A strategy missing either one cannot be saved.',
  },
  {
    id: 'save-spread',
    see: 'The bot says "Spread ... is more than 15% of the ... stop" (in a backtest: many skipped trades)',
    means: 'The stop is too tight for this market\'s cost, so the bot skips the trade.',
    do: 'Widen the stop. On gold with a 35-point spread the stop needs to be about 235 points or more.',
  },
  {
    id: 'save-maxlot',
    see: 'Lot smaller than expected',
    means: 'The size was cut to your maximum lot (0.5 by default, 0.2 on gold). That is the limit working.',
    do: 'Leave it. Change the maximum lot in the risk settings only if you really mean to.',
  },
];

const notTrading: HelpEntry[] = [
  {
    id: 'bot-flat',
    see: 'Flat window (end of day or weekend): positions closed, no new entries',
    means: 'From 21:45 UTC (03:15 IST) and over the weekend bots close their trades and open none.',
    do: 'Nothing. The bot trades again when the window ends.',
  },
  {
    id: 'bot-history',
    see: 'Waiting for history',
    means: 'The bot has not got enough past bars to calculate its indicators yet.',
    do: 'Wait a few minutes. If it stays, check that the symbol is offered by your broker.',
  },
  {
    id: 'bot-nostop',
    see: 'No stop distance available yet',
    means: 'The stop is based on ATR, which is still warming up, so no order was placed.',
    do: 'Wait for the next bars. Nothing is wrong.',
  },
];

export const WHEN_YOU_SEE: HelpGroup[] = [
  { id: 'inbox', title: 'Inbox cards', entries: inboxCards },
  { id: 'broker', title: 'Broker errors', entries: brokerErrors },
  { id: 'saving', title: 'Saving a strategy', entries: savingErrors },
  { id: 'notrading', title: 'Why a bot is not trading', entries: notTrading },
];

/** Testboard verdicts (Phase 2). Empty in Phase 1; the test checks every verdict in TESTBOARD_VERDICTS has one. */
export const VERDICT_ENTRIES: HelpEntry[] = [];

export const TAB_ACTIONS: { tab: Tab; line: string }[] = [
  { tab: 'dashboard', line: 'Look, do not act. The one button is Stop all bots, for when you want everything closed now.' },
  { tab: 'inbox', line: 'Act on every card. This is the only tab you must open each day.' },
  { tab: 'strategies', line: 'Create a strategy, start or stop a bot, run a backtest. Tap the chat button on a row to ask about that strategy.' },
  { tab: 'testboard', line: 'Read each strategy\'s verdict. Tap Move to next stage when one has passed.' },
  { tab: 'journal', line: 'Check results by period. Compare the average win with the average loss. Export to CSV if you want.' },
  { tab: 'agents', line: 'Ask a general question, by typing or by voice. For one strategy, use its own chat on the Strategies tab.' },
  { tab: 'profile', line: 'Reconnect to the server, see the account, and see how many Claude calls were used today.' },
  { tab: 'help', line: 'This page.' },
];

export const allEntries = (): HelpEntry[] => [...WHEN_YOU_SEE.flatMap((g) => g.entries), ...VERDICT_ENTRIES];

export const entryById = (id: string): HelpEntry | undefined => allEntries().find((e) => e.id === id);

/** Which Help entry a "What do I do?" link on an Inbox card should open. */
export function helpEntryIdFor(item: { kind: InboxKind; title?: string; body?: string }): string {
  if (item.kind === 'safety_action') return /outage/i.test(item.title ?? '') ? 'safety-outage' : 'safety-cap';
  if (item.kind === 'proposal' && /loosens/i.test(`${item.title ?? ''} ${item.body ?? ''}`)) return 'proposal-loosens';
  return allEntries().find((e) => e.kind === item.kind)?.id ?? 'proposal';
}

export { INBOX_KINDS, TESTBOARD_VERDICTS, NAV };
