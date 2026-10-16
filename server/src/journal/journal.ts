/**
 * Trade journal: one row per position a bot opened, assembled from
 *  - the trade log (entries + closes, which never get pruned),
 *  - MT5 deal history per position (exact entry/exit price, profit incl.
 *    commission/swap, and WHY it closed: take-profit, stop-loss, manual…),
 *  - the broker's currently open positions (floating P&L).
 * Pure: everything is passed in, so it is unit-testable.
 */
import type { BrokerPosition, PositionHistory } from '../broker/types.js';
import { ownCloses, positionIdOf } from '../live/reconcile.js';
import type { LogEntry } from '../store.js';

export type ExitReason = 'tp' | 'sl' | 'stop_out' | 'exit_rule' | 'opposite' | 'panic' | 'manual' | 'bot' | 'unknown';
export type Outcome = 'win' | 'loss' | 'breakeven' | 'open' | 'unknown';

export interface JournalTrade {
  positionId: string;
  strategyId: string | null;
  strategyName: string;
  symbol: string;
  side: 'long' | 'short' | null;
  volume: number | null;
  status: 'open' | 'closed' | 'unrecorded';
  outcome: Outcome;
  openTime: number | null;
  closeTime: number | null;
  durationMs: number | null;
  openPrice: number | null;
  closePrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Planned reward:risk from the entry's stop and target (null if either is missing). */
  plannedRR: number | null;
  /** Net result: realised (closed) or floating (open). Includes commission/swap when MT5 reported them. */
  profit: number | null;
  commission: number | null;
  swap: number | null;
  exitReason: ExitReason | null;
  spreadPoints: number | null;
  /** 'broker' = MT5 deal history confirmed the numbers; 'log' = from the bot's own log only. */
  source: 'broker' | 'log';
}

export interface JournalInput {
  logs: LogEntry[];
  strategyNames: Map<string, string>;
  histories: Map<string, PositionHistory>;
  openPositions: BrokerPosition[];
  tagOf: (strategyId: string) => string;
  /** Strategies left out of the journal entirely (test rigs), so they never change a total. */
  excludeStrategyIds?: Set<string>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const EPS = 0.005;

function parseEntry(message: string): { side: 'long' | 'short' | null; volume: number | null; symbol: string | null; price: number | null } {
  const m = message.match(/Opened (LONG|SHORT) ([\d.]+) (\S+) @ ~?([\d.]+)/);
  if (!m) return { side: null, volume: null, symbol: null, price: null };
  return { side: m[1] === 'LONG' ? 'long' : 'short', volume: Number(m[2]), symbol: m[3], price: Number(m[4]) };
}

function reasonOf(close: LogEntry | undefined, h: PositionHistory | undefined): ExitReason | null {
  if (!close && !h) return null;
  if (close?.event === 'panic_close') return 'panic';
  if (close?.event === 'exit') return /opposite/i.test(close.message) ? 'opposite' : 'exit_rule';
  const r = (h?.reason ?? (close?.data as { reason?: string } | undefined)?.reason) as string | undefined;
  if (r === 'tp' || r === 'sl' || r === 'stop_out' || r === 'manual' || r === 'bot') return r;
  return 'unknown';
}

export function buildJournal(input: JournalInput): JournalTrade[] {
  const entries = new Map<string, LogEntry>();
  const byStrategy = new Map<string, LogEntry[]>();
  for (const l of input.logs) {
    if (l.event === 'entry') {
      const id = positionIdOf(l);
      if (id && !entries.has(id)) entries.set(id, l);
    }
    const k = l.strategyId ?? '';
    byStrategy.set(k, [...(byStrategy.get(k) ?? []), l]);
  }
  // One close per position, and only closes of this strategy's own positions.
  const closes = new Map<string, LogEntry>();
  for (const [sid, list] of byStrategy) {
    for (const c of ownCloses(list, sid ? input.tagOf(sid) : undefined)) {
      const id = positionIdOf(c);
      if (id && !closes.has(id)) closes.set(id, c);
    }
  }
  const open = new Map(input.openPositions.map((p) => [p.id, p]));

  // Bot-tagged open positions with no entry row (e.g. opened before logging) still belong in the journal.
  const tagToStrategy = new Map([...input.strategyNames.keys()].map((id) => [input.tagOf(id), id]));
  const orphanOpen = input.openPositions.filter((p) => !entries.has(p.id) && tagToStrategy.has((p.comment ?? '').slice(0, 12)));

  const ids = new Set<string>([...entries.keys(), ...closes.keys(), ...orphanOpen.map((p) => p.id)]);
  const out: JournalTrade[] = [];
  for (const id of ids) {
    const e = entries.get(id);
    const c = closes.get(id);
    const h = input.histories.get(id);
    const o = open.get(id);
    const ed = (e?.data ?? {}) as Record<string, unknown>;
    const cd = (c?.data ?? {}) as Record<string, unknown>;
    const parsed = e ? parseEntry(e.message) : { side: null, volume: null, symbol: null, price: null };
    const strategyId = e?.strategyId ?? c?.strategyId ?? (o ? tagToStrategy.get((o.comment ?? '').slice(0, 12)) ?? null : null);

    const side = ((ed.side as string) ?? parsed.side ?? (cd.side as string) ?? h?.side ?? o?.side ?? null) as JournalTrade['side'];
    const symbol = String(ed.symbol ?? parsed.symbol ?? cd.symbol ?? h?.symbol ?? o?.symbol ?? '?');
    const volume = num(ed.lots) ?? parsed.volume ?? num(cd.volume) ?? h?.volume ?? o?.volume ?? null;
    const openPrice = h?.entryPrice ?? num(cd.openPrice) ?? o?.openPrice ?? num(ed.entryPrice) ?? parsed.price;
    const stopLoss = num(ed.sl) ?? num(cd.stopLoss) ?? o?.stopLoss ?? null;
    const takeProfit = num(ed.tp) ?? num(cd.takeProfit) ?? o?.takeProfit ?? null;

    const status: JournalTrade['status'] = o ? 'open' : c || h?.closed ? 'closed' : 'unrecorded';
    const profit = status === 'open' ? o!.profit : h?.closed ? h.profit : num(cd.profit);
    const closePrice = status === 'closed' ? h?.closePrice ?? num(cd.closePrice) ?? num(cd.currentPrice) : null;
    const openTime = e?.ts ?? null;
    const closeTime = status === 'closed' ? c?.ts ?? null : null;

    let plannedRR: number | null = null;
    if (openPrice != null && stopLoss != null && takeProfit != null && Math.abs(openPrice - stopLoss) > 0) {
      plannedRR = Math.round((Math.abs(takeProfit - openPrice) / Math.abs(openPrice - stopLoss)) * 100) / 100;
    }

    const outcome: Outcome =
      status === 'open' ? 'open' : profit == null ? 'unknown' : profit > EPS ? 'win' : profit < -EPS ? 'loss' : 'breakeven';

    out.push({
      positionId: id,
      strategyId,
      strategyName: (strategyId && input.strategyNames.get(strategyId)) || (strategyId ?? 'Unknown bot'),
      symbol,
      side,
      volume,
      status,
      outcome,
      openTime,
      closeTime,
      durationMs: (() => {
        const end = status === 'open' ? Date.now() : closeTime;
        return openTime != null && end != null ? Math.max(0, end - openTime) : null;
      })(),
      openPrice,
      closePrice,
      currentPrice: o?.currentPrice ?? null,
      stopLoss,
      takeProfit,
      plannedRR,
      profit: profit == null ? null : Math.round(profit * 100) / 100,
      commission: o ? o.commission : num(cd.commission),
      swap: o ? o.swap : num(cd.swap),
      exitReason: status === 'closed' ? reasonOf(c, h) : null,
      spreadPoints: num(ed.spreadPoints),
      source: h ? 'broker' : 'log',
    });
  }
  const hidden = input.excludeStrategyIds;
  const shown = hidden && hidden.size ? out.filter((t) => !(t.strategyId && hidden.has(t.strategyId))) : out;
  return shown.sort((a, b) => (b.openTime ?? b.closeTime ?? 0) - (a.openTime ?? a.closeTime ?? 0));
}
