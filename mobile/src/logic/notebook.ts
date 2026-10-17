import type { Notebook } from '../types';

export const NOTEBOOK_TITLE = 'Agent notebooks';
export const NOTEBOOK_NOTE =
  'Each agent reads only its own trusted lessons, and only for a strategy in exactly the same market (symbol, timeframe, and how volatile, trending and costly it is). ' +
  'A lesson is trusted after at least 5 agreeing results from changes that had 30 or more demo trades behind them, and fades over weeks. ' +
  'Where trusted lessons disagree, the agent leaves that setting alone.';

export const trustedCount = (b: Notebook): number => b.lessons.filter((l) => l.trusted).length;

export function notebookEmpty(b: Notebook): boolean {
  return b.lessons.length === 0 && b.holds.length === 0 && b.notes.length === 0;
}

export function holdText(h: { setting: string; market: string }): string {
  return `On hold: ${h.setting} in ${h.market} (trusted results disagree).`;
}

export function ignoredText(n: number): string | null {
  return n > 0 ? `${n} scored change${n === 1 ? '' : 's'} not counted yet (too few demo trades, or several things changed at once).` : null;
}
