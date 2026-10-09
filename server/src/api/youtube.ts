import { randomUUID } from 'node:crypto';
import { Router } from 'express';

import type { Broker } from '../broker/types.js';
import type { Strategy, Timeframe } from '../engine/types.js';
import { TIMEFRAME_MS } from '../engine/types.js';
import type { Proposal } from '../chat/actions.js';
import type { Gap } from '../youtube/extract.js';
import { REAL_DATA_GATE, realGateData, runBacktestGate, type GateResult } from '../youtube/gate.js';
import { processVideo } from '../youtube/pipeline.js';
import { parseVideoId, type TranscriptFetcher } from '../youtube/transcript.js';

/**
 * Strategies from YouTube videos. Mounted under /api/youtube, so it inherits the API-key middleware.
 *   POST /api/youtube/extract  { url, symbol?, timeframe? }  transcript -> candidate -> real-MT5 backtest
 *   POST /api/youtube/propose  { candidateId }               the candidate becomes an Inbox proposal
 *
 * Nothing is saved or started here. The only way out is a proposal, which waits for Approve.
 * The backtest uses the connected broker's real candles (MT5 through the MCP bridge), never simulated prices.
 */
export interface YoutubeDeps {
  broker(): Broker;
  /** Turns the candidate into a pending proposal (ChatService.proposeStrategy). */
  propose(strategy: Strategy, info: { reason?: string; warnings?: string[]; label?: string }): Promise<{ proposal: Proposal | null; rejected: string[] }>;
  savedOffset?(): number;
  /** Injectable so tests never touch the network. */
  fetcher?: TranscriptFetcher;
  now?(): number;
}

export interface GateSummary extends GateResult {
  bars: number;
}

interface Candidate {
  strategy: Strategy;
  gate: GateSummary;
  gaps: Gap[];
  videoId: string;
  at: number;
}

const TTL_MS = 30 * 60_000;
const MAX_CANDIDATES = 20;
const BARS = 3000;

export function createYoutubeRouter(deps: YoutubeDeps): Router {
  const router = Router();
  const candidates = new Map<string, Candidate>();
  const now = () => deps.now?.() ?? Date.now();

  const prune = () => {
    for (const [id, c] of candidates) if (now() - c.at > TTL_MS) candidates.delete(id);
    while (candidates.size > MAX_CANDIDATES) candidates.delete(candidates.keys().next().value as string);
  };
  const fail = (res: import('express').Response, status: number, message: string) => res.status(status).json({ ok: false, error: message });

  router.post('/extract', async (req, res) => {
    try {
      const url = String(req.body?.url ?? '').trim();
      if (!url) return void fail(res, 400, 'Paste a YouTube link first.');
      const videoId = parseVideoId(url); // throws a readable error for anything that is not a YouTube link
      const symbol = String(req.body?.symbol ?? 'XAUUSD').trim().toUpperCase() || 'XAUUSD';
      const tf = req.body?.timeframe ? String(req.body.timeframe) : undefined;
      if (tf && !(tf in TIMEFRAME_MS)) return void fail(res, 400, `Unknown timeframe "${tf}".`);
      const broker = deps.broker();

      const r = await processVideo(url, { symbol, broker, timeframe: tf as Timeframe | undefined, fetcher: deps.fetcher });
      if (r.status === 'needs_review') {
        return void res.json({ ok: true, data: { status: 'needs_review', candidateId: null, videoId, strategy: null, gaps: r.gaps, notes: r.notes, gate: null } });
      }

      let gate: GateSummary;
      try {
        const data = await realGateData(broker, r.strategy, BARS, deps.savedOffset?.() ?? 0);
        gate = { ...(await runBacktestGate(r.strategy, REAL_DATA_GATE, data)), bars: data.candles.length };
      } catch (err) {
        gate = { passed: false, reasons: [err instanceof Error ? err.message : String(err)], trades: 0, maxDrawdownPct: 0, profitFactor: 0, bars: 0 };
      }

      prune();
      const candidateId = `yt_${randomUUID().slice(0, 8)}`;
      candidates.set(candidateId, { strategy: r.strategy, gate, gaps: r.gaps, videoId, at: now() });
      res.json({ ok: true, data: { status: 'candidate', candidateId, videoId, strategy: r.strategy, gaps: r.gaps, notes: r.notes, gate } });
    } catch (err) {
      fail(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/propose', async (req, res) => {
    try {
      prune();
      const id = String(req.body?.candidateId ?? '');
      const c = candidates.get(id);
      if (!c) return void fail(res, 404, 'That result has expired. Analyse the video again.');
      const warnings = [
        c.gate.passed
          ? `Real MT5 backtest (${c.gate.bars} candles): ${c.gate.trades} trades, profit factor ${c.gate.profitFactor.toFixed(2)}, max drawdown ${c.gate.maxDrawdownPct.toFixed(1)}%.`
          : `FAILED the real-data backtest: ${c.gate.reasons.join(' ')}`,
        ...c.gaps.filter((g) => g.severity === 'assumed').map((g) => `Assumed: ${g.message}`),
      ];
      const out = await deps.propose(c.strategy, { reason: `Built from YouTube video ${c.videoId}.`, warnings, label: 'YouTube import' });
      if (!out.proposal) return void fail(res, 400, out.rejected.join(' ') || 'The strategy was not accepted.');
      candidates.delete(id); // one candidate, one proposal
      res.json({ ok: true, data: { proposal: out.proposal, rejected: out.rejected } });
    } catch (err) {
      fail(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  return router;
}
