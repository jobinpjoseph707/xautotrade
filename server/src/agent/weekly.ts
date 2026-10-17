/**
 * The weekly research cycle: once a week, one run on each strategy that is failing its gate, at most 3.
 * Strategies with a change waiting (in the Inbox or to be scored) or a run in progress are skipped.
 */
import type { Strategy } from '../engine/types.js';
import { openChange } from '../learning/trials.js';
import type { ChangeRecord } from '../learning/types.js';
import { MAX_WEEKLY_STRATEGIES, type AgentRunner } from './runner.js';
import type { AgentRunRecord } from './types.js';

const WEEK = 7 * 86_400_000;

export interface GateView {
  strategyId: string;
  verdict: 'pass' | 'fail' | 'not_enough_evidence' | null;
  /** When the failing test was made (older first: it has waited longest). */
  at: number;
}

export function pickFailing(args: { strategies: Strategy[]; gates: GateView[]; changes: ChangeRecord[]; busy(id: string): boolean; max?: number }): Strategy[] {
  const byId = new Map(args.strategies.filter((s) => !s.isTest).map((s) => [s.id, s]));
  return args.gates
    .filter((g) => g.verdict === 'fail' && byId.has(g.strategyId))
    .filter((g) => !openChange(args.changes, g.strategyId) && !args.busy(g.strategyId))
    .sort((a, b) => a.at - b.at || a.strategyId.localeCompare(b.strategyId))
    .slice(0, args.max ?? MAX_WEEKLY_STRATEGIES)
    .map((g) => byId.get(g.strategyId)!);
}

export interface WeeklyDeps {
  runner: AgentRunner;
  enabled(): boolean;
  lastRunAt(): number | null;
  setLastRunAt(ms: number): void;
  pick(): Strategy[];
  now?(): number;
  log?(message: string): void;
}

export class WeeklyAgentCycle {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly d: WeeklyDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  isDue(): boolean {
    if (!this.d.enabled()) return false;
    const last = this.d.lastRunAt();
    return last == null || this.now() - last >= WEEK;
  }

  /** One pass: at most 3 runs, one after another. Returns the runs that were started. */
  async runOnce(): Promise<AgentRunRecord[]> {
    if (!this.isDue()) return [];
    this.d.setLastRunAt(this.now());
    const out: AgentRunRecord[] = [];
    for (const s of this.d.pick().slice(0, MAX_WEEKLY_STRATEGIES)) {
      try {
        const rec = this.d.runner.start(s.id, 'tune', 'weekly');
        const done = await this.d.runner.settle(rec.id);
        if (done) out.push(done);
        this.d.log?.(`Weekly agent run on "${s.name}": ${done?.outcome ?? 'unknown'}`);
      } catch (err) {
        this.d.log?.(`Weekly agent run on "${s.name}" not started: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  start(everyMs = 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
