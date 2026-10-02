/**
 * Level publishing routes.
 *
 * The MT5 bridge exposes no chart-object tools, so drawing is the EA's job:
 * this server only ever writes a CSV into MetaTrader's Common\Files directory,
 * and XATLevels.mq5 polls that file and renders it.
 *
 * Deliberately talks to the `Broker` interface rather than the MCP bridge
 * directly, so levels also work in paper mode — which means the whole feature
 * is testable without a terminal attached.
 */

import { Router, type Request, type Response } from 'express';

import {
  barsForMinutes,
  clearLevels,
  COMMON_FILES_DIR,
  levelsFromRange,
  LEVELS_FILE,
  clearSource,
  listSources,
  publishFromSource,
  publishLevels,
  rangeOf,
  readPublished,
  type Bar,
  type Level,
} from '../engine/levels.js';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../engine/types.js';
import { manager } from '../live/manager.js';
import { buildOverlays } from '../engine/overlays.js';
import { strategies } from '../store.js';

export const levelsRouter = Router();

const ok = (res: Response, data: unknown): void => {
  res.json({ ok: true, data });
};
const fail = (res: Response, status: number, message: string): void => {
  res.status(status).json({ ok: false, error: message });
};

function wrap(handler: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[levels] ${req.method} ${req.path} failed:`, message);
      if (!res.headersSent) fail(res, 500, message);
    }
  };
}

/** Minutes per bar → the engine's timeframe string. */
const MINUTES_TO_TF: Record<number, Timeframe> = {
  1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h', 1440: '1d',
};

function resolveTimeframe(input: unknown): { tf: Timeframe; minutes: number } {
  if (typeof input === 'string' && input in TIMEFRAME_MS) {
    const tf = input as Timeframe;
    return { tf, minutes: TIMEFRAME_MS[tf] / 60_000 };
  }
  const n = Number(input ?? 5);
  const tf = MINUTES_TO_TF[n];
  if (!tf) {
    throw new Error(
      `Unsupported timeframe "${input}". Use minutes (1, 5, 15, 30, 60, 240, 1440) or a name like "5m".`,
    );
  }
  return { tf, minutes: n };
}

/**
 * Candles as epoch-SECOND bars, with the forming bar dropped.
 *
 * Dropped by POSITION, not by comparing against the wall clock. The bridge
 * stamps MetaTrader's *server* time with a "Z" suffix, and this broker runs
 * UTC+3 — so every bar looks up to three hours in the future. A clock-based
 * "is it finished yet?" test therefore discarded every recent bar and returned
 * nothing at all. Candles arrive oldest-first, so the last one is the one still
 * forming, whatever timezone the server thinks it is in.
 */
function toCompletedBars(candles: Candle[]): Bar[] {
  const completed = candles.length > 1 ? candles.slice(0, -1) : candles;
  return completed.map((c) => ({
    time: Math.floor(c.time / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

/**
 * POST /api/levels/range
 * { symbol: "XAUUSD", minutes: 30, timeframe: 5 }
 *
 * Marks the high and low of the last `minutes` as resistance and support.
 */
async function publishRange(
  input: { symbol?: unknown; minutes?: unknown; timeframe?: unknown },
  res: Response,
): Promise<void> {
  const body = input ?? {};
  const symbol = String(body.symbol ?? 'XAUUSD');
  const minutes = Number(body.minutes ?? 30);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fail(res, 400, 'minutes must be a positive number');
  }

  let tf: Timeframe;
  let tfMinutes: number;
  try {
    ({ tf, minutes: tfMinutes } = resolveTimeframe(body.timeframe));
  } catch (err) {
    return fail(res, 400, err instanceof Error ? err.message : String(err));
  }

  const wantBars = barsForMinutes(minutes, tfMinutes);

  await manager.broker.connect();
  // Fetch one extra so dropping the forming bar still leaves enough.
  const candles = await manager.broker.getCandles(symbol, tf, wantBars + 1);
  const bars = toCompletedBars(candles).slice(-wantBars);

  if (bars.length === 0) {
    return fail(
      res,
      502,
      `The broker returned no completed bars for ${symbol}. If the symbol is not in ` +
        `MetaTrader's Market Watch, add it there first.`,
    );
  }
  if (bars.length < wantBars) {
    // eslint-disable-next-line no-console
    console.warn(`[levels] asked ${wantBars} bars, got ${bars.length} for ${symbol}`);
  }

  const r = rangeOf(bars);
  const levels = levelsFromRange(symbol, bars, { idPrefix: `m${minutes}`, label: `${minutes}m` });
  // Through the registry, so a manual publish doesn't erase a running bot's lines.
  const published = await publishFromSource('manual', levels);

  ok(res, {
    symbol,
    minutes,
    timeframe: tf,
    barsRequested: wantBars,
    barsUsed: bars.length,
    resistance: r.high,
    support: r.low,
    spanSeconds: r.toTime - r.fromTime,
    file: published.file,
    note: 'The XATLevels EA must be attached to a chart of this symbol to render these.',
  });
}

levelsRouter.post('/range', wrap((req, res) => publishRange(req.body ?? {}, res)));

/**
 * GET /api/levels/range?symbol=XAUUSD&minutes=30&timeframe=5
 *
 * Same work as the POST, so the whole feature can be exercised from a browser
 * bar. Publishing levels only writes a file — it cannot trade — so exposing it
 * on GET costs nothing in safety.
 */
levelsRouter.get('/range', wrap((req, res) => publishRange(req.query, res)));

/** POST /api/levels/custom — publish arbitrary levels. */
levelsRouter.post('/custom', wrap(async (req, res) => {
  const levels: Level[] = req.body?.levels;
  if (!Array.isArray(levels)) return fail(res, 400, 'levels must be an array');
  for (const l of levels) {
    if (!l.symbol || !l.kind || !l.id || !Number.isFinite(Number(l.price1))) {
      return fail(res, 400, `Invalid level: ${JSON.stringify(l)}`);
    }
  }
  ok(res, await publishFromSource('manual', levels));
}));

/** DELETE /api/levels — clear everything the EA drew. */
/**
 * DELETE /api/levels — clear manually drawn lines.
 *
 * Leaves a running bot's own lines alone by default: wiping those would be
 * surprising, since the bot would just redraw them on its next bar. Pass
 * ?all=true to clear everything.
 */
levelsRouter.delete('/', wrap(async (req, res) => {
  if (String(req.query.all) === 'true') {
    await clearLevels();
    ok(res, { cleared: 'all', message: 'Every line cleared. Running bots will redraw their own next bar.' });
    return;
  }
  await clearSource('manual');
  ok(res, {
    cleared: 'manual',
    message: 'Manually drawn lines cleared. Lines from running bots were left alone.',
    remaining: listSources(),
  });
}));

/**
 * GET /api/levels/status
 *
 * Tells "the server never wrote the file" apart from "the EA is not attached" —
 * two failures that look identical on the chart.
 */
levelsRouter.get('/status', wrap(async (_req, res) => {
  const content = await readPublished();
  const rows = content
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('symbol,'));

  ok(res, {
    directory: COMMON_FILES_DIR,
    file: LEVELS_FILE,
    exists: content.length > 0,
    levelCount: rows.length,
    raw: content,
    sources: listSources(),
    note: content.length
      ? 'File is written. If nothing shows on the chart, the EA is not attached or Algo Trading is off.'
      : 'No file yet — publish levels first.',
  });
}));

/**
 * POST /api/levels/strategy/:id  { publish?, bars?, indicators?, rules?, trades?, range?, rangeMinutes? }
 *
 * Everything this strategy takes into account — indicator curves, a checklist
 * of its entry/exit rules on the last closed bar, its open trades, optionally
 * the recent range — computed from live candles. Returned for the app preview;
 * with publish=true also drawn on the MT5 chart (source `strategy:<id>`), which
 * stays until cleared. A running bot with showOverlays redraws its own copy
 * every bar under `bot:<id>`.
 */
levelsRouter.post('/strategy/:id', wrap(async (req, res) => {
  const s = strategies.get(req.params.id);
  if (!s) return fail(res, 404, 'Strategy not found');
  const b = req.body ?? {};
  const bars = Math.min(Math.max(Number(b.bars ?? 120), 20), 400);
  await manager.broker.connect();
  const warm = 300;
  const raw = await manager.broker.getCandles(s.symbol, s.timeframe, bars + warm + 1);
  const closed = raw.length > 1 ? raw.slice(0, -1) : raw; // never the forming bar
  if (closed.length < 30) return fail(res, 400, `Only ${closed.length} candles available for ${s.symbol}.`);
  const tag = `XAT:${s.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
  const positions = (await manager.broker.getPositions()).filter((p) => (p.comment ?? '').startsWith(tag));
  const result = buildOverlays(s, closed, positions, {
    bars,
    indicators: b.indicators !== false,
    rules: b.rules !== false,
    trades: b.trades !== false,
    range: !!b.range,
    rangeMinutes: Number(b.rangeMinutes ?? s.levelsMinutes ?? 30),
  });
  let published: { file: string; count: number } | null = null;
  if (b.publish) published = await publishFromSource(`strategy:${s.id}`, result.levels);
  const { levels, ...summary } = result;
  ok(res, {
    ...summary,
    objectCount: levels.length,
    published,
    live: !!s.showOverlays,
    note: 'Indicator curves and the info panel need XATLevels v2 on a chart of this symbol (recompile it in MetaEditor after updating).',
  });
}));

/** DELETE /api/levels/strategy/:id — take a strategy's one-off overlay off the chart. */
levelsRouter.delete('/strategy/:id', wrap(async (req, res) => {
  await clearSource(`strategy:${req.params.id}`);
  ok(res, { cleared: true, remaining: listSources() });
}));
