import { Router } from 'express';

import { attachInboxFeed } from '../inbox/feed.js';
import { InboxError } from '../inbox/inbox.js';
import { inbox } from '../inbox/instance.js';
import { INBOX_ACTIONS, type InboxAction, type InboxStatus } from '../inbox/types.js';
import { manager } from '../live/manager.js';
import { strategies } from '../store.js';

/**
 * Everything that needs the owner. Mounted under /api, so it inherits the API-key middleware.
 *   GET  /api/inbox?status=open|done|dismissed   newest first (default: open)
 *   POST /api/inbox/:id/act   { action }          press a button on a card (once)
 */
export const inboxRouter = Router();

const STATUSES: InboxStatus[] = ['open', 'done', 'dismissed'];

inboxRouter.get('/', (req, res) => {
  const status = STATUSES.includes(req.query.status as InboxStatus) ? (req.query.status as InboxStatus) : 'open';
  res.json({ ok: true, data: inbox.list(status) });
});

inboxRouter.post('/:id/act', async (req, res) => {
  const action = String(req.body?.action ?? '') as InboxAction;
  if (!INBOX_ACTIONS.includes(action)) return void res.status(400).json({ ok: false, error: 'Unknown action.' });
  try {
    res.json({ ok: true, data: await inbox.act(req.params.id, action) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Already acted on, or not on that card = the caller's mistake (409); anything else = a failed action (500).
    const status = err instanceof InboxError ? (/already|no longer/.test(message) ? 409 : 400) : 500;
    res.status(status).json({ ok: false, error: message });
  }
});

/**
 * Test-only: lets the browser tests put a card in the Inbox. Does nothing (404) unless the
 * server was started with E2E_SEED=1, which only the Playwright config sets.
 */
inboxRouter.post('/_seed', (req, res) => {
  if (process.env.E2E_SEED !== '1') return void res.status(404).json({ ok: false, error: 'Not found.' });
  const { item } = inbox.raise({ kind: 'losing_streak', title: String(req.body?.title ?? 'Seeded card'), body: 'Seeded by the browser test.', dedupeKey: `seed:${Date.now()}:${Math.random()}` });
  res.json({ ok: true, data: item });
});

/** Starts turning bot log events into Inbox cards. Call once at server start. */
export function startInboxFeed(): void {
  attachInboxFeed(manager, inbox, (id) => strategies.get(id)?.name ?? id);
}
