import { Router } from 'express';

import type { Broker } from '../broker/types.js';
import { stopPointsOf, type RiskPosition } from '../portfolio/openRisk.js';
import { DEFAULT_TIER } from '../portfolio/config.js';
import { loadTierConfig, saveTierConfig } from '../portfolio/instance.js';
import type { TierService } from '../portfolio/service.js';
import type { TierStore } from '../portfolio/store.js';
import { tierSummary } from '../portfolio/summary.js';
import type { Strategy } from '../engine/types.js';

export interface TiersRouterDeps {
  broker: () => Broker;
  store: TierStore;
  service: TierService;
  strategies: { list(): Strategy[] };
  /** Which strategy opened a position, from its comment tag. */
  strategyIdOf: (comment: string | undefined) => string | null;
}

/**
 * Risk tiers and open-risk caps (task 2.2).
 * Mounted under /api, so it inherits the API-key middleware.
 *   GET /api/tiers          five tiers: cap, open risk now, who is in each
 *   PUT /api/tiers/config   { riskBudgetPct, capSharePct[5], groups } (the top tier may not exceed 20%)
 *   POST /api/tiers/recheck measure every strategy again now
 */
export function createTiersRouter(deps: TiersRouterDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const strategies = deps.strategies.list();
    let open: RiskPosition[] | null = null;
    let equity = 0;
    try {
      const broker = deps.broker();
      await broker.connect();
      equity = (await broker.getAccountInfo()).equity;
      const records = new Map(deps.store.all().map((r) => [r.strategyId, r]));
      open = [];
      const specs = new Map<string, Awaited<ReturnType<Broker['getSymbolSpec']>>>();
      for (const p of await broker.getPositions()) {
        if (!specs.has(p.symbol)) specs.set(p.symbol, await broker.getSymbolSpec(p.symbol));
        const spec = specs.get(p.symbol)!;
        const owner = deps.strategyIdOf(p.comment);
        open.push({
          strategyId: owner,
          symbol: p.symbol,
          side: p.side,
          lots: p.volume,
          stopPoints: stopPointsOf(p.openPrice, p.stopLoss, spec.point),
          pointValuePerLot: spec.pointValuePerLot,
          tier: owner ? (records.get(owner)?.state.tier ?? DEFAULT_TIER) : DEFAULT_TIER,
        });
      }
    } catch {
      open = null; // broker down: show the tiers and caps without a live figure
    }
    res.json({ ok: true, data: tierSummary({ config: loadTierConfig(), strategies, records: deps.store.all(), open, equity }) });
  });

  router.put('/config', (req, res) => {
    try {
      const cur = loadTierConfig();
      const b = req.body ?? {};
      res.json({ ok: true, data: saveTierConfig({ riskBudgetPct: b.riskBudgetPct ?? cur.riskBudgetPct, capSharePct: b.capSharePct ?? cur.capSharePct, groups: b.groups ?? cur.groups }) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/recheck', async (_req, res) => {
    try {
      res.json({ ok: true, data: await deps.service.recompute() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
