/**
 * The weekly digest: a short summary of the week, written from the numbers.
 * The numbers and the template are always present. Claude may add two plain sentences on top,
 * but if it is unavailable or capped the digest still arrives, complete, from the template alone.
 */
export interface DigestStrategy {
  name: string;
  isTest: boolean;
  /** backtest / paper / demo / live */
  stage: string;
  trades: number;
  netProfit: number;
  wins: number;
}

export interface DigestInput {
  /** First millisecond of the first day, and the end (exclusive). UTC. */
  from: number;
  to: number;
  strategies: DigestStrategy[];
  proposalsApproved: number;
  proposalsRejected: number;
  tests: { passed: number; failed: number; notEnough: number };
  /** Safety cards raised in the week: loss cap, outages, automatic pauses and limit changes. */
  safetyEvents: number;
  claude: { calls: number; costUsd: number };
  /** Items still waiting in the Inbox when the digest is written. */
  openInbox: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;
const day = (ms: number): string => `${new Date(ms).getUTCDate()} ${MONTHS[new Date(ms).getUTCMonth()]}`;
const money = (n: number): string => `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The heading used for the Inbox card title, e.g. "5 Oct – 11 Oct". */
export function digestPeriod(input: Pick<DigestInput, 'from' | 'to'>): string {
  return `${day(input.from)} – ${day(input.to - DAY)}`;
}

/** Strategies marked as tests are left out of everything: lines and totals alike. */
export function buildDigestText(input: DigestInput): string {
  const real = input.strategies.filter((s) => !s.isTest);
  const traded = real.filter((s) => s.trades > 0).sort((a, b) => b.netProfit - a.netProfit || a.name.localeCompare(b.name));
  const lines: string[] = [`Week ${digestPeriod(input)} (UTC)`, ''];

  if (traded.length === 0) {
    lines.push('Trading: no closed trades.');
  } else {
    const trades = traded.reduce((n, s) => n + s.trades, 0);
    const net = traded.reduce((n, s) => n + s.netProfit, 0);
    lines.push(`Trading: ${plural(trades, 'closed trade')}, net ${money(net)}.`);
    for (const s of traded) lines.push(`- ${s.name} (${s.stage}): ${plural(s.trades, 'trade')}, net ${money(s.netProfit)}, ${s.wins} won`);
  }

  const t = input.tests;
  const tests = t.passed + t.failed + t.notEnough;
  lines.push(
    `Decisions: ${plural(input.proposalsApproved, 'proposal')} approved, ${input.proposalsRejected} rejected.`,
    tests === 0 ? 'Tests: none run.' : `Tests: ${tests} run (${t.passed} passed, ${t.failed} failed, ${t.notEnough} not enough evidence).`,
    `Safety: ${plural(input.safetyEvents, 'safety card')} raised.`,
    `Claude: ${plural(input.claude.calls, 'call')}, $${input.claude.costUsd.toFixed(2)}.`,
    input.openInbox === 0 ? 'Waiting for you: nothing.' : `Waiting for you: ${plural(input.openInbox, 'item')} in the Inbox.`,
  );
  return lines.join('\n');
}

/** What Claude is asked to add. It only sees the finished text, so it cannot invent a number. */
export function digestPrompt(text: string): string {
  return [
    'Below is a weekly summary of an automated trading app. Write exactly two plain sentences for its owner about the week.',
    'Use only facts and numbers that appear in the summary. Do not advise trading more, raising size, or loosening any limit. Do not promise profit.',
    '',
    text,
  ].join('\n');
}

/** Is the model's addition usable? Short, plain, and without any number the summary does not contain. */
export function acceptExtra(extra: string, text: string): string | null {
  const t = extra.trim().replace(/\s+/g, ' ');
  if (!t || t.length > 500) return null;
  const known = new Set(text.match(/\d+(\.\d+)?/g) ?? []);
  for (const n of t.match(/\d+(\.\d+)?/g) ?? []) if (!known.has(n)) return null;
  return t;
}
