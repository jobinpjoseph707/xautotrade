import { Router } from 'express';

import { gateStore } from '../gates/instance.js';
import { testboardRows } from '../gates/testboard.js';
import { strategies } from '../store.js';

/**
 * Testboard: gate stage and verdict per strategy (task 2.1).
 * Mounted under /api, so it inherits the API-key middleware.
 */
export const testboardRouter = Router();

testboardRouter.get('/', (_req, res) => {
  res.json({ ok: true, data: testboardRows(strategies.list(), gateStore) });
});
