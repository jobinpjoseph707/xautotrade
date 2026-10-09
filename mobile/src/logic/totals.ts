/** Dashboard totals, kept out of the screen so they can be tested. Test strategies (`isTest`) never count. */
import type { BrokerPosition } from '../types';

/** The comment tag the server puts on a bot's orders ("XAT:<last 8 of id>"). */
export const tagOf = (strategyId: string): string => `XAT:${strategyId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;

export interface TotalsRow {
  strategy: { id: string; isTest?: boolean };
  realised: number;
  trades: number;
}

export interface Totals {
  realised: number;
  trades: number;
  floating: number;
  openCount: number;
}

/** Positions of test strategies are dropped by their order tag. */
export function realPositions(positions: BrokerPosition[], strategies: { id: string; isTest?: boolean }[]): BrokerPosition[] {
  const testTags = new Set(strategies.filter((s) => s.isTest).map((s) => tagOf(s.id)));
  return positions.filter((p) => !testTags.has((p.comment ?? '').slice(0, 12)));
}

export function dashboardTotals(rows: TotalsRow[], positions: BrokerPosition[], strategies: { id: string; isTest?: boolean }[]): Totals {
  const real = rows.filter((r) => !r.strategy.isTest);
  const open = realPositions(positions, strategies);
  return {
    realised: real.reduce((a, r) => a + r.realised, 0),
    trades: real.reduce((a, r) => a + r.trades, 0),
    floating: open.reduce((a, p) => a + p.profit, 0),
    openCount: open.length,
  };
}
