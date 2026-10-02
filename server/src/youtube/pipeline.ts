import { startFirstAgent } from '../agents/rotation.js';
import type { AgentStore } from '../agents/store.js';
import type { ActiveAgent } from '../agents/types.js';
import { PaperBroker } from '../broker/paper.js';
import type { Strategy, Timeframe } from '../engine/types.js';
import { extractStrategy, type Gap } from './extract.js';
import { EligibleStrategy, type GateCriteria, type GateData } from './gate.js';
import { mapToStrategy, UnsupportedIndicatorError, type MapContext } from './map.js';
import { fetchTranscript, parseVideoId, type TranscriptFetcher } from './transcript.js';

export type PipelineResult =
  | { status: 'candidate'; strategy: Strategy; gaps: Gap[]; notes: string[] }
  | { status: 'needs_review'; strategy: null; gaps: Gap[]; notes: string[] };

/** Transcript text -> candidate strategy, or a needs-review report with exact gaps. */
export function processTranscript(text: string, ctx: MapContext): PipelineResult {
  const extracted = extractStrategy(text);
  try {
    const r = mapToStrategy(extracted, ctx);
    return r.status === 'candidate'
      ? { status: 'candidate', strategy: r.strategy!, gaps: r.gaps, notes: r.notes }
      : { status: 'needs_review', strategy: null, gaps: r.gaps, notes: r.notes };
  } catch (err) {
    if (err instanceof UnsupportedIndicatorError) {
      return {
        status: 'needs_review',
        strategy: null,
        gaps: [
          ...extracted.gaps,
          { severity: 'blocking', code: 'UNSUPPORTED_INDICATOR', message: `The strategy relies on "${err.indicator}", which the engine does not implement.` },
        ],
        notes: [],
      };
    }
    throw err;
  }
}

export async function processVideo(
  url: string,
  opts: { symbol: string; timeframe?: Timeframe; fetcher?: TranscriptFetcher; onTranscript?: (text: string) => void },
): Promise<PipelineResult> {
  const text = await fetchTranscript(url, opts.fetcher);
  opts.onTranscript?.(text);
  const broker = new PaperBroker();
  await broker.connect();
  const spec = await broker.getSymbolSpec(opts.symbol);
  const quote = await broker.getQuote(opts.symbol);
  return processTranscript(text, {
    symbol: opts.symbol,
    spec,
    referencePrice: quote.bid,
    timeframe: opts.timeframe,
    name: `YouTube ${parseVideoId(url)}`,
  });
}

/**
 * The only route from an extracted strategy into agent rotation. It runs the
 * backtest gate; a failing strategy throws GateFailedError and never reaches
 * the rotation store.
 */
export async function submitToRotation(
  store: AgentStore,
  candidate: Strategy,
  startingBalance: number,
  weekStart: Date,
  gate?: { criteria?: GateCriteria; data?: GateData },
): Promise<ActiveAgent> {
  const eligible = await EligibleStrategy.fromGate(candidate, gate?.criteria, gate?.data);
  return startFirstAgent(store, eligible.strategy, startingBalance, weekStart);
}
