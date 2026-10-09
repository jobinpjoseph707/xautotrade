import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

import type { Broker, MarketStatus } from '../broker/types.js';
import { config } from '../config.js';
import { runBacktest } from '../engine/backtest.js';
import { INDICATOR_CATALOG } from '../engine/indicators.js';
import { blankStrategy, fitSpreadCap, PRESETS } from '../engine/presets.js';
import { OP_LABELS, validateStrategy } from '../engine/rules.js';
import { DEFAULT_RISK, type Strategy, type Timeframe } from '../engine/types.js';
import { utcDayStart } from '../live/daily.js';
import { manager } from '../live/manager.js';
import { ownCloses, reconcileClosures } from '../live/reconcile.js';
import { positionTag } from '../live/runner.js';
import { backtests, logs, settings, strategies } from '../store.js';
import { chatRouter } from './chat.js';
import { inboxRouter } from './inbox.js';
import { journalRouter } from './journal.js';
import { marketStatus } from './markets.js';
import { levelsRouter } from './levels.js';
import { testboardRouter } from './testboard.js';
import { tiersRouter } from './tiers.js';

export const router = Router();

// Chart level drawing. Mounted here rather than in index.ts so it inherits the
// API-key middleware along with everything else under /api.
router.use('/levels', levelsRouter);
// Chat agents (Claude Code on this laptop). Every change they propose needs approval.
router.use('/chat', chatRouter);
router.use('/journal', journalRouter);
// Phase 1-2 routers. Empty for now; each is filled by its own task.
router.use('/inbox', inboxRouter);
router.use('/testboard', testboardRouter);
router.use('/tiers', tiersRouter);

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
      console.error(`[api] ${req.method} ${req.path} failed:`, message);
      if (!res.headersSent) fail(res, 500, message);
    }
  };
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

router.get('/health', (_req, res) => {
  ok(res, {
    status: 'up',
    mode: manager.mode,
    liveTradingAllowed: config.allowLiveTrading,
    time: Date.now(),
    version: '0.1.0',
  });
});

/** Everything the mobile rule builder needs to render its pickers. */
router.get('/catalog', (_req, res) => {
  ok(res, {
    indicators: INDICATOR_CATALOG,
    operators: Object.entries(OP_LABELS).map(([value, label]) => ({ value, label })),
    priceFields: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'],
    timeframes: ['1m', '5m', '15m', '30m', '1h', '4h', '1d'],
    presets: PRESETS.map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
      warning: p.warning,
    })),
    defaultRisk: DEFAULT_RISK,
  });
});

router.get('/account', wrap(async (_req, res) => {
  const broker: Broker = manager.broker;
  await broker.connect();
  const info = await broker.getAccountInfo();
  ok(res, { ...info, mode: manager.mode, liveTradingAllowed: config.allowLiveTrading });
}));

/**
 * Symbol search for the app's picker.
 *
 * Brokers name the same instrument differently (EURUSD, EURUSD.m, EURUSD_i,
 * GOLD vs XAUUSD), so the app must never let you type a symbol freehand —
 * it picks from what this broker actually offers. Ranked so an exact match
 * beats a prefix match beats a substring match.
 */
router.get('/symbols', wrap(async (req, res) => {
  await manager.broker.connect();
  const all = await manager.broker.getSymbols();
  const q = String(req.query.q ?? '').trim().toUpperCase();
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  if (!q) return ok(res, { total: all.length, symbols: all.slice(0, limit) });

  const scored: { s: string; rank: number }[] = [];
  for (const s of all) {
    const u = s.toUpperCase();
    if (u === q) scored.push({ s, rank: 0 });
    else if (u.startsWith(q)) scored.push({ s, rank: 1 });
    else if (u.includes(q)) scored.push({ s, rank: 2 });
    // Also match "EU" against "EURUSD" when the user types the two currency
    // halves without the full name, e.g. "eurusd" typed as "eu usd".
    else if (q.includes(' ') && q.split(/\s+/).every((part) => u.includes(part))) {
      scored.push({ s, rank: 3 });
    }
  }
  scored.sort((a, b) => a.rank - b.rank || a.s.length - b.s.length || a.s.localeCompare(b.s));
  ok(res, { total: scored.length, symbols: scored.slice(0, limit).map((x) => x.s) });
}));

// ---------------------------------------------------------------------------
// Market status: is each symbol offered / tradable / open right now?
// ---------------------------------------------------------------------------

/**
 * GET /api/markets?symbols=XAUUSD,BTCUSD — defaults to every symbol a strategy
 * uses. Checked one at a time (the MT5 bridge is serial) and cached 30 s.
 */
router.get('/markets', wrap(async (req, res) => {
  const asked = String(req.query.symbols ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const symbols = [...new Set(asked.length ? asked : strategies.list().map((s) => s.symbol))].slice(0, 40);
  const out: MarketStatus[] = [];
  for (const sym of symbols) out.push(await marketStatus(sym));
  ok(res, out);
}));

/** Full contract detail for one symbol — what the picker shows on selection. */
router.get('/symbols/:symbol/spec', wrap(async (req, res) => {
  await manager.broker.connect();
  const spec = await manager.broker.getSymbolSpec(req.params.symbol);
  let quote: unknown = null;
  try {
    quote = await manager.broker.getQuote(req.params.symbol);
  } catch {
    /* market closed or no tick yet — the spec is still useful */
  }
  ok(res, { ...spec, quote });
}));

router.get('/quote/:symbol', wrap(async (req, res) => {
  await manager.broker.connect();
  ok(res, await manager.broker.getQuote(req.params.symbol));
}));

router.get('/candles/:symbol', wrap(async (req, res) => {
  await manager.broker.connect();
  const tf = (req.query.timeframe as Timeframe) ?? '5m';
  const limit = Math.min(Number(req.query.limit ?? 300), 5000);
  ok(res, await manager.broker.getCandles(req.params.symbol, tf, limit));
}));

// ---------------------------------------------------------------------------
// Diagnostics (MT5-MCP bridge only)
// ---------------------------------------------------------------------------

/**
 * Raw view of what the MT5 bridge returns, for debugging shape mismatches.
 * Example:
 *   /api/debug/mcp?name=copy_rates_from_pos&symbol=EURUSD&timeframe=5&start_pos=0&count=5
 */
router.get('/debug/mcp', wrap(async (req, res) => {
  const broker = manager.broker as any;
  if (typeof broker.debugCallTool !== 'function') {
    return fail(res, 400, `Debug tooling is only available on the mt5mcp bridge (current mode: ${manager.mode}).`);
  }
  const name = String(req.query.name ?? 'get_account_info');

  // Everything except `name` becomes the tool's arguments, with numeric-looking
  // values coerced so `count=5` arrives as a number rather than a string.
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'name' || k === 'key') continue;
    const s = String(v);
    args[k] = s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s;
  }

  ok(res, { tool: name, args, result: await broker.debugCallTool(name, args) });
}));

router.get('/debug/tools', wrap(async (_req, res) => {
  const broker = manager.broker as any;
  if (typeof broker.listToolNames !== 'function') {
    return fail(res, 400, `Only available on the mt5mcp bridge (current mode: ${manager.mode}).`);
  }
  ok(res, await broker.listToolNames());
}));

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

router.get('/strategies', (_req, res) => ok(res, strategies.list()));

router.get('/strategies/:id', (req, res) => {
  const s = strategies.get(req.params.id);
  if (!s) return fail(res, 404, 'Strategy not found');
  ok(res, s);
});

router.post('/strategies', wrap(async (req, res) => {
  const body = req.body ?? {};
  let strategy: Strategy;

  if (body.preset) {
    const preset = PRESETS.find((p) => p.key === body.preset);
    if (!preset) return fail(res, 400, `Unknown preset "${body.preset}"`);
    strategy = preset.build(body.symbol ?? 'EURUSD');
    if (body.name) strategy.name = body.name;
    try {
      await manager.broker.connect();
      fitSpreadCap(strategy, (await manager.broker.getSymbolSpec(strategy.symbol)).spreadPoints);
    } catch {
      /* no spec available: keep the preset's own cap */
    }
  } else if (body.strategy) {
    strategy = { ...body.strategy, id: body.strategy.id || `str_${randomUUID().slice(0, 8)}` };
  } else {
    strategy = blankStrategy(body.symbol ?? 'EURUSD');
    if (body.name) strategy.name = body.name;
  }

  const errors = validateStrategy(strategy);
  if (errors.length) return fail(res, 400, errors.join(' '));
  ok(res, strategies.save(strategy));
}));

router.put('/strategies/:id', (req, res) => {
  const existing = strategies.get(req.params.id);
  if (!existing) return fail(res, 404, 'Strategy not found');
  const merged: Strategy = { ...existing, ...req.body, id: req.params.id };
  const errors = validateStrategy(merged);
  if (errors.length) return fail(res, 400, errors.join(' '));
  const saved = strategies.save(merged);
  manager.reload(saved); // a running bot picks up the edit on its next bar
  ok(res, saved);
});

router.delete('/strategies/:id', (req, res) => {
  manager.remove(req.params.id);
  strategies.remove(req.params.id);
  ok(res, { deleted: req.params.id });
});

router.post('/strategies/:id/validate', (req, res) => {
  const s = req.body?.strategy ?? strategies.get(req.params.id);
  if (!s) return fail(res, 404, 'Strategy not found');
  const errors = validateStrategy(s);
  ok(res, { valid: errors.length === 0, errors });
});

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------

router.post('/backtest', wrap(async (req, res) => {
  const body = req.body ?? {};
  const strategy: Strategy | null = body.strategy ?? strategies.get(body.strategyId);
  if (!strategy) return fail(res, 400, 'Provide either strategyId or a full strategy object.');

  const errors = validateStrategy(strategy);
  if (errors.length) return fail(res, 400, errors.join(' '));

  const bars = Math.min(Math.max(Number(body.bars ?? 3000), 200), 20_000);
  const initialBalance = Number(body.initialBalance ?? 10_000);

  await manager.broker.connect();
  const candles = await manager.broker.getCandles(strategy.symbol, strategy.timeframe, bars);
  if (candles.length < 100) {
    return fail(res, 400, `The broker returned only ${candles.length} candles for ${strategy.symbol}. Try a different symbol or fewer bars.`);
  }

  const brokerSpec = await manager.broker.getSymbolSpec(strategy.symbol);
  const spec = {
    ...brokerSpec,
    spreadPoints: body.spreadPoints != null ? Number(body.spreadPoints) : brokerSpec.spreadPoints,
    commissionPerLot: body.commissionPerLot != null ? Number(body.commissionPerLot) : brokerSpec.commissionPerLot,
    slippagePoints: body.slippagePoints != null ? Number(body.slippagePoints) : brokerSpec.slippagePoints,
  };

  const started = Date.now();
  const result = runBacktest(strategy, candles, {
    initialBalance,
    spec,
    spreadOverridePoints: body.spreadPoints != null ? Number(body.spreadPoints) : null,
  });
  const id = `bt_${randomUUID().slice(0, 8)}`;
  backtests.save(id, result);

  ok(res, { id, elapsedMs: Date.now() - started, candles: candles.length, spec, ...result });
}));

router.get('/backtests/:id', (req, res) => {
  const r = backtests.get(req.params.id);
  if (!r) return fail(res, 404, 'Backtest not found');
  ok(res, r);
});

router.get('/strategies/:id/backtests', (req, res) => ok(res, backtests.listForStrategy(req.params.id)));

// ---------------------------------------------------------------------------
// Live bots
// ---------------------------------------------------------------------------

router.get('/bots', (_req, res) => ok(res, manager.snapshots()));

router.get('/bots/:id', (req, res) => {
  const snap = manager.snapshot(req.params.id);
  if (!snap) return fail(res, 404, 'This strategy has never been started.');
  ok(res, snap);
});

router.post('/bots/:id/start', wrap(async (req, res) => {
  ok(res, await manager.start(req.params.id));
}));

router.post('/bots/:id/stop', (req, res) => {
  ok(res, manager.stop(req.params.id) ?? { strategyId: req.params.id, status: 'stopped' });
});

router.post('/bots/:id/close-all', wrap(async (req, res) => {
  ok(res, { closed: await manager.closeAll(req.params.id) });
}));

router.post('/panic', wrap(async (_req, res) => {
  await manager.stopAll(); // logs a per-bot "stopped after Xm, P&L Y" line for each running bot
  let closed = 0;
  for (const snap of manager.snapshots()) closed += await manager.closeAll(snap.strategyId);
  const entry = logs.add({ ts: Date.now(), strategyId: null, level: 'warn', event: 'panic', message: `Panic stop: all bots stopped, ${closed} positions closed.` });
  manager.emit('log', entry); // this call bypasses BotRunner.log(), which is what normally broadcasts to open apps
  ok(res, { stopped: true, closed });
}));

// ---------------------------------------------------------------------------
// Positions & logs
// ---------------------------------------------------------------------------

router.get('/positions', wrap(async (_req, res) => {
  await manager.broker.connect();
  ok(res, await manager.broker.getPositions());
}));

router.post('/positions/:id/close', wrap(async (req, res) => {
  await manager.broker.closePosition(req.params.id);
  ok(res, { closed: req.params.id });
}));

/**
 * GET /api/strategies/:id/trades?from=<ms>&to=<ms>
 *
 * One strategy's trades for a period with the numbers computed from the same
 * rows the list shows, so the header and the list can never disagree. Before
 * answering, any logged entry whose close was never recorded is looked up in
 * the broker's deal history and booked (see live/reconcile.ts). `from`
 * defaults to the bots' trading day (00:00 UTC).
 */
router.get('/strategies/:id/trades', wrap(async (req, res) => {
  const id = req.params.id;
  const now = Date.now();
  const from = Number(req.query.from) || utcDayStart(now);
  const to = Number(req.query.to) || now + 1;
  const tag = positionTag(id);
  let openPositions: Awaited<ReturnType<Broker['getPositions']>> = [];
  let brokerOk = true;
  try {
    await manager.broker.connect();
    openPositions = (await manager.broker.getPositions()).filter((p) => (p.comment ?? '').startsWith(tag));
    const added = await reconcileClosures(id, manager.broker, logs, {
      since: Math.max(from, now - 31 * 86_400_000),
      openIds: new Set(openPositions.map((p) => p.id)),
      now,
    });
    for (const e of added) manager.emit('log', e);
  } catch {
    brokerOk = false; // still answer from the log
  }
  // Drop close rows that belong to other bots' positions or repeat one position (old logging bug).
  const raw = logs.tradesBetween(id, from, to);
  const own = new Set(ownCloses(raw, tag));
  const events = raw
    .filter((e) => !['position_closed', 'exit', 'panic_close'].includes(e.event) || own.has(e))
    .sort((a, b) => b.ts - a.ts || (b.id ?? 0) - (a.id ?? 0));
  const closes = events.filter((e) => own.has(e));
  const profitOf = (e: { data?: unknown }) => {
    const p = (e.data as { profit?: unknown } | undefined)?.profit;
    return typeof p === 'number' && Number.isFinite(p) ? p : 0;
  };
  const realised = closes.reduce((a, e) => a + profitOf(e), 0);
  const wins = closes.filter((e) => profitOf(e) > 0).length;
  ok(res, {
    from,
    to,
    opened: events.filter((e) => e.event === 'entry').length,
    closed: closes.length,
    wins,
    losses: closes.filter((e) => profitOf(e) < 0).length,
    realised: Math.round(realised * 100) / 100,
    openPositions,
    floating: Math.round(openPositions.reduce((a, p) => a + p.profit, 0) * 100) / 100,
    brokerOk,
    events,
  });
}));

router.get('/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  ok(res, logs.recent(limit, req.query.strategyId as string | undefined));
});

/**
 * Lets the app record a client-only action (currently just "logged out") in
 * the same activity feed as everything else. These never happen anywhere but
 * the phone/browser, so without this endpoint they'd be invisible outside the
 * device that did them.
 */
router.post('/logs/client', (req, res) => {
  const { event, message, data } = req.body ?? {};
  if (!event || !message) return fail(res, 400, 'event and message are required');
  const entry = logs.add({ ts: Date.now(), strategyId: null, level: 'info', event: String(event), message: String(message), data });
  manager.emit('log', entry); // so it also reaches anyone with the app open right now
  ok(res, entry);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get('/settings', (_req, res) => {
  ok(res, {
    mode: manager.mode,
    liveTradingAllowed: config.allowLiveTrading,
    paperBalance: settings.get('paperBalance', 10_000),
    defaultSymbol: settings.get('defaultSymbol', 'EURUSD'),
  });
});

router.put('/settings', (req, res) => {
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (['paperBalance', 'defaultSymbol'].includes(k)) settings.set(k, v);
  }
  ok(res, { saved: true });
});
