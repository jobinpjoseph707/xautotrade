import type { MarketStatus } from '../types';

/**
 * "Which markets are trading right now?" for the Help tab.
 * The broker decides what is open; this file only chooses which symbols to ask about,
 * sorts the answer into three groups, and holds the usual hours as plain text.
 */

export interface WatchedMarket {
  symbol: string;
  name: string;
  group: 'Metals' | 'Forex' | 'Crypto' | 'Indices' | 'Energy';
}

/** The markets worth checking at a glance. A broker that does not list one just shows it as "not on this account". */
export const WATCHLIST: WatchedMarket[] = [
  { symbol: 'XAUUSD', name: 'Gold', group: 'Metals' },
  { symbol: 'XAGUSD', name: 'Silver', group: 'Metals' },
  { symbol: 'EURUSD', name: 'Euro / US dollar', group: 'Forex' },
  { symbol: 'GBPUSD', name: 'Pound / US dollar', group: 'Forex' },
  { symbol: 'USDJPY', name: 'US dollar / Yen', group: 'Forex' },
  { symbol: 'AUDUSD', name: 'Australian dollar / US dollar', group: 'Forex' },
  { symbol: 'USDCAD', name: 'US dollar / Canadian dollar', group: 'Forex' },
  { symbol: 'USDCHF', name: 'US dollar / Swiss franc', group: 'Forex' },
  { symbol: 'BTCUSD', name: 'Bitcoin', group: 'Crypto' },
  { symbol: 'ETHUSD', name: 'Ethereum', group: 'Crypto' },
  { symbol: 'US30', name: 'Dow Jones 30', group: 'Indices' },
  { symbol: 'NAS100', name: 'Nasdaq 100', group: 'Indices' },
  { symbol: 'USOIL', name: 'US crude oil', group: 'Energy' },
];

export type MarketGroupKey = 'open' | 'closed' | 'unavailable';

export interface MarketRow {
  symbol: string;
  name: string;
  group: WatchedMarket['group'];
  state: MarketGroupKey;
  /** One plain sentence, e.g. why it cannot trade. */
  note: string;
  spreadPoints: number | null;
  bid: number | null;
  ask: number | null;
}

export interface MarketsNow {
  open: MarketRow[];
  closed: MarketRow[];
  unavailable: MarketRow[];
}

/** Can a bot open a new position in this market right now? Same meaning as the pill on the Dashboard. */
export function tradingNow(m: Pick<MarketStatus, 'available' | 'tradeMode' | 'open'>): MarketGroupKey {
  if (!m.available || m.tradeMode === 'disabled' || m.tradeMode === 'close_only') return 'unavailable';
  if (m.open === true) return 'open';
  return 'closed'; // closed, or not known yet: never say "open" without proof
}

/** Sort the broker's answers into open / closed / not available. Symbols the broker did not answer for count as unavailable. */
export function sortMarkets(statuses: MarketStatus[], watch: WatchedMarket[] = WATCHLIST): MarketsNow {
  const bySymbol = new Map(statuses.map((s) => [s.symbol.toUpperCase(), s]));
  const out: MarketsNow = { open: [], closed: [], unavailable: [] };
  for (const w of watch) {
    const s = bySymbol.get(w.symbol);
    const state: MarketGroupKey = s ? tradingNow(s) : 'unavailable';
    const note = !s
      ? 'Not on this account.'
      : state === 'open'
        ? 'Open for new trades.'
        : state === 'unavailable'
          ? s.tradeMode === 'close_only'
            ? 'Close-only: open trades can be closed, no new ones.'
            : s.reason ?? 'Not on this account.'
          : s.open === false
            ? s.reason ?? 'Closed right now.'
            : 'No price yet, so it is not counted as open.';
    out[state].push({ symbol: w.symbol, name: w.name, group: w.group, state, note, spreadPoints: s?.spreadPoints ?? null, bid: s?.bid ?? null, ask: s?.ask ?? null });
  }
  // Tightest spread first: that is the cheapest market to trade right now.
  out.open.sort((a, b) => (a.spreadPoints ?? Infinity) - (b.spreadPoints ?? Infinity));
  return out;
}

/** The usual hours, as plain text. These are typical; the live list above is what counts. Times are Indian Standard Time (IST, UTC+5:30), with UTC in brackets. */
export const USUAL_HOURS: { group: WatchedMarket['group']; text: string }[] = [
  { group: 'Forex', text: 'Opens Monday about 03:30 IST (Sunday 22:00 UTC), closes Saturday about 03:30 IST (Friday 22:00 UTC). Busiest 12:30 to 21:30 IST for London (07:00 to 16:00 UTC) and 17:30 to 02:30 IST for New York (12:00 to 21:00 UTC).' },
  { group: 'Metals', text: 'Gold and silver follow the forex week, with a short daily break around 03:30 IST (22:00 UTC).' },
  { group: 'Crypto', text: 'Bitcoin and Ethereum trade around the clock, weekends included, if your broker offers them.' },
  { group: 'Indices', text: 'Follow their own exchange hours, mostly 19:00 to 01:30 IST (13:30 to 20:00 UTC) on weekdays for US indices, with a break.' },
  { group: 'Energy', text: 'Oil follows the metals week, with a daily break around 03:30 IST (22:00 UTC).' },
];

/** India has no daylight saving, so IST is always UTC plus five hours thirty minutes. */
export const IST_NOTE = 'India Standard Time (IST) is UTC+5:30 all year. Times after midnight fall on the next day in India.';

export function summaryLine(n: MarketsNow): string {
  const total = n.open.length + n.closed.length + n.unavailable.length;
  if (n.open.length === 0) return `None of ${total} watched markets is open for new trades right now.`;
  return `${n.open.length} of ${total} watched markets are open for new trades right now.`;
}
