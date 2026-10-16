/**
 * The lesson ledger. A lesson belongs to one agent, one market (symbol + timeframe + market state)
 * and one setting. It is built only from approved changes that were scored on 30 or more real demo
 * trades made AFTER the change. There is no all-markets lesson, and nothing is shared between agents.
 *
 * Numbers that are my choices (the plan fixes the first four; the rest are mine) live here, in one place:
 *   trust needs 5 agreeing outcomes (was 3); old outcomes lose half their weight every 14 days
 *   (90 for structural changes); the agreeing outcomes together must still weigh at least 2.5 (five
 *   outcomes that are each one half-life old); and they must hold at least 75% of the weight.
 */
import { TIMEFRAME_MS, type Timeframe } from '../engine/types.js';
import { describeSignature } from './signature.js';
import type { ChangeRecord, MarketSnapshot } from './types.js';

export const MIN_OUTCOME_TRADES = 30;
export const MIN_AGREEING = 5;
export const MIN_AGREEING_WEIGHT = 2.5;
export const DOMINANCE = 0.75;
export const HALF_LIFE_DAYS = { market: 14, structural: 90 } as const;
const DAY = 86_400_000;

export type Level = 'low' | 'mid' | 'high';
export interface MarketState {
  volatility: Level;
  trend: Level;
  spread: Level;
}

/**
 * Where low, mid and high start. Low is below `lowBelow`; high is `highFrom` and up; mid is between.
 *  - volatility: the snapshot's average true range (% of price), divided by the square root of the
 *    timeframe in minutes, so a 5-minute bar is not called "high" just for being longer than a 1-minute bar.
 *  - trend: the size (either direction) of the net move over the snapshot, in percent.
 *  - spread: the average spread in points.
 */
export const MARKET_EDGES = {
  volatility: { lowBelow: 0.01, highFrom: 0.025 },
  trend: { lowBelow: 0.3, highFrom: 1 },
  spread: { lowBelow: 15, highFrom: 35 },
} as const;

const level = (v: number, e: { lowBelow: number; highFrom: number }): Level => (v < e.lowBelow ? 'low' : v >= e.highFrom ? 'high' : 'mid');

/** The market state a saved snapshot describes, or null when it lacks something (then it cannot key a lesson). */
export function marketState(snap: MarketSnapshot | null | undefined): MarketState | null {
  if (!snap || snap.avgSpreadPoints == null || !Number.isFinite(snap.atrPct) || !Number.isFinite(snap.trendPct)) return null;
  const ms = TIMEFRAME_MS[snap.timeframe];
  if (!ms) return null;
  const minutes = ms / 60_000;
  return {
    volatility: level(snap.atrPct / Math.sqrt(minutes), MARKET_EDGES.volatility),
    trend: level(Math.abs(snap.trendPct), MARKET_EDGES.trend),
    spread: level(snap.avgSpreadPoints, MARKET_EDGES.spread),
  };
}

export interface MarketKey {
  symbol: string;
  timeframe: Timeframe;
  state: MarketState;
}

export const keyString = (k: MarketKey): string => `${k.symbol}|${k.timeframe}|vol:${k.state.volatility}|trend:${k.state.trend}|spread:${k.state.spread}`;

/** The key for a market, or null when the snapshot does not give a full state. */
export function marketKey(symbol: string, timeframe: Timeframe, snap: MarketSnapshot | null | undefined): MarketKey | null {
  const state = marketState(snap);
  return state ? { symbol, timeframe, state } : null;
}

export const settingOf = (signature: string): string => signature.split(':')[0];
export const changeOf = (signature: string): string => signature.split(':')[1] ?? 'changed';

/** Changes to what the strategy IS (indicators, rules, market) fade slowly; tuning a number fades fast. */
export function isStructural(signature: string): boolean {
  const s = settingOf(signature);
  return s.startsWith('ind.') || s === 'indicators' || s.startsWith('rules.') || s === 'create' || s === 'symbol' || s === 'timeframe';
}

export const halfLifeDays = (signature: string): number => (isStructural(signature) ? HALF_LIFE_DAYS.structural : HALF_LIFE_DAYS.market);

export interface Outcome {
  id: string;
  agent: string;
  key: MarketKey;
  signature: string;
  score: 'helped' | 'hurt' | 'inconclusive';
  at: number;
  trades: number;
}

export interface Ignored {
  id: string;
  why: string;
}

/** Which scored changes can be evidence at all, and which are ignored (with the reason). */
export function outcomesFrom(records: ChangeRecord[]): { outcomes: Outcome[]; ignored: Ignored[] } {
  const outcomes: Outcome[] = [];
  const ignored: Ignored[] = [];
  for (const r of records) {
    if (r.status !== 'approved' || !['helped', 'hurt', 'inconclusive'].includes(r.score)) continue;
    const no = (why: string) => void ignored.push({ id: r.id, why });
    const trades = r.followUp?.demo?.trades ?? 0;
    if (trades < MIN_OUTCOME_TRADES) { no(`only ${trades} trades after the change (need ${MIN_OUTCOME_TRADES})`); continue; }
    if (r.signatures.length !== 1) { no('several things changed at once, so the result cannot be pinned on one'); continue; }
    if (!r.symbol || !r.timeframe) { no('no market recorded'); continue; }
    const key = marketKey(r.symbol, r.timeframe, r.market);
    if (!key) { no('the saved market snapshot is missing or incomplete'); continue; }
    outcomes.push({ id: r.id, agent: r.agent, key, signature: r.signatures[0], score: r.score as Outcome['score'], at: r.scoredAt ?? r.createdAt, trades });
  }
  return { outcomes, ignored };
}

export interface LedgerLesson {
  agent: string;
  /** keyString of the market this lesson holds in. */
  key: string;
  market: MarketKey;
  signature: string;
  setting: string;
  change: string;
  verdict: 'helped' | 'hurt';
  agree: number;
  against: number;
  unclear: number;
  weightAgree: number;
  weightAgainst: number;
  /** weightAgree / (weightAgree + weightAgainst) */
  share: number;
  trusted: boolean;
  lastAt: number;
  halfLifeDays: number;
}

/** Every (agent, market, signature) that has at least one decisive outcome, with whether it is trusted yet. */
export function buildLedger(records: ChangeRecord[], now = Date.now()): { lessons: LedgerLesson[]; ignored: Ignored[] } {
  const { outcomes, ignored } = outcomesFrom(records);
  const groups = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    const g = `${o.agent}\u0000${keyString(o.key)}\u0000${o.signature}`;
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const lessons: LedgerLesson[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const hl = halfLifeDays(first.signature);
    const weight = (o: Outcome) => Math.pow(0.5, Math.max(0, now - o.at) / DAY / hl);
    const side = (s: Outcome['score']) => {
      const l = list.filter((o) => o.score === s);
      return { n: l.length, w: l.reduce((a, o) => a + weight(o), 0) };
    };
    const helped = side('helped');
    const hurt = side('hurt');
    const unclear = list.filter((o) => o.score === 'inconclusive').length;
    if (helped.n + hurt.n === 0) continue;
    // On a tie the cautious reading wins.
    const verdict: LedgerLesson['verdict'] = hurt.w >= helped.w ? 'hurt' : 'helped';
    const agree = verdict === 'hurt' ? hurt : helped;
    const against = verdict === 'hurt' ? helped : hurt;
    const share = agree.w + against.w > 0 ? agree.w / (agree.w + against.w) : 0;
    lessons.push({
      agent: first.agent,
      key: keyString(first.key),
      market: first.key,
      signature: first.signature,
      setting: settingOf(first.signature),
      change: changeOf(first.signature),
      verdict,
      agree: agree.n,
      against: against.n,
      unclear,
      weightAgree: agree.w,
      weightAgainst: against.w,
      share,
      trusted: agree.n >= MIN_AGREEING && agree.w >= MIN_AGREEING_WEIGHT && share >= DOMINANCE,
      lastAt: Math.max(...list.map((o) => o.at)),
      halfLifeDays: hl,
    });
  }
  lessons.sort((a, b) => Number(b.trusted) - Number(a.trusted) || b.share - a.share || b.agree - a.agree || a.signature.localeCompare(b.signature) || a.key.localeCompare(b.key) || a.agent.localeCompare(b.agent));
  return { lessons, ignored };
}

export interface Hold {
  agent: string;
  key: string;
  setting: string;
}

/** Which way a trusted lesson says the setting should move: -1 down, +1 up, 0 it cannot say. */
function advice(l: LedgerLesson): -1 | 0 | 1 {
  const up = l.change === 'up' || l.change === 'on';
  const down = l.change === 'down' || l.change === 'off';
  if (!up && !down) return 0;
  const movedUp = up;
  // Moving up helped, or moving down hurt -> go up. Moving down helped, or moving up hurt -> go down.
  return (movedUp && l.verdict === 'helped') || (!movedUp && l.verdict === 'hurt') ? 1 : -1;
}

/** Settings where two trusted lessons in the same market point opposite ways. The agent holds on these. */
export function holdsFrom(lessons: LedgerLesson[]): Hold[] {
  const seen = new Map<string, { hold: Hold; dirs: Set<number> }>();
  for (const l of lessons) {
    if (!l.trusted) continue;
    const a = advice(l);
    if (a === 0) continue;
    const id = `${l.agent}\u0000${l.key}\u0000${l.setting}`;
    const e = seen.get(id) ?? { hold: { agent: l.agent, key: l.key, setting: l.setting }, dirs: new Set<number>() };
    e.dirs.add(a);
    seen.set(id, e);
  }
  return [...seen.values()].filter((e) => e.dirs.size > 1).map((e) => e.hold).sort((a, b) => a.setting.localeCompare(b.setting));
}

/** A sentence for the person reading the Learning panel (never for a prompt). */
export function lessonText(l: LedgerLesson): string {
  const what = describeSignature(l.signature);
  const where = `${l.market.symbol} ${l.market.timeframe}, volatility ${l.market.state.volatility}, trend ${l.market.state.trend}, spread ${l.market.state.spread}`;
  const base = `${what[0].toUpperCase()}${what.slice(1)} in ${where}: ${l.verdict} in ${l.agree} outcome${l.agree === 1 ? '' : 's'}${l.against ? `, the other way in ${l.against}` : ''}.`;
  return l.trusted ? base : `${base} Not trusted yet (needs ${MIN_AGREEING} agreeing, recent enough).`;
}
