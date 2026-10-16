import { randomUUID } from 'node:crypto';

import { runBacktest } from '../engine/backtest.js';
import { validateStrategy } from '../engine/rules.js';
import { GATE_STAGES, type BacktestTrade, type GateStage, type Strategy } from '../engine/types.js';
import type { Inbox } from '../inbox/inbox.js';
import {
  GateLockedError,
  PASS_MARKS,
  type DemoEvidence,
  type GateAttempt,
  type GateDataSource,
  type GateRefusal,
  type GateStore,
  type GateVerdict,
} from './types.js';

const STAGE_LABEL: Record<GateStage, string> = { backtest: 'Backtest', paper: 'Paper', demo: 'Demo', live: 'Live' };

/** Gross profit over gross loss. 999 when nothing lost, 0 when nothing happened (same as the backtester). */
export function profitFactor(trades: Pick<BacktestTrade, 'netProfit'>[]): number {
  let win = 0;
  let loss = 0;
  for (const t of trades) {
    if (t.netProfit > 0) win += t.netProfit;
    else loss -= t.netProfit;
  }
  return loss > 0 ? Math.round((win / loss) * 100) / 100 : win > 0 ? 999 : 0;
}

export function nextStage(stage: GateStage): GateStage | null {
  const i = GATE_STAGES.indexOf(stage);
  return i >= 0 && i < GATE_STAGES.length - 1 ? GATE_STAGES[i + 1] : null;
}

export interface BacktestNumbers {
  trades: number;
  unseenTrades: number;
  unseenProfitFactor: number;
  /** Profit factor on the unseen bars with the spread doubled. */
  stressedProfitFactor: number;
  requiredProfitFactor: number;
}

/** The backtest pass marks, as a pure function so every edge can be tested. */
export function judgeBacktest(n: BacktestNumbers): { verdict: GateVerdict; reasons: string[] } {
  const m = PASS_MARKS.backtest;
  const thin: string[] = [];
  const bad: string[] = [];
  if (n.trades < m.minTrades) thin.push(`Only ${n.trades} trades in total (need ${m.minTrades}).`);
  if (n.unseenTrades < m.minUnseenTrades) thin.push(`Only ${n.unseenTrades} trades on bars it was never tuned on (need ${m.minUnseenTrades}).`);
  if (n.unseenProfitFactor < n.requiredProfitFactor) {
    bad.push(`Profit factor on unseen bars is ${n.unseenProfitFactor.toFixed(2)}; this attempt needs ${n.requiredProfitFactor.toFixed(2)}.`);
  }
  if (n.stressedProfitFactor < m.stressMinProfitFactor) {
    bad.push(`With the spread doubled it loses money (profit factor ${n.stressedProfitFactor.toFixed(2)}).`);
  }
  if (bad.length) return { verdict: 'fail', reasons: [...bad, ...thin] };
  if (thin.length) return { verdict: 'not_enough_evidence', reasons: thin };
  return { verdict: 'pass', reasons: [] };
}

/** The demo pass marks, as a pure function. */
export function judgeDemo(e: DemoEvidence, maxDrawdownPct: number = PASS_MARKS.demo.defaultMaxDrawdownPct): { verdict: GateVerdict; reasons: string[] } {
  const m = PASS_MARKS.demo;
  const thin: string[] = [];
  const bad: string[] = [];
  if (e.days < m.minDays) thin.push(`Only ${e.days.toFixed(1)} days on demo (need ${m.minDays}).`);
  if (e.trades < m.minTrades) thin.push(`Only ${e.trades} demo trades (need ${m.minTrades}).`);
  if (thin.length) return { verdict: 'not_enough_evidence', reasons: thin };
  if (!(e.profitFactor > m.minProfitFactor)) bad.push(`Profit factor ${e.profitFactor.toFixed(2)} must be above ${m.minProfitFactor}.`);
  if (e.avgWin < e.avgLoss) bad.push(`Average win (${e.avgWin.toFixed(2)}) is smaller than average loss (${e.avgLoss.toFixed(2)}). Bigger wins, smaller losses.`);
  if (e.maxDrawdownPct > maxDrawdownPct) bad.push(`Drawdown ${e.maxDrawdownPct.toFixed(1)}% is over the ${maxDrawdownPct}% limit.`);
  return bad.length ? { verdict: 'fail', reasons: bad } : { verdict: 'pass', reasons: [] };
}

export interface GateEngineDeps {
  store: GateStore;
  inbox?: Pick<Inbox, 'raise'>;
  strategies: { get(id: string): Strategy | null; save(s: Strategy): Strategy };
  now?: () => number;
  /** Replaceable so tests can hand back exact trades. */
  backtest?: typeof runBacktest;
}

export class GateEngine {
  private readonly now: () => number;
  private readonly backtest: typeof runBacktest;

  constructor(private readonly deps: GateEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.backtest = deps.backtest ?? runBacktest;
  }

  /**
   * Test a strategy in the backtest stage. The candles come from `source`, which has to supply
   * real broker candles: there is no default, so this can never fall back to made-up prices.
   */
  async runBacktestGate(strategy: Strategy, source: GateDataSource): Promise<GateAttempt | GateRefusal> {
    const m = PASS_MARKS.backtest;
    const errors = validateStrategy(strategy);
    const data = await source(strategy);
    const candles = data.candles;
    const lastBar = candles.length ? candles[candles.length - 1].time : 0;

    // Where this run of attempts stands: same unseen bars until 5 tries, then 500 new bars.
    const prev = this.deps.store.latest(strategy.id, 'backtest');
    let attemptNo = 1;
    let unseenFrom = candles[Math.floor(candles.length * (1 - m.unseenShare))]?.time ?? lastBar;
    if (prev?.attemptNo != null && prev.unseenFrom != null && prev.lastBar != null) {
      const newBars = candles.filter((c) => c.time > prev.lastBar!).length;
      if (prev.attemptNo >= m.maxAttempts && newBars < m.newBarsAfterMax) {
        return {
          refused: true,
          reason: `${m.maxAttempts} attempts have used these bars up. It can be tested again after ${m.newBarsAfterMax} new bars (${newBars} so far).`,
        };
      }
      if (prev.attemptNo < m.maxAttempts) {
        attemptNo = prev.attemptNo + 1;
        unseenFrom = prev.unseenFrom;
      }
    }
    const required = Math.round((m.minUnseenProfitFactor + m.attemptStep * (attemptNo - 1)) * 100) / 100;

    let attempt: GateAttempt;
    if (errors.length) {
      attempt = this.record(strategy, 'backtest', 'fail', errors, {}, { attemptNo, requiredProfitFactor: required, unseenFrom, lastBar });
    } else {
      const run = (spreadOverridePoints: number | null) =>
        this.backtest(strategy, candles, { initialBalance: 10_000, spec: data.spec, maxEquityPoints: 10, serverOffsetMs: data.serverOffsetMs, spreadOverridePoints });
      const base = run(null);
      const stressed = run(data.spec.spreadPoints * m.stressSpreadMultiple);
      const unseen = (r: { trades: BacktestTrade[] }) => r.trades.filter((t) => t.openTime >= unseenFrom);
      const numbers: BacktestNumbers = {
        trades: base.trades.length,
        unseenTrades: unseen(base).length,
        unseenProfitFactor: profitFactor(unseen(base)),
        stressedProfitFactor: profitFactor(unseen(stressed)),
        requiredProfitFactor: required,
      };
      const j = judgeBacktest(numbers);
      attempt = this.record(strategy, 'backtest', j.verdict, j.reasons, { ...numbers, bars: candles.length }, { attemptNo, requiredProfitFactor: required, unseenFrom, lastBar });
    }
    this.announce(strategy, attempt);
    return attempt;
  }

  /** Test a strategy that has been trading on the demo account. */
  runDemoGate(strategy: Strategy, evidence: DemoEvidence, maxDrawdownPct?: number): GateAttempt {
    const j = judgeDemo(evidence, maxDrawdownPct);
    const attempt = this.record(strategy, 'demo', j.verdict, j.reasons, { ...evidence });
    this.announce(strategy, attempt);
    return attempt;
  }

  /**
   * Record a paper replay (broker/paperReplay.ts) as the paper-stage test. It checks the plumbing:
   * no refused stops, no lot above the cap, no errors.
   */
  runPaperGate(strategy: Strategy, replay: { passed: boolean; reasons: string[]; trades: unknown[]; ticks: number }): GateAttempt {
    const attempt = this.record(strategy, 'paper', replay.passed ? 'pass' : 'fail', replay.reasons, { trades: replay.trades.length, ticks: replay.ticks });
    this.announce(strategy, attempt);
    return attempt;
  }

  /**
   * Move a strategy one stage on. Only called when the owner taps; a passing gate never does it.
   * Live is locked: it is refused whatever the live-trading setting says.
   */
  moveStage(strategyId: string, to: GateStage, opts: { allowLiveTrading: boolean }): Strategy {
    if (to === 'live') {
      // `opts.allowLiveTrading` is deliberately not consulted: the live stage is locked either way.
      throw new GateLockedError('The live stage is locked. Nothing in this app can move a strategy to live.');
    }
    const s = this.deps.strategies.get(strategyId);
    if (!s) throw new Error('That strategy does not exist.');
    if (s.isTest) throw new GateLockedError('Test strategies do not move through the stages.');
    const from = s.gate ?? 'backtest';
    if (nextStage(from) !== to) throw new GateLockedError(`A strategy in ${STAGE_LABEL[from]} can only move to ${nextStage(from) ? STAGE_LABEL[nextStage(from)!] : 'nowhere'}.`);
    const last = this.deps.store.latest(strategyId, from);
    if (!last?.passed) throw new GateLockedError(`${STAGE_LABEL[from]} has not been passed yet.`);
    return this.deps.strategies.save({ ...s, gate: to });
  }

  private record(
    strategy: Strategy,
    stage: GateStage,
    verdict: GateVerdict,
    reasons: string[],
    evidence: Record<string, number>,
    extra: Partial<GateAttempt> = {},
  ): GateAttempt {
    const attempt: GateAttempt = {
      id: randomUUID(),
      strategyId: strategy.id,
      stage,
      at: this.now(),
      passed: verdict === 'pass',
      verdict,
      reasons,
      evidence: Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k, Number.isFinite(v) ? v : 999])),
      ...extra,
    };
    this.deps.store.append(attempt);
    return attempt;
  }

  /** A pass writes an Inbox card and nothing else: the strategy stays where it is until the owner taps. */
  private announce(strategy: Strategy, a: GateAttempt): void {
    if (!a.passed || !this.deps.inbox) return;
    const to = nextStage(a.stage);
    if (!to || to === 'live') return;
    this.deps.inbox.raise({
      kind: 'gate_result',
      severity: 'info',
      strategyId: strategy.id,
      ref: a.id,
      dedupeKey: `gate:${strategy.id}:${a.stage}`,
      title: `${strategy.name} passed ${STAGE_LABEL[a.stage]}`,
      body: `It can move to ${STAGE_LABEL[to]}. It stays in ${STAGE_LABEL[a.stage]} until you tap Move to next stage.`,
      data: { from: a.stage, to },
    });
  }
}
