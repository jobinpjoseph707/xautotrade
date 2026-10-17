/**
 * Starts and tracks runs of the agent service. The service does the talking between agents; this
 * class only decides whether a run may start, remembers it, counts its model calls and turns a
 * failure into ONE Inbox card. It never changes a strategy.
 */
import { randomUUID } from 'node:crypto';

import type { Inbox } from '../inbox/inbox.js';
import type { RecordStore } from '../learning/records.js';
import { openChange } from '../learning/trials.js';
import type { ChangeRecord } from '../learning/types.js';
import type { Strategy } from '../engine/types.js';
import type { AgentRunRecord, RunKind, RunResult, RunStep, RunTrigger } from './types.js';

/** Most model calls one run may make (the service counts too; this is the server's own limit). */
export const MAX_RUN_CALLS = 8;
/** A run that has not finished by now is treated as dead. */
export const RUN_TIMEOUT_MS = 20 * 60_000;
export const MAX_WEEKLY_STRATEGIES = 3;

export class RunRefused extends Error {}

export interface ServiceClient {
  /** Runs the whole graph and returns when it ends. Throws when the service cannot be reached. */
  run(req: { runId: string; strategyId: string; kind: RunKind; trigger: RunTrigger }): Promise<RunResult>;
  /** Steps so far, from the service's saved run. Null when it has no such run. */
  trace(runId: string): Promise<RunStep[] | null>;
}

export interface RunnerDeps {
  store: RecordStore<AgentRunRecord>;
  /** Null when no service is configured. */
  client: ServiceClient | null;
  strategy(id: string): Strategy | null;
  changes: RecordStore<ChangeRecord>;
  inbox: Pick<Inbox, 'raise' | 'resolveKey'>;
  now?(): number;
}

export class AgentRunner {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly d: RunnerDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  list(limit = 30): AgentRunRecord[] {
    return this.d.store.all(limit);
  }

  /** The run in progress for a strategy, if any (a run past its timeout is closed as failed). */
  active(strategyId: string): AgentRunRecord | null {
    for (const r of this.d.store.all(200)) {
      if (r.strategyId !== strategyId || r.status !== 'running') continue;
      if (this.now() - r.createdAt > RUN_TIMEOUT_MS) {
        this.d.store.put({ ...r, status: 'failed', outcome: 'error', summary: 'The run did not finish in time and was closed.', finishedAt: this.now() });
        continue;
      }
      return r;
    }
    return null;
  }

  /** Why a run may not start on this strategy right now, or null. */
  refusal(strategyId: string): string | null {
    if (!this.d.client) return 'The agent service is not set up (AGENT_SERVICE_URL is empty).';
    const s = this.d.strategy(strategyId);
    if (!s) return 'That strategy does not exist.';
    if (this.active(strategyId)) return 'A run is already in progress on this strategy.';
    const open = openChange(this.d.changes.all(500), strategyId);
    if (open) {
      return open.status === 'pending'
        ? 'A change to this strategy is waiting in the Inbox. Approve or reject it first.'
        : 'A change to this strategy is waiting to be scored. Wait for its 30 demo trades before changing it again.';
    }
    return null;
  }

  /** Start a run in the background. Returns the saved record at once; the app reads progress with get(). */
  start(strategyId: string, kind: RunKind, trigger: RunTrigger): AgentRunRecord {
    const why = this.refusal(strategyId);
    if (why) throw new RunRefused(why);
    const s = this.d.strategy(strategyId)!;
    const rec: AgentRunRecord = { id: randomUUID(), createdAt: this.now(), strategyId, strategyName: s.name, kind, trigger, status: 'running', steps: [], modelCalls: 0 };
    this.d.store.put(rec);
    this.running.set(rec.id, this.execute(rec));
    return rec;
  }

  /** Wait for a run to end (tests, and the weekly cycle). */
  async settle(runId: string): Promise<AgentRunRecord | null> {
    await this.running.get(runId);
    return this.d.store.get(runId);
  }

  private async execute(rec: AgentRunRecord): Promise<void> {
    const client = this.d.client!;
    try {
      const res = await client.run({ runId: rec.id, strategyId: rec.strategyId, kind: rec.kind, trigger: rec.trigger });
      const cur = this.d.store.get(rec.id) ?? rec;
      this.d.store.put({
        ...cur, status: 'done', outcome: res.outcome, summary: res.summary, steps: res.steps,
        proposalId: res.proposalId ?? cur.proposalId, modelCalls: res.modelCalls, finishedAt: this.now(),
      });
      this.d.inbox.resolveKey('agent_service_down', 'The agent service answered again.');
      if (res.outcome === 'claude_unreachable') {
        this.d.inbox.raise({
          kind: 'claude_unavailable', severity: 'warn', dedupeKey: 'claude_unavailable',
          title: 'The AI agents cannot answer: Claude is not signed in on the laptop',
          body: `A run on "${rec.strategyName}" stopped for that reason. Nothing was changed.`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cur = this.d.store.get(rec.id) ?? rec;
      this.d.store.put({ ...cur, status: 'failed', outcome: 'service_down', summary: `The agent service could not be reached: ${message}`, finishedAt: this.now() });
      this.d.inbox.raise({
        kind: 'agent_unavailable', severity: 'warn', dedupeKey: 'agent_service_down',
        title: 'The agent service is not running',
        body: `A run on "${rec.strategyName}" could not start (${message}). Nothing was changed and trading is not affected.`,
      });
    } finally {
      this.running.delete(rec.id);
    }
  }

  /** One record with its steps. While a run is going, the steps come from the service. */
  async get(id: string): Promise<AgentRunRecord | null> {
    const rec = this.d.store.get(id);
    if (!rec) return null;
    if (rec.status === 'running' && this.d.client) {
      try {
        const steps = await this.d.client.trace(id);
        if (steps) return { ...rec, steps };
      } catch {
        /* the saved record is still correct */
      }
    }
    return rec;
  }

  /** Count one model call against a run. False when the run is unknown, over its limit or not running. */
  beginCall(runId: string): 'ok' | 'budget' | 'unknown' {
    const rec = this.d.store.get(runId);
    if (!rec || rec.status !== 'running') return 'unknown';
    if ((rec.modelCalls ?? 0) >= MAX_RUN_CALLS) return 'budget';
    this.d.store.put({ ...rec, modelCalls: (rec.modelCalls ?? 0) + 1 });
    return 'ok';
  }

  isRunning(runId: string): boolean {
    return this.d.store.get(runId)?.status === 'running';
  }

  attachProposal(runId: string, proposalId: string): void {
    const rec = this.d.store.get(runId);
    if (rec) this.d.store.put({ ...rec, proposalId });
  }

  run(runId: string): AgentRunRecord | null {
    return this.d.store.get(runId);
  }
}
