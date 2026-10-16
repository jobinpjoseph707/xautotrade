import { runReplay } from '../broker/paperReplay.js';
import type { Broker } from '../broker/types.js';
import { GATE_STAGES, type Strategy } from '../engine/types.js';
import type { Inbox } from '../inbox/inbox.js';
import type { LogEntry } from '../store.js';
import { demoEvidence, closedProfits } from './demoEvidence.js';
import { GateEngine, nextStage } from './engine.js';
import { realGateData } from './source.js';
import { GateLockedError, type GateAttempt, type GateRefusal, type GateStore } from './types.js';
import { testboardRows, type TestboardRow } from './testboard.js';

export interface GateServiceDeps {
  broker: () => Broker;
  savedOffset: () => number;
  store: GateStore;
  inbox: Pick<Inbox, 'raise'>;
  strategies: { list(): Strategy[]; get(id: string): Strategy | null; save(s: Strategy): Strategy };
  /** Trade-level log lines for one strategy in [from, to). */
  tradesBetween: (strategyId: string, from: number, to: number) => LogEntry[];
  allowLiveTrading: () => boolean;
  now?: () => number;
  bars?: number;
}

/** Runs the gate that belongs to a strategy's current stage, and moves it on when the owner taps. */
export class GateService {
  readonly engine: GateEngine;
  private readonly now: () => number;

  constructor(private readonly deps: GateServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.engine = new GateEngine({ store: deps.store, inbox: deps.inbox, strategies: deps.strategies, now: this.now });
  }

  /** When the strategy entered its current stage: the time of the last pass of the stage before it. */
  private since(s: Strategy): number {
    const i = GATE_STAGES.indexOf(s.gate ?? 'backtest');
    const before = i > 0 ? GATE_STAGES[i - 1] : null;
    return (before && this.deps.store.latest(s.id, before)?.at) || 0;
  }

  private demoLogs(s: Strategy): LogEntry[] {
    return this.deps.tradesBetween(s.id, this.since(s), this.now() + 1);
  }

  rows(): TestboardRow[] {
    return testboardRows(this.deps.strategies.list(), this.deps.store, (s) => {
      const since = this.since(s);
      const closes = closedProfits(this.demoLogs(s));
      const first = closes[0]?.ts ?? this.now();
      return { trades: closes.length, days: (this.now() - Math.max(since, first)) / 86_400_000 };
    });
  }

  /** Test the strategy in the stage it is in now. */
  async run(strategyId: string): Promise<GateAttempt | GateRefusal> {
    const s = this.deps.strategies.get(strategyId);
    if (!s) throw new Error('That strategy does not exist.');
    if (s.isTest) throw new GateLockedError('Test strategies are not put through the stages.');
    const stage = s.gate ?? 'backtest';
    const broker = this.deps.broker();
    switch (stage) {
      case 'backtest':
        return this.engine.runBacktestGate(s, (st) => realGateData(broker, st, this.deps.bars ?? 3000, this.deps.savedOffset()));
      case 'paper': {
        const data = await realGateData(broker, s, this.deps.bars ?? 3000, this.deps.savedOffset());
        return this.engine.runPaperGate(s, await runReplay(s, data));
      }
      case 'demo': {
        const entries = this.demoLogs(s);
        const total = closedProfits(entries).reduce((a, c) => a + c.profit, 0);
        const account = await broker.getAccountInfo();
        const evidence = demoEvidence(entries, this.since(s), this.now(), account.equity - total);
        return this.engine.runDemoGate(s, evidence);
      }
      default:
        throw new GateLockedError('The live stage is locked. Nothing in this app can move a strategy to live.');
    }
  }

  /** What the Inbox "Move to next stage" button does. */
  async moveNext(strategyId: string): Promise<{ gate: string }> {
    const s = this.deps.strategies.get(strategyId);
    if (!s) throw new Error('That strategy does not exist.');
    const to = nextStage(s.gate ?? 'backtest');
    if (!to) throw new GateLockedError('There is no stage after this one.');
    const moved = this.engine.moveStage(strategyId, to, { allowLiveTrading: this.deps.allowLiveTrading() });
    return { gate: moved.gate ?? to };
  }
}
