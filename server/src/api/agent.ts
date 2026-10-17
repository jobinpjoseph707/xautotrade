/**
 * Wires the agent service to the running server: the five /api/agent routes (reached with the agent
 * key) and /api/agent-runs (reached with the owner's key). The agent logic itself is in agent/ and is
 * tested with fakes; this file only connects it to the real stores.
 */
import { randomUUID } from 'node:crypto';

import { buildDossier } from '../agent/dossier.js';
import { createAgentRouter, createAgentRunsRouter, LlmCapped, LlmUnreachable } from '../agent/routes.js';
import { AgentRunner, RUN_TIMEOUT_MS, type ServiceClient } from '../agent/runner.js';
import { WeeklyAgentCycle, pickFailing } from '../agent/weekly.js';
import type { AgentNote, AgentRunRecord, RunResult, RunStep } from '../agent/types.js';
import { prepareProposals } from '../chat/actions.js';
import { agentModel, getAgent } from '../chat/agents.js';
import { CallCapError, ChatAuthError } from '../chat/backend.js';
import { config } from '../config.js';
import { gateStore } from '../gates/instance.js';
import { inbox } from '../inbox/instance.js';
import { buildJournal } from '../journal/journal.js';
import { mergeChanges } from '../learning/evolve.js';
import { settingOf, marketState } from '../learning/ledger.js';
import { heldSettings, retrieve } from '../learning/retrieve.js';
import { changeSignatures } from '../learning/signature.js';
import { SqliteRecordStore } from '../learning/sqliteRecords.js';
import { positionTag } from '../live/runner.js';
import { tierOf } from '../portfolio/instance.js';
import { tierName } from '../portfolio/config.js';
import { logs, settings, strategies } from '../store.js';
import { agentHost, backend, changes, lab, proposeUpdate, trials } from './chat.js';

export const agentNotes = new SqliteRecordStore<AgentNote>('agent_note');
const runStore = new SqliteRecordStore<AgentRunRecord>('agent_run');

const CLAUDE_DOWN = /sign-in on the laptop|Claude Code CLI not found/i;

/** Talks to the Python service over HTTP on this computer. */
export class HttpServiceClient implements ServiceClient {
  constructor(private readonly baseUrl: string, private readonly key: () => string) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-agent-key': this.key() };
  }

  async run(req: { runId: string; strategyId: string; kind: string; trigger: string }): Promise<RunResult> {
    const res = await fetch(`${this.baseUrl}/runs`, { method: 'POST', headers: this.headers(), body: JSON.stringify(req), signal: AbortSignal.timeout(RUN_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`the service answered ${res.status}`);
    return (await res.json()) as RunResult;
  }

  async trace(runId: string): Promise<RunStep[] | null> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the service answered ${res.status}`);
    return ((await res.json()) as { steps: RunStep[] }).steps;
  }
}

const client = config.agentServiceUrl ? new HttpServiceClient(config.agentServiceUrl.replace(/\/$/, ''), () => config.agentKey) : null;

export const runner = new AgentRunner({ store: runStore, client, strategy: (id) => strategies.get(id), changes, inbox });

const evidenceTrades = (id: string, from: number, to: number) => {
  const s = strategies.get(id);
  return buildJournal({
    logs: logs.tradesBetween(id, from, to), strategyNames: new Map([[id, s?.name ?? id]]), histories: new Map(), openPositions: [], tagOf: positionTag,
  });
};

const dossierDeps = {
  strategy: (id: string) => strategies.get(id),
  changes, notes: agentNotes, trials,
  stage: (s: { gate?: string }) => s.gate ?? 'backtest',
  tier: tierOf,
  trades: evidenceTrades,
  market: (s: Parameters<typeof lab.snapshot>[0]) => lab.snapshot(s),
};

export const agentRouter = createAgentRouter({
  runner,
  dossier: (id) => buildDossier(dossierDeps, id),
  strategy: (id) => strategies.get(id),
  changes, notes: agentNotes, trials,
  trialDeps: { merge: mergeChanges, validate: (before, after, safety, from) => lab.validateSince(before, after, from, safety) },
  known: async (s) => {
    const snap = await lab.snapshot(s).catch(() => null);
    const st = marketState(snap);
    return {
      market: s.symbol, timeframe: s.timeframe,
      marketState: st ? `volatility ${st.volatility}, trend ${st.trend}, spread ${st.spread}` : 'unknown (no spread reading)',
      tier: `${tierOf(s.id)} (${tierName(tierOf(s.id))})`,
    };
  },
  holds: async (s) => {
    const snap = await lab.snapshot(s).catch(() => null);
    return [...heldSettings(retrieve(changes.all(2000), { agent: 'optimizer', symbol: s.symbol, timeframe: s.timeframe, market: snap }))];
  },
  settingsOf: (s, c) => [...new Set(changeSignatures('update_strategy', s, mergeChanges(s, c)).map(settingOf))],
  checkChange: (id, c) => {
    const optimizer = getAgent('optimizer')!;
    const prepared = prepareProposals([{ type: 'update_strategy', id, changes: c }], optimizer, agentHost, () => randomUUID());
    return prepared.rejected.length ? { ok: false, error: prepared.rejected.map((r) => r.reason).join(' ') } : { ok: true };
  },
  llm: async (prompt, { agent, unattended }) => {
    const def = getAgent(agent);
    try {
      return await backend.complete(prompt, { model: def ? agentModel(def) : undefined, tag: agent, unattended });
    } catch (err) {
      if (err instanceof CallCapError) throw new LlmCapped(err.message);
      if (err instanceof ChatAuthError || CLAUDE_DOWN.test(err instanceof Error ? err.message : '')) throw new LlmUnreachable(err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
  propose: (trial, info) => proposeUpdate(trial, info),
});

export const agentRunsRouter = createAgentRunsRouter(runner);

export const weeklyCycle = new WeeklyAgentCycle({
  runner,
  enabled: () => !!client,
  lastRunAt: () => settings.get<number | null>('agentWeeklyAt', null),
  setLastRunAt: (ms) => settings.set('agentWeeklyAt', ms),
  pick: () =>
    pickFailing({
      strategies: strategies.list(),
      gates: strategies.list().map((s) => {
        const a = gateStore.latest(s.id, s.gate ?? 'backtest');
        return { strategyId: s.id, verdict: a?.verdict ?? null, at: a?.at ?? 0 };
      }),
      changes: changes.all(500),
      busy: (id) => !!runner.active(id),
    }),
  log: (message) => logs.add({ ts: Date.now(), strategyId: null, level: 'info', event: 'agents', message }),
});
