/**
 * Live strategy runner.
 *
 * One runner per active strategy. It wakes just after each bar closes, applies
 * exactly the same indicator, rule and risk code the backtester uses, and then
 * asks the broker to act. Everything it does is gated behind the risk config
 * and a hard demo-account check.
 *
 * Two rules govern the design:
 *  - Never act on a forming bar. Signals are evaluated only on closed candles,
 *    which is what makes live behaviour comparable to the backtest.
 *  - Only ever touch positions this runner opened, identified by a comment tag.
 *    Anything you opened by hand in MT5 is left strictly alone.
 */

import { EventEmitter } from 'node:events';

import type { AccountInfo, Broker, BrokerPosition } from '../broker/types.js';
import { computeIndicators, warmupBars } from '../engine/indicators.js';
import { evaluateGroup, type EvalContext } from '../engine/rules.js';
import {
  computeLots,
  effectiveSpreadRatio,
  isFlatTime,
  isTradingTime,
  spreadTooWideForStop,
  slTpPrices,
  stopDistancePoints,
  targetDistancePoints,
  trailStop,
} from '../engine/risk.js';
import { barsForMinutes, clearSource, levelsFromRange, publishFromSource, type Bar, type Level } from '../engine/levels.js';
import { buildOverlays } from '../engine/overlays.js';
import { TIMEFRAME_MS, type Candle, type Side, type Strategy, type SymbolSpec } from '../engine/types.js';
import { logs, settings } from '../store.js';
import { dailyStatsFromLogs, estimateServerOffset, utcDayKey, utcDayStart } from './daily.js';
import { reconcileClosures } from './reconcile.js';

export type BotStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface BotSnapshot {
  strategyId: string;
  strategyName: string;
  symbol: string;
  timeframe: string;
  status: BotStatus;
  startedAt: number | null;
  lastTickAt: number | null;
  /** Open time of the last CLOSED bar, in real UTC (broker server-time offset removed). */
  lastBarTime: number | null;
  /** Broker server time minus real UTC, in minutes (MT5 stamps bars in server time). */
  serverOffsetMinutes: number;
  /** Floating P&L of this bot's open positions. */
  floatingProfit: number;
  nextTickAt: number | null;
  lastSignal: string | null;
  blockedReason: string | null;
  tradesToday: number;
  dayStartEquity: number | null;
  realisedToday: number;
  openPositions: BrokerPosition[];
  error: string | null;
  paper: boolean;
}

const TAG = 'XAT';

export class BotRunner extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private status: BotStatus = 'stopped';
  private startedAt: number | null = null;
  private lastTickAt: number | null = null;
  private lastBarTime: number | null = null;
  private nextTickAt: number | null = null;
  private lastSignal: string | null = null;
  private blockedReason: string | null = null;
  private error: string | null = null;

  private tradesToday = 0;
  private dayKey = '';
  private dayStartEquity: number | null = null;
  private realisedToday = 0;
  private lastEntryBarTime = 0;
  private openPositions: BrokerPosition[] = [];
  /** Rate-limits the "market closed" log so a long weekend isn't 1000 lines. */
  private lastMarketClosedLog: number | null = null;
  private spec: SymbolSpec | null = null;
  private ticking = false;
  /** Broker server time minus real time, estimated from fresh quotes. */
  private serverOffsetMs = 0;
  /** Positions whose close has already been recorded (or is being), so it is never counted twice. */
  private closedHandled = new Set<string>();
  /** When this runner last opened/closed something; older position snapshots are stale. */
  private lastMutationAt = 0;

  constructor(
    private strategy: Strategy,
    private broker: Broker,
    private allowLiveTrading: boolean,
    /** Real time source. Tests pass a fake clock; the flat window and sessions use it. */
    private clock: () => number = Date.now,
  ) {
    super();
  }

  private now(): number {
    return this.clock();
  }

  get strategyId(): string {
    return this.strategy.id;
  }

  getStatus(): BotStatus {
    return this.status;
  }

  snapshot(): BotSnapshot {
    return {
      strategyId: this.strategy.id,
      strategyName: this.strategy.name,
      symbol: this.strategy.symbol,
      timeframe: this.strategy.timeframe,
      status: this.status,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastBarTime: this.lastBarTime != null ? this.lastBarTime - this.serverOffsetMs : null,
      serverOffsetMinutes: Math.round(this.serverOffsetMs / 60_000),
      floatingProfit: Number(this.openPositions.reduce((a, p) => a + p.profit, 0).toFixed(2)),
      nextTickAt: this.nextTickAt,
      lastSignal: this.lastSignal,
      blockedReason: this.blockedReason,
      tradesToday: this.tradesToday,
      dayStartEquity: this.dayStartEquity,
      realisedToday: Number(this.realisedToday.toFixed(2)),
      openPositions: this.openPositions,
      error: this.error,
      paper: this.broker.kind === 'paper',
    };
  }

  private log(level: 'info' | 'warn' | 'error' | 'trade', event: string, message: string, data?: unknown): void {
    const entry = logs.add({ ts: Date.now(), strategyId: this.strategy.id, level, event, message, data });
    this.emit('log', entry);
  }

  private pushSnapshot(): void {
    this.emit('status', this.snapshot());
  }

  /**
   * Refreshes only this runner's live floating P&L / current price from a
   * positions list the caller already fetched (see BotManager's floating
   * refresh loop). This intentionally does NOT touch signals, indicators,
   * realised P&L accounting, or anything else in doTick() -- those must stay
   * tied to bar closes only (see the file header). Without this, the
   * dashboard showed stale P&L between bar closes -- for anything above an
   * M1 strategy that could be minutes of a frozen number while the market
   * (and the bot's real floating P&L) kept moving.
   */
  applyPositions(all: BrokerPosition[], fetchedAt = Date.now()): void {
    if (this.status !== 'running') return;
    // A snapshot requested before our own last order is stale: it would make a
    // just-opened position look closed (or a just-closed one look open).
    if (fetchedAt < this.lastMutationAt) return;
    void this.syncPositions(this.mine(all)).finally(() => this.pushSnapshot());
  }

  /** True while the end-of-day / weekend flat window is open for this strategy. */
  isFlatNow(): boolean {
    return isFlatTime(this.strategy.risk, this.now());
  }

  private flattening = false;

  /** Close this bot's positions because the flat window is open. Entries stay blocked by checkGates. */
  private async flatten(mine: BrokerPosition[]): Promise<void> {
    if (this.flattening || mine.length === 0) return;
    this.flattening = true;
    try {
      this.lastMutationAt = Date.now();
      for (const pos of mine) {
        this.closedHandled.add(pos.id);
        await this.broker.closePosition(pos.id);
        await this.recordClose(pos, 'exit', 'end-of-day flat');
      }
      this.lastMutationAt = Date.now();
      this.openPositions = this.mine(await this.broker.getPositions());
    } finally {
      this.flattening = false;
    }
  }

  /**
   * Called every few seconds by the manager with a fresh positions list, so a
   * strategy on a slow timeframe still goes flat on time instead of at its next bar.
   */
  async enforceFlat(all: BrokerPosition[]): Promise<void> {
    if (this.status !== 'running' || this.ticking || !this.isFlatNow()) return;
    try {
      await this.flatten(this.mine(all));
      this.pushSnapshot();
    } catch (err) {
      this.log('error', 'flat_failed', `Could not close positions for the flat window: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private mine(all: BrokerPosition[]): BrokerPosition[] {
    return all.filter(
      (p) => p.symbol === this.strategy.symbol && (p.comment ?? '').startsWith(`${TAG}:${shortId(this.strategy.id)}`),
    );
  }

  /**
   * Replace the open-position list and record every position that disappeared
   * (TP/SL hit, closed in MT5, stop-out). This runs from BOTH the bar-close
   * tick and the 4-second floating refresh; before, the refresh overwrote the
   * list first and the tick never saw the close, so closes went unrecorded.
   */
  private async syncPositions(mine: BrokerPosition[]): Promise<void> {
    const gone = this.openPositions.filter((p) => !mine.some((m) => m.id === p.id) && !this.closedHandled.has(p.id));
    this.openPositions = mine;
    for (const prev of gone) {
      this.closedHandled.add(prev.id);
      await this.recordClose(prev);
    }
  }

  /** Log a close with the broker's real result when it can tell us, else the last floating value seen. */
  private async recordClose(prev: BrokerPosition, event: 'position_closed' | 'exit' | 'panic_close' = 'position_closed', why?: string): Promise<void> {
    let profit = prev.profit;
    let price: number | null = prev.currentPrice;
    let reason: string | null = null;
    let source = 'last_seen';
    if (this.broker.getPositionHistory) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const h = await this.broker.getPositionHistory(prev.id);
          if (h?.closed) {
            profit = h.profit;
            price = h.closePrice ?? price;
            reason = h.reason;
            source = 'broker_history';
            break;
          }
        } catch {
          /* fall back to the last seen value */
        }
        await new Promise((r) => setTimeout(r, 300)); // the close deal can lag the position list by a moment
      }
    }
    this.realisedToday += profit;
    const label = why ?? (reason === 'tp' ? 'take-profit' : reason === 'sl' ? 'stop-loss' : reason === 'stop_out' ? 'stop-out' : reason === 'manual' ? 'closed manually' : null);
    const verb = event === 'panic_close' ? 'Force-closed' : event === 'exit' ? 'Closed' : '';
    const text = verb
      ? `${verb} ${prev.side.toUpperCase()} ${prev.volume} ${prev.symbol}${label ? ` on ${label}` : ''} (P&L ${profit.toFixed(2)})`
      : `${prev.side.toUpperCase()} ${prev.volume} ${prev.symbol} closed at ~${price}${label ? ` (${label})` : ''} for ${profit.toFixed(2)}`;
    this.log('trade', event, text, { ...prev, positionId: prev.id, profit, closePrice: price, reason, source });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.status = 'starting';
    this.error = null;
    this.pushSnapshot();

    try {
      await this.broker.connect();
      const account = await this.broker.getAccountInfo();

      if (account.type !== 'demo' && !this.allowLiveTrading) {
        throw new Error(
          'Refusing to trade a live account. Set ALLOW_LIVE_TRADING=true on the server only after the strategy has been forward-tested on demo.',
        );
      }

      // Refuse early, in plain words, when the broker can't trade this symbol at all
      // (e.g. BTCUSD on MetaQuotes-Demo) instead of failing on a raw bridge error.
      if (this.broker.getMarketStatus) {
        const m = await this.broker.getMarketStatus(this.strategy.symbol);
        if (!m.available || m.tradeMode === 'disabled' || m.tradeMode === 'close_only') {
          throw new Error(m.reason ?? `${this.strategy.symbol} can't be traded on this account.`);
        }
      }
      this.spec = await this.broker.getSymbolSpec(this.strategy.symbol);
      await this.restoreToday(account);
      this.startedAt = Date.now();
      this.status = 'running';
      this.log('info', 'bot_start', `Started on ${account.broker} (${account.type}) — ${this.strategy.symbol} ${this.strategy.timeframe}`, {
        balance: account.balance,
        equity: account.equity,
        broker: this.broker.kind,
      });

      // First tick immediately so the app shows state without waiting a full bar.
      void this.tick();
      this.scheduleNext();
      this.pushSnapshot();
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.log('error', 'bot_start_failed', this.error);
      this.pushSnapshot();
      throw err;
    }
  }

  /**
   * Starting equity for a UTC day, shared by every bot and kept in the DB, so a
   * server restart neither resets the daily loss cap nor moves its baseline.
   */
  private dayEquity(key: string, account: { equity: number; broker: string; server: string; name: string }): number {
    // Keyed by account too: logging into another MT5 account must not inherit this one's baseline.
    const k = `dayStartEquity:${account.broker}|${account.server}|${account.name}:${key}`;
    const saved = settings.get<number | null>(k, null);
    // A baseline more than 30% away from equity is not a trading loss (the daily cap stops
    // far earlier): it is a deposit/withdrawal or a reset demo balance. Start over.
    if (typeof saved === 'number' && saved > 0 && Math.abs(saved - account.equity) / Math.max(account.equity, 1) <= 0.3) return saved;
    settings.set(k, account.equity);
    return account.equity;
  }

  /** After a restart, rebuild today's counters from the trade log instead of starting from zero. */
  private async restoreToday(account: AccountInfo): Promise<void> {
    const now = Date.now();
    const key = utcDayKey(now);
    if (this.dayKey === key) return; // same process, counters are live
    // Book any of today's positions that closed while this bot wasn't watching.
    try {
      const open = new Set(this.mine(await this.broker.getPositions()).map((p) => p.id));
      const added = await reconcileClosures(this.strategy.id, this.broker, logs, { since: utcDayStart(now), openIds: open, now });
      for (const e of added) this.emit('log', e);
    } catch {
      /* best effort: counters below still come from whatever the log has */
    }
    const { tradesToday, realisedToday } = dailyStatsFromLogs(logs.tradesBetween(this.strategy.id, utcDayStart(now), now + 1), positionTag(this.strategy.id));
    this.dayKey = key;
    this.tradesToday = tradesToday;
    this.realisedToday = realisedToday;
    this.dayStartEquity = this.dayEquity(key, account);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextTickAt = null;
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      const ranMs = this.startedAt ? Date.now() - this.startedAt : null;
      const pnl = Number(this.realisedToday.toFixed(2));
      this.log(
        'info',
        'bot_stop',
        `Stopped "${this.strategy.name}" (${this.strategy.symbol}) after ${formatDuration(ranMs)} — P&L today ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}. Open positions were left untouched — close them in the app or in MT5.`,
        { strategyName: this.strategy.name, symbol: this.strategy.symbol, ranMs, realisedToday: pnl, openPositions: this.openPositions.length },
      );
    }
    // Remove this bot's lines; leaving them would imply it is still watching.
    void clearSource(`bot:${this.strategy.id}`).catch(() => {});
    this.pushSnapshot();
  }

  /** Wake a few seconds after the next bar close, so the broker has the candle. */
  private scheduleNext(): void {
    if (this.status !== 'running') return;
    const step = TIMEFRAME_MS[this.strategy.timeframe];
    const now = Date.now();
    const nextClose = Math.ceil(now / step) * step;
    const delay = Math.max(nextClose - now + 4000, 2000);
    this.nextTickAt = now + delay;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, delay);
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking || this.status !== 'running') return;
    this.ticking = true;
    try {
      await this.doTick();
      this.error = null;
    } catch (err) {
      // A closed market is an expected daily condition, not a fault. Surfacing
      // it as an error made a normal maintenance break look like a broken bot,
      // and buried real errors in the noise.
      if (isMarketClosed(err)) {
        this.blockedReason = err instanceof Error ? err.message : String(err);
        this.error = null;
        if (this.lastMarketClosedLog === null || Date.now() - this.lastMarketClosedLog > 30 * 60_000) {
          this.lastMarketClosedLog = Date.now();
          this.log('info', 'market_closed', this.blockedReason);
        }
      } else {
        this.error = err instanceof Error ? err.message : String(err);
        this.log('error', 'tick_failed', this.error);
      }
    } finally {
      this.ticking = false;
      this.lastTickAt = Date.now();
      this.pushSnapshot();
    }
  }

  private async doTick(): Promise<void> {
    const s = this.strategy;
    const risk = s.risk;
    const spec = this.spec ?? (this.spec = await this.broker.getSymbolSpec(s.symbol));
    const step = TIMEFRAME_MS[s.timeframe];

    // --- Refresh account & our positions ------------------------------------
    const account = await this.broker.getAccountInfo();
    const all = await this.broker.getPositions();
    const mine = all.filter((p) => p.symbol === s.symbol && (p.comment ?? '').startsWith(`${TAG}:${shortId(s.id)}`));

    // --- Daily bookkeeping ---------------------------------------------------
    const key = utcDayKey(Date.now());
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.tradesToday = 0;
      this.realisedToday = 0;
      this.dayStartEquity = this.dayEquity(key, account);
      this.log('info', 'day_reset', `New trading day. Starting equity ${this.dayStartEquity.toFixed(2)} ${account.currency}.`);
    }
    if (this.dayStartEquity == null) this.dayStartEquity = this.dayEquity(key, account);

    // Detect closures since the last tick so realised P&L stays honest.
    await this.syncPositions(mine);

    // --- End-of-day / weekend flat window -----------------------------------
    // Same rule as the backtest: close everything, open nothing, until the window ends.
    if (this.isFlatNow()) {
      await this.flatten(mine);
      this.blockedReason = 'Flat window (end of day or weekend): positions closed, no new entries.';
      return;
    }

    // --- Candles: drop the bar that is still forming -------------------------
    const need = Math.max(warmupBars(s.indicators) + 60, 260);
    const raw = await this.broker.getCandles(s.symbol, s.timeframe, need);
    // Drop the forming bar by POSITION, not by comparing to the wall clock.
    // The bridge reports MetaTrader's *server* time labelled as UTC, and this
    // broker runs UTC+3, so a clock comparison marks recent bars as "not yet
    // finished" and would silently evaluate signals on a bar hours old.
    // Candles arrive oldest-first, so the last one is the one still forming.
    const closed: Candle[] = raw.length > 1 ? raw.slice(0, -1) : raw;
    if (closed.length < warmupBars(s.indicators) + 3) {
      this.blockedReason = `Waiting for history (${closed.length} closed bars, need ${warmupBars(s.indicators) + 3}).`;
      return;
    }

    const i = closed.length - 1;
    const bar = closed[i];
    this.lastBarTime = bar.time;

    const quote = await this.broker.getQuote(s.symbol);
    const nextOffset = estimateServerOffset(quote.time, Date.now(), this.serverOffsetMs);
    if (nextOffset !== this.serverOffsetMs) settings.set('serverOffsetMs', nextOffset); // backtests reuse the last known offset
    this.serverOffsetMs = nextOffset;
    const ctx: EvalContext = {
      candles: closed,
      indicators: computeIndicators(closed, s.indicators),
      spreadPoints: quote.spreadPoints,
      serverOffsetMs: this.serverOffsetMs,
    };

    const longSignal = evaluateGroup(s.entryLong, i, ctx);
    const shortSignal = evaluateGroup(s.entryShort, i, ctx);
    this.lastSignal = longSignal && !shortSignal ? 'LONG' : shortSignal && !longSignal ? 'SHORT' : 'none';

    // --- Manage what is already open ----------------------------------------
    for (const pos of mine) {
      const exitRule = pos.side === 'long' ? s.exitLong : s.exitShort;
      const ruleExit = evaluateGroup(exitRule, i, ctx);
      const oppositeExit =
        risk.closeOnOppositeSignal &&
        ((pos.side === 'long' && shortSignal) || (pos.side === 'short' && longSignal));

      if (ruleExit || oppositeExit) {
        this.closedHandled.add(pos.id);
        this.lastMutationAt = Date.now();
        await this.broker.closePosition(pos.id);
        await this.recordClose(pos, 'exit', ruleExit ? 'exit rule' : 'opposite signal');
        continue;
      }

      const mark = pos.side === 'long' ? quote.bid : quote.ask;
      const newSl = trailStop(pos.side, pos.openPrice, mark, pos.stopLoss, risk, spec);
      if (newSl != null) {
        await this.broker.modifyPosition(pos.id, newSl, pos.takeProfit);
        this.log('info', 'trail', `Moved stop on ${pos.id} to ${newSl}`, { from: pos.stopLoss, to: newSl });
      }
    }

    this.lastMutationAt = Math.max(this.lastMutationAt, Date.now());
    await this.syncPositions(this.mine(await this.broker.getPositions()));

    // --- Chart levels --------------------------------------------------------
    // Best-effort and deliberately last: drawing is cosmetic, and a failure
    // here must never stop the bot from managing real money.
    if (s.showLevels || s.showOverlays) {
      try {
        await this.refreshLevels(closed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[levels] refresh failed for ${s.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // Both switched off while running: take this bot's lines off the chart.
      void clearSource(`bot:${s.id}`).catch(() => {});
    }

    // --- Entry gates ---------------------------------------------------------
    const gate = this.checkGates(bar, quote.spreadPoints, this.openPositions.length, account.equity);
    this.blockedReason = gate;
    if (gate) return;

    if (longSignal === shortSignal) return; // no signal, or contradictory
    const side: Side = longSignal ? 'long' : 'short';

    // --- Size and place ------------------------------------------------------
    const atrSeries = risk.atrIndicatorId ? ctx.indicators[risk.atrIndicatorId]?.value : undefined;
    const atrVal = atrSeries ? (atrSeries[i] as number | null) : null;
    const slPts = stopDistancePoints(risk, atrVal, spec);
    const tpPts = targetDistancePoints(risk, atrVal, slPts, spec);
    // No stop, no trade. And a spread that eats more than 15% of the stop gives the edge away.
    if (slPts == null) {
      this.blockedReason = 'No stop distance available yet (the ATR is still warming up), so no order was placed.';
      return;
    }
    if (spreadTooWideForStop(quote.spreadPoints, slPts, risk)) {
      this.blockedReason = `Spread ${quote.spreadPoints} is more than ${Math.round(effectiveSpreadRatio(risk) * 100)}% of the ${Math.round(slPts)}-point stop.`;
      return;
    }
    const lots = computeLots(risk, account.balance, slPts, spec);
    const entryRef = side === 'long' ? quote.ask : quote.bid;
    const { sl, tp } = slTpPrices(side, entryRef, slPts, tpPts, spec);

    if (lots <= 0) {
      this.log('warn', 'sizing', 'Computed lot size was zero — check your risk settings.');
      return;
    }

    this.lastMutationAt = Date.now();
    const result = await this.broker.openPosition({
      symbol: s.symbol,
      side,
      volume: lots,
      stopLoss: sl,
      takeProfit: tp,
      comment: `${TAG}:${shortId(s.id)}`,
      clientId: `${TAG}_${shortId(s.id)}_${Date.now().toString(36)}`,
    });

    this.tradesToday += 1;
    this.lastEntryBarTime = bar.time;
    this.log('trade', 'entry', `Opened ${side.toUpperCase()} ${lots} ${s.symbol} @ ~${entryRef} (SL ${sl ?? '—'}, TP ${tp ?? '—'})`, {
      positionId: result.positionId,
      side,
      symbol: s.symbol,
      entryPrice: entryRef,
      lots,
      sl,
      tp,
      spreadPoints: quote.spreadPoints,
      barTime: bar.time,
    });
    // Only OUR positions: the raw list includes every other bot's and manual trades,
    // which the next sync would then have "closed" and booked to this bot.
    this.lastMutationAt = Date.now();
    this.openPositions = this.mine(await this.broker.getPositions());
  }

  /** Returns a human-readable reason entries are blocked, or null if clear. */
  private checkGates(bar: Candle, spreadPoints: number, openCount: number, equity: number): string | null {
    const risk = this.strategy.risk;
    const step = TIMEFRAME_MS[this.strategy.timeframe];

    if (openCount >= risk.maxOpenPositions) {
      return `Max open positions reached (${openCount}/${risk.maxOpenPositions}).`;
    }
    if (risk.maxDailyTrades > 0 && this.tradesToday >= risk.maxDailyTrades) {
      return `Daily trade limit reached (${this.tradesToday}/${risk.maxDailyTrades}).`;
    }
    if (risk.maxDailyLossPercent > 0 && this.dayStartEquity) {
      const lossPct = ((this.dayStartEquity - equity) / this.dayStartEquity) * 100;
      if (lossPct >= risk.maxDailyLossPercent) {
        return `Daily loss limit hit (${lossPct.toFixed(2)}% of ${this.dayStartEquity.toFixed(2)}). Trading is paused until tomorrow.`;
      }
    }
    if (risk.maxSpreadPoints > 0 && spreadPoints > risk.maxSpreadPoints) {
      return `Spread too wide (${spreadPoints} > ${risk.maxSpreadPoints} points).`;
    }
    if (!isTradingTime(risk, this.now())) {
      return 'Outside the configured trading session.';
    }
    if (this.lastEntryBarTime && (bar.time - this.lastEntryBarTime) / step < risk.cooldownBars) {
      return `Cooling down (${risk.cooldownBars} bars between entries).`;
    }
    return null;
  }

  /**
   * Redraw this strategy's recent high/low on the chart.
   *
   * Uses the same completed-bar array the signals were evaluated on, so the
   * lines always match what the bot actually saw — fetching separately could
   * show a level the strategy never traded against.
   */
  private async refreshLevels(closed: Candle[]): Promise<void> {
    const s = this.strategy;
    const minutes = s.levelsMinutes && s.levelsMinutes > 0 ? s.levelsMinutes : 30;
    const levels: Level[] = [];

    if (s.showLevels) {
      const tfMinutes = TIMEFRAME_MS[s.timeframe] / 60_000;
      const slice = closed.slice(-barsForMinutes(minutes, tfMinutes));
      if (slice.length) {
        const bars: Bar[] = slice.map((c) => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
        levels.push(
          ...levelsFromRange(s.symbol, bars, {
            // Namespaced per strategy so two bots on one symbol don't fight over ids.
            idPrefix: `bot_${shortId(s.id)}`,
            label: `${s.name} ${minutes}m`,
          }),
        );
      }
    }
    if (s.showOverlays) {
      // Everything the strategy looks at: indicator curves, rule checklist, its trades.
      levels.push(...buildOverlays(s, closed, this.openPositions, { range: false }).levels);
    }
    await publishFromSource(`bot:${s.id}`, levels);
  }

  /** Close every position this runner owns, right now. */
  async closeAll(): Promise<number> {
    const mine = this.mine(await this.broker.getPositions());
    this.lastMutationAt = Date.now();
    for (const p of mine) {
      this.closedHandled.add(p.id);
      await this.broker.closePosition(p.id);
      await this.recordClose(p, 'panic_close');
    }
    this.openPositions = [];
    this.pushSnapshot();
    return mine.length;
  }

  updateStrategy(s: Strategy): void {
    this.strategy = s;
    this.spec = null;
    this.log('info', 'strategy_updated', 'Strategy definition reloaded.');
    this.pushSnapshot();
  }
}

/**
 * Is this error the broker simply not quoting?
 *
 * Checks a marker property rather than instanceof, so it still works if the
 * error crossed a module boundary or was re-wrapped on the way up.
 */
function isMarketClosed(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { marketClosed?: boolean }).marketClosed) return true;
  const text = err instanceof Error ? err.message : String(err);
  return /not quoting|market is closed|PRICE_OFF|No prices/i.test(text);
}

/** MT5 comments are short; 8 chars of the id is plenty to disambiguate. */
/** The comment tag this bot puts on its orders, e.g. "XAT:5b1fd6fe". */
export function positionTag(strategyId: string): string {
  return `${TAG}:${shortId(strategyId)}`;
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
}

/** e.g. 90_000 -> "1m 30s"; null (never started) -> "0s". */
function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
