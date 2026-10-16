/**
 * The broker's clock, learned only from prices that move.
 *
 * MT5 stamps every quote in the broker's own time zone, so the engine needs the
 * offset between that clock and real UTC to know what hour a bar belongs to.
 * The offset is inferred by comparing a quote's timestamp with the current time
 * and rounding to a half hour (see estimateServerOffset).
 *
 * A closed market returns the same last quote forever. Measured against an
 * advancing clock, that frozen quote drifts into the next half-hour boundary
 * down every thirty minutes, and the estimator accepts each one, so the offset
 * decays: 3h, 2h, 1.5h, 1h, 0.5h, 0. On 9 October 2026 this reported closed
 * forex markets as open and, through live/runner.ts, reached the trading
 * engine's idea of the hour of day.
 *
 * So only a quote whose timestamp has actually changed may teach the clock. An
 * offset confirmed by such a quote is kept through a closed market; an offset
 * learned before any price was seen to move is provisional, and is dropped as
 * soon as the price is shown to be stopped, leaving the clock unknown rather
 * than wrong.
 */
import { estimateServerOffset } from './daily.js';

/** Same quote timestamp for at least this long means the price has stopped, not that it is quiet. */
const FROZEN_AFTER_MS = 10_000;

export class ServerClock {
  private offsetMs: number | null = null;
  private confirmedFlag = false;
  /** Per symbol: the last quote timestamp seen, and when this process first saw it. */
  private readonly seen = new Map<string, { raw: number; at: number }>();

  constructor(private readonly frozenAfterMs: number = FROZEN_AFTER_MS) {}

  /** The offset in ms, or null while it is unknown. */
  get offset(): number | null {
    return this.offsetMs;
  }

  /** True once a price that visibly moved has set the offset. */
  get confirmed(): boolean {
    return this.confirmedFlag;
  }

  /**
   * Feed one quote. Returns the offset after this observation (null = unknown).
   * `quoteTimeMs` is the raw broker timestamp, before any offset is applied.
   */
  observe(symbol: string, quoteTimeMs: number, nowMs: number = Date.now()): number | null {
    if (!Number.isFinite(quoteTimeMs) || quoteTimeMs <= 0) return this.offsetMs;

    const prev = this.seen.get(symbol);
    const moving = prev != null && prev.raw !== quoteTimeMs;
    const frozen = prev != null && prev.raw === quoteTimeMs && nowMs - prev.at >= this.frozenAfterMs;
    if (prev == null || moving) this.seen.set(symbol, { raw: quoteTimeMs, at: nowMs });

    const candidate = estimateServerOffset(quoteTimeMs, nowMs, Number.NaN);
    if (!frozen && Number.isFinite(candidate)) {
      if (this.offsetMs == null) {
        this.offsetMs = candidate; // provisional: nothing has been seen to move yet
      } else if (moving) {
        this.offsetMs = candidate;
        this.confirmedFlag = true;
      }
    }
    if (frozen && !this.confirmedFlag) this.offsetMs = null; // provisional value came from a stopped price

    return this.offsetMs;
  }

  /** Forget everything. For tests and for a broker change. */
  reset(): void {
    this.offsetMs = null;
    this.confirmedFlag = false;
    this.seen.clear();
  }
}

/** The one clock the live engine shares across strategies. */
export const serverClock = new ServerClock();
