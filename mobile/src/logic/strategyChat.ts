/** Pure rules for the per-strategy chat sheet (no React Native imports) so they can be unit-tested. */
import type { BacktestSummary, ChatButton, ChatProposal } from '../types';

export const CHAT_BUTTONS: { button: ChatButton; label: string; hint: string }[] = [
  { button: 'tune', label: 'Tune', hint: 'Suggest one improvement and test it first' },
  { button: 'diagnose', label: 'Diagnose', hint: 'Is it working? If not, why?' },
  { button: 'tighten', label: 'Tighten risk', hint: 'Make the risk settings safer' },
  { button: 'critique', label: 'Critique', hint: 'An honest second opinion' },
];

export interface WhatIfRow {
  label: string;
  before: string;
  after: string;
}

const num = (v: number | undefined, suffix = ''): string => (v === undefined || Number.isNaN(v) ? 'n/a' : `${v}${suffix}`);

/** Rows for a before/after table. Empty when the proposal has no what-if. */
export function whatIfRows(p: Pick<ChatProposal, 'whatIf'>): WhatIfRow[] {
  const w = p.whatIf;
  if (!w || w.before.error || w.after.error) return [];
  const row = (label: string, pick: (b: BacktestSummary) => string): WhatIfRow => ({ label, before: pick(w.before), after: pick(w.after) });
  return [
    row('Trades', (b) => num(b.trades)),
    row('Profit factor', (b) => num(b.profitFactor)),
    row('Net result', (b) => num(b.netProfitPct, '%')),
    row('Max drawdown', (b) => num(b.maxDrawdownPct, '%')),
  ];
}

/** Why a what-if has no numbers, if it does not. */
export function whatIfError(p: Pick<ChatProposal, 'whatIf'>): string | null {
  const e = p.whatIf?.before.error ?? p.whatIf?.after.error;
  return e ? `The test backtest failed: ${e}` : null;
}

/** Fewer than this many trades is weak evidence; the sheet says so next to the numbers. */
export const WEAK_TRADES = 30;
export const isWeakEvidence = (p: Pick<ChatProposal, 'whatIf'>): boolean =>
  !!p.whatIf && Math.min(p.whatIf.before.trades ?? 0, p.whatIf.after.trades ?? 0) < WEAK_TRADES;
