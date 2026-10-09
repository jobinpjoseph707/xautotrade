import type { EventEmitter } from 'node:events';

import type { LogEntry } from '../store.js';
import type { Inbox } from './inbox.js';

/** Consecutive losing closes before a "losing streak" card is raised. */
export const LOSING_STREAK = 5;
const CLOSE_EVENTS = new Set(['position_closed', 'exit', 'panic_close']);

/**
 * Turns the bots' log stream into Inbox cards. Logs themselves are untouched
 * (they still go to the table and the live feed); this only picks out what a
 * person has to look at: errors and losing streaks. Repeats of the same open
 * problem are counted by the Inbox, not added again.
 */
export function attachInboxFeed(
  source: Pick<EventEmitter, 'on'>,
  inbox: Inbox,
  nameOf: (strategyId: string) => string = (id) => id,
): void {
  const streak = new Map<string, number>();

  source.on('log', (e: LogEntry) => {
    const sid = e.strategyId;

    if (e.level === 'error') {
      const name = sid ? nameOf(sid) : 'Server';
      inbox.raise({
        kind: 'error',
        severity: 'critical',
        strategyId: sid,
        dedupeKey: `error:${sid ?? 'server'}`,
        title: `${name}: something went wrong`,
        body: e.message,
        data: { event: e.event },
      });
      return;
    }

    if (sid && e.event === 'bot_start') {
      inbox.resolveKey(`error:${sid}`, 'The bot started again.');
      return;
    }

    if (sid && CLOSE_EVENTS.has(e.event)) {
      const profit = (e.data as { profit?: unknown } | undefined)?.profit;
      if (typeof profit !== 'number' || !Number.isFinite(profit)) return;
      if (profit >= 0) {
        streak.set(sid, 0);
        inbox.resolveKey(`streak:${sid}`, 'A winning trade ended the streak.');
        return;
      }
      const n = (streak.get(sid) ?? 0) + 1;
      streak.set(sid, n);
      if (n >= LOSING_STREAK) {
        inbox.raise({
          kind: 'losing_streak',
          severity: 'warn',
          strategyId: sid,
          dedupeKey: `streak:${sid}`,
          title: `${nameOf(sid)}: ${n} losing trades in a row`,
          body: `The last ${n} closed trades all lost. The bot keeps trading unless you stop it. Open Strategies to look at it, or ask Diagnose why.`,
        });
      }
    }
  });
}
