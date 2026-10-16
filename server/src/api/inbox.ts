import { Router } from 'express';

/**
 * Inbox: everything that needs the owner (task 1.4).
 * Mounted under /api, so it inherits the API-key middleware. Intentionally
 * empty until its task lands; the mobile client already has typed stubs.
 */
export const inboxRouter = Router();

inboxRouter.get('/', (_req, res) => {
  res.json({ ok: true, data: [] });
});
