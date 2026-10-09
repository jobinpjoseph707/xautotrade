import { Router, type Request, type Response } from 'express';

import { runBacktest } from '../engine/backtest.js';
import type { Strategy } from '../engine/types.js';
import type { BacktestInfo } from '../chat/prompt.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENTS } from '../chat/agents.js';
import { ClaudeCliBackend } from '../chat/backend.js';
import { ChatService } from '../chat/service.js';
import { demoStatsFromLogs } from '../learning/demo.js';
import { Evolver } from '../learning/evolve.js';
import { Lab } from '../learning/lab.js';
import { buildNotebook, deriveLessons, notebookMarkdown } from '../learning/notebook.js';
import { scoreboard, scoreDue } from '../learning/scoring.js';
import { SqliteRecordStore } from '../learning/sqliteRecords.js';
import { DEFAULT_EVOLVE, type ChangeRecord, type EvolveCandidate, type EvolveSettings } from '../learning/types.js';
import { manager } from '../live/manager.js';
import { marketStatus } from './markets.js';
import { positionTag } from '../live/runner.js';
import { utcDayStart } from '../live/daily.js';
import { inbox } from '../inbox/instance.js';
import { proposalFeed } from '../inbox/proposals.js';
import { chatUsage, logs, settings, strategies } from '../store.js';

export const chatRouter = Router();

const btCache = new Map<string, { at: number; info: BacktestInfo }>();
const BT_TTL = 10 * 60_000;
const BT_MAX = 12;
const BT_BARS = 1500;

async function backtestOne(s: Strategy): Promise<BacktestInfo> {
  const key = `${s.id}:${s.updatedAt ?? 0}`;
  const hit = btCache.get(key);
  if (hit && Date.now() - hit.at < BT_TTL) return hit.info;
  let info: BacktestInfo;
  try {
    await manager.broker.connect();
    const candles = await manager.broker.getCandles(s.symbol, s.timeframe, BT_BARS);
    if (candles.length < 100) throw new Error(`only ${candles.length} candles available`);
    const spec = await manager.broker.getSymbolSpec(s.symbol);
    const m = runBacktest(s, candles, { initialBalance: 10_000, spec, maxEquityPoints: 50 }).metrics;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    info = {
      strategyId: s.id, bars: candles.length, trades: m.totalTrades, netProfitPct: r2(m.netProfitPct),
      winRatePct: r2(m.winRatePct), profitFactor: r2(m.profitFactor), maxDrawdownPct: r2(m.maxDrawdownPct),
      avgWin: r2(m.avgWin), avgLoss: r2(m.avgLoss),
    };
  } catch (err) {
    info = { strategyId: s.id, error: err instanceof Error ? err.message : String(err) };
  }
  btCache.set(key, { at: Date.now(), info });
  return info;
}

// ---------------------------------------------------------------------------
// Learning layer: outcome memory, notebooks, unseen-data validation, critic,
// scoreboard, auto-evolve. Reads candles only; never places orders.
// ---------------------------------------------------------------------------

const backend = new ClaudeCliBackend(undefined, undefined, (u) => {
  try {
    chatUsage.add({ ts: Date.now(), ...u });
  } catch {
    /* usage tracking is a bonus, never worth failing a chat reply over */
  }
});
const changes = new SqliteRecordStore<ChangeRecord>('change');
const candidates = new SqliteRecordStore<EvolveCandidate>('candidate');
// Resolve the broker per call: it can be swapped at runtime.
const lab = new Lab(
  {
    getCandles: (symbol, tf, limit) => manager.broker.getCandles(symbol, tf, limit),
    getSymbolSpec: (symbol) => manager.broker.getSymbolSpec(symbol),
  },
  undefined,
  () => manager.broker.connect(),
);
const demoStats = (id: string, from: number, to: number) => demoStatsFromLogs(logs.tradesBetween(id, from, to), from, to, positionTag(id));
const notesKey = (agent: string) => `notebook:${agent}`;
const notes = (agent: string) => settings.get<string[]>(notesKey(agent), []);
const agentHost = {
  list: () => strategies.list(),
  get: (id: string) => strategies.get(id),
  save: (s: Strategy) => strategies.save(s),
  remove: (id: string) => {
    manager.remove(id);
    strategies.remove(id);
  },
  reload: (s: Strategy) => manager.reload(s),
  start: (id: string) => manager.start(id),
  stop: (id: string) => manager.stop(id),
};

const evolver = new Evolver({
  backend,
  host: agentHost,
  lab,
  candidates,
  changes,
  getSettings: () => settings.get<EvolveSettings>('evolve', DEFAULT_EVOLVE),
  setSettings: (s) => settings.set('evolve', s),
  notes,
  log: (message) => {
    const entry = logs.add({ ts: Date.now(), strategyId: null, level: 'info', event: 'learning', message });
    manager.emit('log', entry);
  },
});

const service = new ChatService({
  inbox: proposalFeed(inbox),
  marketCheck: async (symbol) => {
    const m = await marketStatus(symbol);
    return { available: m.available, reason: m.reason };
  },
  learning: {
    changes,
    validate: (before, after, safety) => lab.validate(before, after, safety),
    demoStats,
    notes,
    critic: (process.env.CRITIC_MODE as 'off' | 'rules' | 'llm') || 'llm',
    blockFailed: process.env.VALIDATION_MODE !== 'warn',
  },
  backtests: async (list) => {
    // Sequential: the MT5 bridge handles one request at a time.
    const out: BacktestInfo[] = [];
    for (const s of list.slice(0, BT_MAX)) out.push(await backtestOne(s));
    return out;
  },
  backend,
  host: agentHost,
  bots: () =>
    manager.snapshots().map((b) => ({
      strategyId: b.strategyId,
      status: b.status,
      tradesToday: b.tradesToday,
      realisedToday: b.realisedToday,
      openPositions: b.openPositions.length,
      blockedReason: b.blockedReason,
      error: b.error,
    })),
  issues: () =>
    logs
      .recent(150)
      .filter((l) => l.level === 'warn' || l.level === 'error')
      .slice(0, 12)
      .map((l) => ({ ts: l.ts, level: l.level, strategyId: l.strategyId, message: l.message })),
});

// What the Inbox buttons do. They go through the same ChatService calls as the Agents tab,
// so a proposal is validated, applied and recorded exactly once whichever screen approves it.
inbox.setHandlers({
  approveProposal: (id) => service.approve(id),
  rejectProposal: (id) => service.reject(id),
  restartBot: async (strategyId) => {
    await manager.start(strategyId);
  },
});

const ok = (res: Response, data: unknown): void => {
  res.json({ ok: true, data });
};
const fail = (res: Response, status: number, message: string): void => {
  res.status(status).json({ ok: false, error: message });
};

/** The CLI's own sign-in problems (see ChatBackendError): the fix is on the laptop, so tell the Inbox once. */
const CLAUDE_DOWN = /sign-in on the laptop|Claude Code CLI not found/i;

function wrap(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (CLAUDE_DOWN.test(message)) {
        inbox.raise({ kind: 'claude_unavailable', severity: 'warn', dedupeKey: 'claude_unavailable', title: 'The AI agents cannot answer: Claude is not signed in on the laptop', body: message });
      }
      if (!res.headersSent) fail(res, 400, message);
    }
  };
}

chatRouter.get('/agents', (_req, res) => ok(res, service.agents()));
// Token/cost usage for the agent chats — a running total so it's never a
// surprise. period: today | 7d | 30d | all (default today).
const DAY_MS = 86_400_000;
chatRouter.get('/usage', (req, res) => {
  const period = ['today', '7d', '30d', 'all'].includes(String(req.query.period)) ? (req.query.period as string) : 'today';
  const now = Date.now();
  const since = period === 'today' ? utcDayStart(now) : period === '7d' ? now - 7 * DAY_MS : period === '30d' ? now - 30 * DAY_MS : 0;
  ok(res, { period, ...chatUsage.summary(since) });
});
chatRouter.get('/proposals', (_req, res) => ok(res, service.pending()));
chatRouter.post('/', wrap(async (req, res) => {
  const result = await service.chat(req.body ?? {});
  inbox.resolveKey('claude_unavailable', 'Claude answered again.');
  ok(res, result);
}));
chatRouter.post('/proposals/:id/approve', wrap(async (req, res) => ok(res, await service.approve(req.params.id))));
chatRouter.post('/proposals/:id/reject', wrap((req, res) => ok(res, service.reject(req.params.id))));

// --- Learning ---------------------------------------------------------------

function writeNotebooks(): void {
  try {
    const dir = join(process.cwd(), 'data', 'notebooks');
    mkdirSync(dir, { recursive: true });
    const all = changes.all(2000);
    for (const a of AGENTS) writeFileSync(join(dir, `${a.id}.md`), notebookMarkdown(buildNotebook(a.id, all, notes(a.id)), a.name));
  } catch {
    /* notebooks on disk are a convenience; the API is the source of truth */
  }
}

let learning = false;
/** One pass of the learning loop: score due changes, judge finished variants, maybe evolve. */
export async function learningTick(opts: { forceScore?: boolean; forceEvolve?: boolean } = {}) {
  if (learning) throw new Error('The learning loop is already running; try again in a minute.');
  learning = true;
  try {
    const scored = await scoreDue(changes, lab, { demoStats, force: opts.forceScore });
    const evaluated = await evolver.evaluate();
    const evolved = opts.forceEvolve || evolver.isDue() ? await evolver.runCycle(!!opts.forceEvolve) : { created: [], skipped: [] };
    writeNotebooks();
    return { scored: scored.scored.length, waiting: scored.waiting, errors: [...scored.errors], evaluated: evaluated.length, evolved };
  } finally {
    learning = false;
  }
}

export function startLearningLoop(): NodeJS.Timeout {
  const everyMs = Number(process.env.LEARN_TICK_MINUTES ?? 30) * 60_000;
  writeNotebooks();
  const t = setInterval(() => {
    learningTick().catch(() => undefined);
  }, everyMs);
  t.unref();
  return t;
}

chatRouter.get('/changes', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
  // Strip the heavy strategy bodies from the list view.
  ok(res, changes.all(limit).map(({ before, after, proposal, ...r }) => r));
});
chatRouter.get('/changes/:id', (req, res) => {
  const r = changes.get(req.params.id);
  if (!r) return fail(res, 404, 'Not found');
  ok(res, r);
});
chatRouter.get('/scoreboard', (_req, res) => ok(res, scoreboard(changes.all(5000))));
chatRouter.get('/notebooks', (_req, res) => {
  const all = changes.all(2000);
  ok(res, AGENTS.map((a) => ({ ...buildNotebook(a.id, all, notes(a.id)), name: a.name })));
});
chatRouter.get('/lessons', (_req, res) => ok(res, deriveLessons(changes.all(2000))));
chatRouter.post('/notebooks/:agent/notes', (req, res) => {
  const agent = req.params.agent;
  if (!AGENTS.some((a) => a.id === agent)) return fail(res, 404, 'Unknown agent');
  const text = String(req.body?.text ?? '').trim().slice(0, 300);
  if (!text) return fail(res, 400, 'Write a note first.');
  const next = [...notes(agent), text].slice(-10);
  settings.set(notesKey(agent), next);
  writeNotebooks();
  ok(res, next);
});
chatRouter.delete('/notebooks/:agent/notes/:index', (req, res) => {
  const agent = req.params.agent;
  const next = notes(agent).filter((_, i) => i !== Number(req.params.index));
  settings.set(notesKey(agent), next);
  writeNotebooks();
  ok(res, next);
});
chatRouter.post('/learning/run', wrap(async (req, res) => ok(res, await learningTick({ forceScore: !!req.body?.forceScore }))));

chatRouter.get('/evolve', (_req, res) => ok(res, { settings: evolver.settings(), candidates: evolver.list() }));
chatRouter.put('/evolve', wrap((req, res) => ok(res, evolver.updateSettings(req.body ?? {}))));
chatRouter.post('/evolve/run', wrap(async (_req, res) => ok(res, await learningTick({ forceEvolve: true }))));
chatRouter.post('/evolve/candidates/:id/promote', wrap((req, res) => ok(res, evolver.promote(req.params.id))));
chatRouter.post('/evolve/candidates/:id/dismiss', wrap((req, res) => ok(res, evolver.dismiss(req.params.id))));
