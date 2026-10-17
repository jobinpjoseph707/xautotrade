import type { ChatBackend } from '../chat/backend.js';
import type { Inbox } from '../inbox/inbox.js';
import type { InboxItem } from '../inbox/types.js';
import { utcDayKey, utcDayStart } from '../live/daily.js';
import { acceptExtra, buildDigestText, digestPeriod, digestPrompt, type DigestInput } from './digest.js';

const DAY = 86_400_000;
/** Sent on Sunday from this hour (UTC), so the week is nearly complete. */
export const DIGEST_HOUR_UTC = 18;

export interface KV {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface DigestDeps {
  /** Collects the numbers for [from, to). */
  gather(from: number, to: number): DigestInput;
  /** Optional. Called as an unattended call, so it counts toward the daily cap. */
  backend?: ChatBackend;
  inbox: Inbox;
  store: KV;
  clock?: () => number;
}

export class DigestService {
  private readonly clock: () => number;

  constructor(private readonly deps: DigestDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  /** Sunday, from 18:00 UTC, once per week. */
  isDue(now = this.clock()): boolean {
    const d = new Date(now);
    return d.getUTCDay() === 0 && d.getUTCHours() >= DIGEST_HOUR_UTC && this.deps.store.get<string | null>('digest:lastDay', null) !== utcDayKey(now);
  }

  /** Write this week's digest into the Inbox. `force` skips the Sunday rule (a "send now" for testing). */
  async run(force = false): Promise<InboxItem | null> {
    const now = this.clock();
    if (!force && !this.isDue(now)) return null;
    const dayKey = utcDayKey(now);
    if (!force) this.deps.store.set('digest:lastDay', dayKey); // before the slow part: a crash must not send it twice
    const to = utcDayStart(now) + DAY;
    const from = to - 7 * DAY;
    const input = this.deps.gather(from, to);
    let body = buildDigestText(input);
    if (this.deps.backend) {
      try {
        const extra = acceptExtra(await this.deps.backend.complete(digestPrompt(body), { tag: 'digest', unattended: true }), body);
        if (extra) body += `\n\nIn plain words: ${extra}`;
      } catch {
        /* the template is already complete */
      }
    }
    return this.deps.inbox.raise({
      kind: 'digest',
      severity: 'info',
      dedupeKey: `digest:${dayKey}`,
      title: `Weekly summary: ${digestPeriod(input)}`,
      body,
    }).item;
  }

  start(intervalMs = 3_600_000): NodeJS.Timeout {
    const t = setInterval(() => void this.run().catch(() => undefined), intervalMs);
    t.unref?.();
    return t;
  }
}
