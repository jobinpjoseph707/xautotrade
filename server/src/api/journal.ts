import { Router, type Request, type Response } from 'express';

import type { BrokerPosition, PositionHistory } from '../broker/types.js';
import { buildJournal } from '../journal/journal.js';
import { manager } from '../live/manager.js';
import { positionIdOf, reconcileClosures, unmatchedEntries } from '../live/reconcile.js';
import { positionTag } from '../live/runner.js';
import { logs, positionHistory, strategies } from '../store.js';

export const journalRouter = Router();

/** Broker lookups per request: the MT5 bridge is serial, so details fill in over a few refreshes. */
const HISTORY_PER_REQUEST = 40;

const ok = (res: Response, data: unknown) => res.json({ ok: true, data });

/**
 * GET /api/journal?from=<ms>&to=<ms>
 *
 * Every trade the bots opened in the period (default: all time), with entry,
 * exit, stop, target, lots, P&L, why it closed and how long it was held.
 * Closes the server missed are first recovered from MT5 deal history, and
 * closed positions' exact details are cached forever (a closed trade never
 * changes), so repeat loads are cheap.
 */
journalRouter.get('/', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || now + 1;
    const all = strategies.list();
    const names = new Map(all.map((s) => [s.id, s.name]));

    let open: BrokerPosition[] = [];
    let brokerOk = true;
    try {
      await manager.broker.connect();
      open = await manager.broker.getPositions();
    } catch {
      brokerOk = false;
    }
    const openIds = new Set(open.map((p) => p.id));

    let rows = logs.tradesAll(from, to);
    // Recover closes that happened while nobody was watching (bot stopped, server restarting…).
    if (brokerOk && manager.broker.getPositionHistory) {
      let added = 0;
      for (const s of all) {
        const mine = rows.filter((r) => r.strategyId === s.id);
        if (!unmatchedEntries(mine, openIds).length) continue;
        added += (await reconcileClosures(s.id, manager.broker, logs, { since: from, openIds, now })).length;
        if (added > 60) break;
      }
      if (added) rows = logs.tradesAll(from, to);
    }

    // Exact numbers from MT5 for closed positions (cached once closed).
    const ids = [...new Set(rows.map(positionIdOf).filter((x): x is string => !!x))].filter((id) => !openIds.has(id));
    const histories = positionHistory.many<PositionHistory>(ids);
    let pending = ids.filter((id) => !histories.has(id));
    if (brokerOk && manager.broker.getPositionHistory) {
      for (const id of pending.slice(0, HISTORY_PER_REQUEST)) {
        try {
          const h = await manager.broker.getPositionHistory(id);
          if (h) {
            histories.set(id, h);
            if (h.closed) positionHistory.put(id, h);
          }
        } catch {
          /* try again next load */
        }
      }
      pending = ids.filter((id) => !histories.has(id));
    }

    const trades = buildJournal({
      logs: rows,
      strategyNames: names,
      histories,
      openPositions: open.filter((p) => (p.comment ?? '').startsWith('XAT:')),
      tagOf: positionTag,
    });
    ok(res, {
      from,
      to,
      trades,
      strategies: all.map((s) => ({ id: s.id, name: s.name, symbol: s.symbol })),
      pendingDetails: brokerOk && manager.broker.getPositionHistory ? pending.length : 0,
      brokerOk,
      generatedAt: now,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
