/**
 * Ranks the saved strategies by backtest under the current rules (task 1.3), so
 * the owner can pick the one or two worth keeping. Pure: backtest results are
 * passed in, so tests use fixed numbers and the runner supplies real ones.
 */
export const MIN_TRADES_TO_JUDGE = 100;

export interface RankInput {
  id: string;
  name: string;
  symbol: string;
  timeframe: string;
  /** Set when the strategy breaks a rule and cannot be backtested at all. */
  refused?: string;
  trades?: number;
  profitFactor?: number;
  netProfitPct?: number;
  maxDrawdownPct?: number;
}

export type RankVerdict = 'refused' | 'unproven' | 'losing' | 'candidate';

export interface RankRow extends RankInput {
  rank: number | null;
  verdict: RankVerdict;
  note: string;
}

export function verdictOf(r: RankInput): { verdict: RankVerdict; note: string } {
  if (r.refused) return { verdict: 'refused', note: `breaks a rule: ${r.refused}` };
  const trades = r.trades ?? 0;
  if (trades < MIN_TRADES_TO_JUDGE) return { verdict: 'unproven', note: `only ${trades} trades; ${MIN_TRADES_TO_JUDGE} are needed before the numbers mean anything` };
  if ((r.profitFactor ?? 0) < 1) return { verdict: 'losing', note: `profit factor ${r.profitFactor} is below 1` };
  return { verdict: 'candidate', note: 'enough trades and profit factor of 1 or more' };
}

const ORDER: Record<RankVerdict, number> = { candidate: 0, losing: 1, unproven: 2, refused: 3 };

/** Candidates first (best profit factor first), then losing, unproven, refused. Only candidates and losing get a rank. */
export function rankStrategies(inputs: RankInput[]): RankRow[] {
  const rows = inputs.map((r) => ({ ...r, ...verdictOf(r), rank: null as number | null }));
  rows.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || (b.profitFactor ?? 0) - (a.profitFactor ?? 0) || a.name.localeCompare(b.name));
  let n = 0;
  for (const r of rows) if (r.verdict === 'candidate' || r.verdict === 'losing') r.rank = ++n;
  return rows;
}

export function formatRank(rows: RankRow[]): string[] {
  if (rows.length === 0) return ['No strategies to rank.'];
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const out = [`${pad('#', 3)}${pad('Strategy', 34)}${pad('Symbol', 9)}${pad('TF', 5)}${pad('Trades', 8)}${pad('PF', 7)}${pad('DD%', 7)}Verdict`];
  for (const r of rows) {
    out.push(
      `${pad(r.rank ?? '-', 3)}${pad(r.name.slice(0, 32), 34)}${pad(r.symbol, 9)}${pad(r.timeframe, 5)}${pad(r.trades ?? '-', 8)}${pad(r.profitFactor ?? '-', 7)}${pad(r.maxDrawdownPct ?? '-', 7)}${r.verdict} — ${r.note}`,
    );
  }
  return out;
}
