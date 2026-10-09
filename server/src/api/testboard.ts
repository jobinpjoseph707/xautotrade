import { Router } from 'express';

/**
 * Testboard: gate stage and verdict per strategy (task 2.1).
 * Mounted under /api, so it inherits the API-key middleware. Intentionally
 * empty until its task lands; the mobile client already has typed stubs.
 */
export const testboardRouter = Router();

testboardRouter.get('/', (_req, res) => {
  res.json({ ok: true, data: [] });
});
