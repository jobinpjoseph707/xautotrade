import { Router } from 'express';

import { fastScalpTest } from '../engine/presets.js';
import { GateLockedError } from '../gates/types.js';
import type { GateService } from '../gates/service.js';
import { logs, strategies } from '../store.js';

/**
 * Testboard: stage, progress and verdict per strategy (task 2.1).
 * Mounted under /api, so it inherits the API-key middleware.
 *   GET  /api/testboard            one row per real strategy
 *   POST /api/testboard/:id/run    test the strategy in the stage it is in now
 */
export function createTestboardRouter(service: GateService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ ok: true, data: service.rows() });
  });

  router.post('/:id/run', async (req, res) => {
    try {
      res.json({ ok: true, data: await service.run(req.params.id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(err instanceof GateLockedError ? 403 : 400).json({ ok: false, error: message });
    }
  });

  /**
   * Test-only (404 unless the server was started with E2E_SEED=1): a strategy in the demo stage with
   * `trades` closed trades, so the browser tests have something to look at.
   */
  router.post('/_seed', (req, res) => {
    if (process.env.E2E_SEED !== '1') return void res.status(404).json({ ok: false, error: 'Not found.' });
    const trades = Math.max(0, Math.min(500, Number(req.body?.trades ?? 40)));
    const s = fastScalpTest('EURUSD');
    s.isTest = false;
    s.name = String(req.body?.name ?? 'E2E demo bot');
    s.gate = 'demo';
    strategies.save(s);
    for (let i = 0; i < trades; i++) {
      logs.add({ ts: Date.now() - (trades - i) * 60_000, strategyId: s.id, level: 'trade', event: 'position_closed', message: 'seeded', data: { positionId: `seed-${i}`, profit: i % 3 === 0 ? -8 : 10 } });
    }
    res.json({ ok: true, data: { strategyId: s.id } });
  });

  return router;
}
