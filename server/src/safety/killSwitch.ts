/**
 * The account-level loss cap. If equity falls 3% (default) below where the day started,
 * every bot is paused and every position the bots opened is closed. It fires once a day.
 *
 * Measured on EQUITY, so an open loss counts before it is realised. Positions you opened by hand
 * in MT5 are never touched: only orders whose comment starts with "XAT:" are closed.
 *
 * This is a safety net on top of each strategy's own daily cap, not a replacement for it.
 */
import type { AccountInfo, Broker, BrokerPosition } from '../broker/types.js';
import type { Inbox } from '../inbox/inbox.js';
import type { Strategy } from '../engine/types.js';
import { utcDayKey } from '../live/daily.js';

export const DEFAULT_DAILY_LOSS_CAP_PCT = 3;
const BOT_COMMENT_PREFIX = 'XAT:';

/** The small key-value store this needs (the app's `settings`; a Map in tests). */
export interface KV {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface KillSwitchDeps {
  broker: Pick<Broker, 'getAccountInfo' | 'getPositions' | 'closePosition'>;
  /** Stops every bot and marks it paused by safety. Returns the strategies it paused. */
  pauseAll(): Strategy[];
  inbox: Inbox;
  store: KV;
  clock?: () => number;
  /** Percent of day-start equity; read each check so it can be changed live. */
  capPct?: () => number;
}

export interface KillSwitchResult {
  fired: boolean;
  lossPct: number;
  /** Positions that could not be closed (the Inbox card says so). */
  failed: string[];
}

interface DayStart {
  day: string;
  equity: number;
}

export class KillSwitch {
  private readonly clock: () => number;
  private busy = false;

  constructor(private readonly deps: KillSwitchDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  private cap(): number {
    return this.deps.capPct?.() ?? DEFAULT_DAILY_LOSS_CAP_PCT;
  }

  /** Has the switch fired today (UTC)? Starting a bot is refused until the day changes. */
  trippedToday(): boolean {
    return this.deps.store.get<string | null>('killswitch:firedDay', null) === utcDayKey(this.clock());
  }

  /** The message shown when a start is refused, or null. */
  startBlockedReason(): string | null {
    return this.trippedToday()
      ? 'The daily loss cap stopped trading today. Bots can be started again after 00:00 UTC.'
      : null;
  }

  private dayStart(account: AccountInfo): DayStart {
    const day = utcDayKey(this.clock());
    const saved = this.deps.store.get<DayStart | null>('killswitch:dayStart', null);
    if (saved && saved.day === day) return saved;
    const fresh = { day, equity: account.equity };
    this.deps.store.set('killswitch:dayStart', fresh);
    return fresh;
  }

  async check(): Promise<KillSwitchResult> {
    if (this.busy) return { fired: false, lossPct: 0, failed: [] };
    this.busy = true;
    try {
      const account = await this.deps.broker.getAccountInfo();
      const start = this.dayStart(account);
      const lossPct = start.equity > 0 ? ((start.equity - account.equity) / start.equity) * 100 : 0;
      if (lossPct + 1e-9 < this.cap() || this.trippedToday()) return { fired: false, lossPct, failed: [] };

      // Stop new orders first, then close what the bots opened.
      const day = utcDayKey(this.clock());
      this.deps.store.set('killswitch:firedDay', day);
      const paused = this.deps.pauseAll();
      const failed: string[] = [];
      let closed = 0;
      let positions: BrokerPosition[] = [];
      try {
        positions = await this.deps.broker.getPositions();
      } catch (err) {
        failed.push(`could not list positions (${err instanceof Error ? err.message : String(err)})`);
      }
      for (const p of positions.filter((x) => (x.comment ?? '').startsWith(BOT_COMMENT_PREFIX))) {
        try {
          await this.deps.broker.closePosition(p.id);
          closed++;
        } catch (err) {
          failed.push(`${p.symbol} ${p.id} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      this.deps.inbox.raise({
        kind: 'safety_action',
        severity: 'critical',
        dedupeKey: `killswitch:${day}`,
        title: `Daily loss cap hit: equity is down ${lossPct.toFixed(1)}% today`,
        body:
          `Every bot was paused and ${closed} position(s) opened by bots were closed. ` +
          'Positions you opened yourself in MT5 were not touched. ' +
          (failed.length ? `COULD NOT CLOSE: ${failed.join('; ')}. Close them by hand in MT5. ` : '') +
          'Bots can be started again after 00:00 UTC.',
        data: { startEquity: start.equity, equity: account.equity, paused: paused.map((s) => s.id), closed, failed },
      });
      return { fired: true, lossPct, failed };
    } finally {
      this.busy = false;
    }
  }

  start(intervalMs = 30_000): NodeJS.Timeout {
    const t = setInterval(() => void this.check().catch(() => undefined), intervalMs);
    t.unref?.();
    return t;
  }
}
