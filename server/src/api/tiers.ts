import { Router } from 'express';

/**
 * Risk tiers and open-risk caps (task 2.2).
 * Mounted under /api, so it inherits the API-key middleware. Intentionally
 * empty until its task lands; the mobile client already has typed stubs.
 */
export const tiersRouter = Router();

tiersRouter.get('/', (_req, res) => {
  res.json({ ok: true, data: [] });
});
