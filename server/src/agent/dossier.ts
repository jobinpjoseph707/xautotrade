/**
 * The dossier: everything the agents may know about ONE strategy, built by the server from data it
 * already holds. Scope rules: lessons come from the ledger (same agent, exact market); notes and past
 * attempts are shown only for the same symbol and timeframe; the whole thing has a fixed size.
 */
import type { JournalTrade } from '../journal/journal.js';
import type { Strategy } from '../engine/types.js';
import { buildLedger, holdsFrom, keyString, marketKey, marketState, settingOf } from '../learning/ledger.js';
import type { RecordStore } from '../learning/records.js';
import { retrieve } from '../learning/retrieve.js';
import type { Trial } from '../learning/trials.js';
import type { ChangeRecord, MarketSnapshot } from '../learning/types.js';
import type { AgentNote } from './types.js';

export const MAX_DOSSIER_CHARS = 12_000;
export const LESSON_AGENTS = ['optimizer', 'doctor', 'guard', 'critic', 'strategist'] as const;
const DAY = 86_400_000;
/** How far back the evidence reaches. The theory's unseen test bars all come BEFORE this. */
export const DEMO_WINDOW_DAYS = Number(process.env.AGENT_EVIDENCE_DAYS ?? 14);

export interface DossierDeps {
  strategy(id: string): Strategy | null;
  changes: RecordStore<ChangeRecord>;
  notes: RecordStore<AgentNote>;
  trials: RecordStore<Trial>;
  stage(s: Strategy): string;
  tier(id: string): number;
  /** Closed demo trades of one strategy in [from, to), oldest first. */
  trades(strategyId: string, from: number, to: number): JournalTrade[];
  market(s: Strategy): Promise<MarketSnapshot | null>;
  now?(): number;
}

interface Slice {
  key: string;
  trades: number;
  net: number;
  winRatePct: number;
}

export interface Dossier {
  generatedAt: number;
  strategy: Strategy;
  stage: string;
  tier: number;
  market: { symbol: string; timeframe: string; key: string | null; state: unknown; snapshot: MarketSnapshot | null };
  demo: { days: number; trades: number; net: number; profitFactor: number; avgWin: number; avgLoss: number; winRatePct: number; maxDrawdown: number } | null;
  /** Results cut by direction, hour (UTC) and spread level. Market state per trade is not recorded, so spread is the one market-state slice. */
  slices: { direction: Slice[]; hourUtc: Slice[]; spread: Slice[] };
  /** This agent-by-agent, only exact-market trusted lessons, as data rows. */
  lessons: Record<string, string[]>;
  /** Settings trusted lessons disagree about in this market. No change may touch them. */
  holds: string[];
  theories: { attempts: { claim: string; status: string; reason: string; at: number }[] };
  recentChanges: { summary: string; score: string; note: string | null; at: number }[];
  notes: { agent: string; text: string; evidence: string[]; at: number }[];
  /** What had to be cut to stay under the size limit. */
  trimmed: string[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function slice(trades: JournalTrade[], keyOf: (t: JournalTrade) => string | null): Slice[] {
  const m = new Map<string, JournalTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    if (k) m.set(k, [...(m.get(k) ?? []), t]);
  }
  return [...m]
    .map(([key, list]) => ({
      key,
      trades: list.length,
      net: r2(list.reduce((a, t) => a + (t.profit ?? 0), 0)),
      winRatePct: Math.round((list.filter((t) => (t.profit ?? 0) > 0).length / list.length) * 100),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const spreadLevel = (p: number): string => (p < 15 ? 'low' : p >= 35 ? 'high' : 'mid');

function demoNumbers(trades: JournalTrade[], days: number): Dossier['demo'] {
  if (!trades.length) return null;
  let win = 0, loss = 0, wins = 0, losses = 0, net = 0, equity = 0, peak = 0, dd = 0;
  for (const t of trades) {
    const p = t.profit ?? 0;
    net += p;
    if (p > 0) { win += p; wins++; } else if (p < 0) { loss -= p; losses++; }
    equity += p;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return {
    days, trades: trades.length, net: r2(net), profitFactor: loss > 0 ? r2(win / loss) : win > 0 ? 999 : 0,
    avgWin: wins ? r2(win / wins) : 0, avgLoss: losses ? r2(loss / losses) : 0,
    winRatePct: Math.round((wins / trades.length) * 100), maxDrawdown: r2(dd),
  };
}

const size = (d: Dossier): number => JSON.stringify(d).length;

/** Cut the least important parts, in a fixed order, until the dossier fits. */
export function fit(d: Dossier, limit = MAX_DOSSIER_CHARS): Dossier {
  const cuts: [string, (x: Dossier) => void][] = [
    ['notes', (x) => { x.notes = x.notes.slice(0, 5); }],
    ['notes', (x) => { x.notes = []; }],
    ['recentChanges', (x) => { x.recentChanges = x.recentChanges.slice(0, 2); }],
    ['hour slices', (x) => { x.slices.hourUtc = x.slices.hourUtc.sort((a, b) => a.net - b.net).slice(0, 6); }],
    ['attempts', (x) => { x.theories.attempts = x.theories.attempts.slice(0, 2); }],
    ['recentChanges', (x) => { x.recentChanges = []; }],
    ['lessons', (x) => { for (const k of Object.keys(x.lessons)) x.lessons[k] = x.lessons[k].slice(0, 3); }],
    ['attempts', (x) => { x.theories.attempts = []; }],
    ['slices', (x) => { x.slices = { direction: x.slices.direction, hourUtc: [], spread: [] }; }],
    ['lessons', (x) => { for (const k of Object.keys(x.lessons)) if (k !== 'optimizer') x.lessons[k] = []; }],
  ];
  for (const [what, cut] of cuts) {
    if (size(d) <= limit) break;
    cut(d);
    if (!d.trimmed.includes(what)) d.trimmed.push(what);
  }
  return d;
}

export async function buildDossier(deps: DossierDeps, strategyId: string): Promise<Dossier | null> {
  const s = deps.strategy(strategyId);
  if (!s) return null;
  const now = deps.now?.() ?? Date.now();
  const history = deps.changes.all(2000);

  let snap: MarketSnapshot | null = null;
  try {
    snap = await deps.market(s);
  } catch {
    snap = null;
  }
  const key = marketKey(s.symbol, s.timeframe, snap);

  const trades = deps.trades(s.id, now - DEMO_WINDOW_DAYS * DAY, now).filter((t) => t.status === 'closed');
  const lessons: Record<string, string[]> = {};
  for (const a of LESSON_AGENTS) lessons[a] = retrieve(history, { agent: a, symbol: s.symbol, timeframe: s.timeframe, market: snap }, now).rows;
  const ledger = key ? buildLedger(history, now).lessons.filter((l) => l.trusted && l.key === keyString(key)) : [];
  const holds = [...new Set(holdsFrom(ledger.filter((l) => l.agent === 'optimizer')).map((h) => h.setting))].sort();

  const sameMarket = (x: { symbol: string | null; timeframe: string | null }): boolean => x.symbol === s.symbol && x.timeframe === s.timeframe;
  const attempts = deps.trials
    .all(200)
    .filter((t) => t.strategyId === s.id)
    .slice(0, 5)
    .map((t) => ({ claim: t.theory.claim, status: t.status, reason: t.reasons[0] ?? '', at: t.createdAt }));
  const recentChanges = history
    .filter((r) => r.strategyId === s.id && r.status === 'approved' && ['helped', 'hurt', 'inconclusive'].includes(r.score))
    .slice(0, 5)
    .map((r) => ({ summary: r.summary, score: r.score, note: r.outcomeNote ?? null, at: r.scoredAt ?? r.createdAt }));
  const notes = deps.notes
    .all(500)
    .filter((n) => sameMarket(n))
    .slice(0, 10)
    .map((n) => ({ agent: n.agent, text: n.text, evidence: n.evidence, at: n.createdAt }));

  const d: Dossier = {
    generatedAt: now,
    strategy: s,
    stage: deps.stage(s),
    tier: deps.tier(s.id),
    market: { symbol: s.symbol, timeframe: s.timeframe, key: key ? keyString(key) : null, state: marketState(snap), snapshot: snap },
    demo: demoNumbers(trades, DEMO_WINDOW_DAYS),
    slices: {
      direction: slice(trades, (t) => t.side),
      hourUtc: slice(trades, (t) => (t.openTime == null ? null : String(new Date(t.openTime).getUTCHours()).padStart(2, '0'))),
      spread: slice(trades, (t) => (t.spreadPoints == null ? null : spreadLevel(t.spreadPoints))),
    },
    lessons,
    holds,
    theories: { attempts },
    recentChanges,
    notes,
    trimmed: [],
  };
  return fit(d);
}

export { settingOf };
