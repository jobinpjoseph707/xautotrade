import type { YoutubeAgentResult, YoutubeGate, YoutubeResult } from '../types';

/** The one line under a result: what was tested and how it did. Describes past data only. */
export function gateLine(g: YoutubeGate): string {
  if (!g.passed) return `Did not hold up on real MT5 history: ${g.reasons.join(' ')}`;
  return `Tested on ${g.bars} real MT5 candles: ${g.trades} trades, profit factor ${g.profitFactor.toFixed(2)}, worst drawdown ${g.maxDrawdownPct.toFixed(1)}%.`;
}

export type YoutubeTone = 'good' | 'warning' | 'critical';

/** How the result card is headed. A pass is about past data only, never a promise. */
export function resultHeadline(r: YoutubeResult): { tone: YoutubeTone; title: string; detail: string } {
  if (r.status === 'needs_review' || !r.strategy) {
    return {
      tone: 'critical',
      title: 'Could not build a strategy from this video',
      detail: 'The video does not state exact, testable rules. The gaps below say what is missing.',
    };
  }
  if (r.gate?.passed) {
    return {
      tone: 'good',
      title: 'Built a strategy and it passed the test on past data',
      detail: 'That is not a promise it will make money. Check it on demo before anything else.',
    };
  }
  return {
    tone: 'warning',
    title: 'Built a strategy, but it did not hold up on real history',
    detail: 'You can still send it to the Inbox to look at it. Nothing is saved or started until you Approve.',
  };
}

/** Only a built candidate can be sent on. */
export const canPropose = (r: YoutubeResult | null): boolean => !!r && r.status === 'candidate' && !!r.candidateId;

export const YOUTUBE_TIMEFRAMES = ['auto', '1m', '5m', '15m', '1h'] as const;

/** What happened when the Strategist read the video. A proposal still needs Approve; no result is a promise. */
export function agentOutcome(r: YoutubeAgentResult): { tone: YoutubeTone; title: string } {
  if (r.proposals.length > 0) {
    const n = r.proposals.length;
    return {
      tone: 'good',
      title: `${n} proposal${n === 1 ? '' : 's'} sent to your Inbox. Read ${n === 1 ? 'it' : 'them'} there and press Approve only if you want to. Nothing is saved or started until you do.`,
    };
  }
  if (r.rejected.length > 0) return { tone: 'warning', title: `The strategy was refused by the safety rules: ${r.rejected.join(' ')}` };
  return { tone: 'warning', title: 'The Strategist did not create a strategy. Its reply below says what is missing.' };
}

export const truncatedNote = (r: YoutubeAgentResult): string | null =>
  r.truncated ? `This video's captions are very long (${r.transcriptChars} characters), so the Strategist read only the first part.` : null;

/** Offered after the rule reader gives up, since a narrated video often needs the whole transcript read together. */
export const canAskStrategist = (r: YoutubeResult | null): boolean => !!r && r.status === 'needs_review';
