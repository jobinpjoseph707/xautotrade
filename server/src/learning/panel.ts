/**
 * What the Learning panel shows for each agent, and the markdown copy written to data/notebooks.
 * Built from the ledger only. It lists every outcome-backed lesson, trusted or not, and says which are
 * trusted; the prompt gets only trusted ones, only for the market in question (see retrieve.ts).
 */
import { buildLedger, holdsFrom, lessonText, type LedgerLesson } from './ledger.js';
import type { ChangeRecord } from './types.js';

export interface PanelLesson {
  text: string;
  trusted: boolean;
  verdict: 'helped' | 'hurt';
  agree: number;
  against: number;
  unclear: number;
  setting: string;
  change: string;
  market: string;
  lastAt: number;
}

export interface Notebook {
  agent: string;
  name?: string;
  notes: string[];
  lessons: PanelLesson[];
  /** Settings where trusted lessons disagree in one market: the agent leaves them alone there. */
  holds: { setting: string; market: string }[];
  /** Scored changes that count for nothing yet (under 30 demo trades, several changes at once, ...). */
  ignored: number;
}

const marketText = (l: LedgerLesson): string =>
  `${l.market.symbol} ${l.market.timeframe}, volatility ${l.market.state.volatility}, trend ${l.market.state.trend}, spread ${l.market.state.spread}`;

export function buildNotebooks(records: ChangeRecord[], agents: { id: string; name: string }[], notes: (agent: string) => string[], now = Date.now()): Notebook[] {
  const { lessons, ignored } = buildLedger(records, now);
  const agentOf = new Map(records.map((r) => [r.id, r.agent]));
  return agents.map((a) => {
    const mine = lessons.filter((l) => l.agent === a.id);
    const byKey = new Map(mine.map((l) => [l.key, l]));
    return {
      agent: a.id,
      name: a.name,
      notes: notes(a.id).slice(0, 10),
      lessons: mine.slice(0, 20).map((l) => ({
        text: lessonText(l), trusted: l.trusted, verdict: l.verdict, agree: l.agree, against: l.against, unclear: l.unclear,
        setting: l.setting, change: l.change, market: marketText(l), lastAt: l.lastAt,
      })),
      holds: holdsFrom(mine).map((h) => ({ setting: h.setting, market: byKey.get(h.key) ? marketText(byKey.get(h.key)!) : h.key })),
      ignored: ignored.filter((i) => agentOf.get(i.id) === a.id).length,
    };
  });
}

export function notebookMarkdown(nb: Notebook, title: string): string {
  const out = [`# ${title} — notebook`, '', '_Rebuilt from scored outcomes (real demo trades). Only trusted lessons reach the agent, and only in the exact market they were learned in._', ''];
  out.push('## Lessons', '', ...(nb.lessons.length ? nb.lessons.map((l) => `- ${l.text}`) : ['- None yet.']), '');
  if (nb.holds.length) out.push('## On hold', '', ...nb.holds.map((h) => `- ${h.setting} in ${h.market}: trusted lessons disagree.`), '');
  if (nb.ignored) out.push(`_${nb.ignored} scored change${nb.ignored === 1 ? '' : 's'} not counted yet (too few trades, or several things changed at once)._`, '');
  if (nb.notes.length) out.push('## Your notes', '', ...nb.notes.map((n) => `- ${n}`), '');
  return out.join('\n');
}
