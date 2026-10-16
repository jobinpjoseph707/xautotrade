/**
 * The five routes the agent service may call, and the owner's routes for starting and reading runs.
 * The service has no broker, no database and no way to write a strategy: everything it can do is here.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

import type { Strategy } from '../engine/types.js';
import { parseTheory } from '../learning/hypothesis.js';
import type { RecordStore } from '../learning/records.js';
import { claimSurvivor, openChange, testTheory, TrialRefused, type Trial, type TrialDeps, type SurvivedTrial } from '../learning/trials.js';
import type { ChangeRecord, MarketSnapshot, Validation } from '../learning/types.js';
import type { Proposal } from '../chat/actions.js';
import type { Dossier } from './dossier.js';
import { DEMO_WINDOW_DAYS } from './dossier.js';
import { AgentRunner, MAX_RUN_CALLS, RunRefused } from './runner.js';
import { RUN_KINDS, type AgentNote, type RunKind } from './types.js';

export const MAX_PROMPT_CHARS = 24_000;
export const MAX_NOTE_CHARS = 600;
export const MODEL_AGENTS = ['doctor', 'optimizer', 'critic', 'strategist'] as const;
const DAY = 86_400_000;

export class LlmUnreachable extends Error {}
export class LlmCapped extends Error {}

export interface AgentRouteDeps {
  runner: AgentRunner;
  dossier(strategyId: string): Promise<Dossier | null>;
  strategy(id: string): Strategy | null;
  changes: RecordStore<ChangeRecord>;
  notes: RecordStore<AgentNote>;
  trials: RecordStore<Trial>;
  trialDeps: {
    merge: TrialDeps['merge'];
    /** The unseen-data check where the "seen" bars are the evidence period and the unseen bars come before it. */
    validate(before: Strategy | null, after: Strategy, safety: boolean, evidenceFrom: number): Promise<{ validation: Validation; market?: MarketSnapshot }>;
  };
  /** The four checklist answers the server knows for itself. */
  known(s: Strategy): Promise<{ market: string; timeframe: string; marketState: string; tier: string }>;
  /** Settings trusted lessons disagree about for this strategy's market right now. */
  holds(s: Strategy): Promise<string[]>;
  /** Settings a set of changes touches (same names the ledger uses). */
  settingsOf(s: Strategy, changes: Record<string, unknown>): string[];
  /** Check the change is a legal update and say what it would produce. */
  checkChange(strategyId: string, changes: Record<string, unknown>): { ok: true } | { ok: false; error: string };
  /** One model call, through the capped backend. Throws LlmUnreachable / LlmCapped. */
  llm(prompt: string, opts: { agent: string; unattended: boolean }): Promise<string>;
  propose(trial: SurvivedTrial, info: { agent: string; proposalId: string }): Promise<{ proposal: Proposal | null; rejected: string[] }>;
  now?(): number;
}

const ok = (res: Response, data: unknown): void => void res.json({ ok: true, data });
const fail = (res: Response, status: number, message: string, code?: string): void => void res.status(status).json({ ok: false, error: message, code });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createAgentRouter(d: AgentRouteDeps): Router {
  const r = Router();
  const now = () => d.now?.() ?? Date.now();

  // 1. Read the dossier of one strategy.
  r.get('/dossier/:id', async (req: Request, res: Response) => {
    const dossier = await d.dossier(req.params.id);
    if (!dossier) return fail(res, 404, 'No such strategy.');
    ok(res, dossier);
  });

  // 2. Test a theory on bars nobody saw. The only way to get a surviving test.
  r.post('/backtest', async (req: Request, res: Response) => {
    const b = req.body ?? {};
    const runId = String(b.runId ?? '');
    if (!d.runner.isRunning(runId)) return fail(res, 404, 'Unknown or finished run.');
    const s = d.strategy(String(b.strategyId ?? ''));
    if (!s) return fail(res, 404, 'No such strategy.');
    const open = openChange(d.changes.all(500), s.id);
    if (open) return fail(res, 409, 'A change to this strategy is already waiting. One at a time.', 'open_change');
    const held = await d.holds(s);
    const theoryIn = isObj(b.theory) ? b.theory : {};
    const touched = isObj(theoryIn.changes) ? d.settingsOf(s, theoryIn.changes) : [];
    const hit = touched.filter((x) => held.includes(x));
    if (hit.length) return fail(res, 409, `Past results disagree about ${hit.join(', ')} in this market, so it is on hold.`, 'hold');
    if (isObj(theoryIn.changes)) {
      const checked = d.checkChange(s.id, theoryIn.changes);
      if (!checked.ok) return fail(res, 400, checked.error, 'bad_change');
    }
    const evidenceFrom = now() - DEMO_WINDOW_DAYS * DAY;
    const parsed = parseTheory(theoryIn, {
      strategy: s, agent: String(b.agent ?? 'optimizer'), id: randomUUID(), formedOn: { from: evidenceFrom, to: now() },
      known: await d.known(s), lessonsUsed: Array.isArray(theoryIn.lessonsUsed) ? (theoryIn.lessonsUsed as unknown[]).filter((x): x is string => typeof x === 'string') : [], runId,
    });
    if ('error' in parsed) return fail(res, 400, parsed.error, 'bad_theory');
    const trial = await testTheory(parsed.theory, s, {
      store: d.trials, merge: d.trialDeps.merge, now: d.now,
      validate: (before, after, safety) => d.trialDeps.validate(before, after, safety, evidenceFrom),
    });
    ok(res, {
      trialId: trial.id, status: trial.status, survived: trial.status === 'survived', reasons: trial.reasons,
      testWindow: trial.testWindow ?? null, validation: trial.validation ? { verdict: trial.validation.verdict, outOfSample: trial.validation.outOfSample } : null,
    });
  });

  // 3. One model call, counted against the run, through the server's capped backend.
  r.post('/llm', async (req: Request, res: Response) => {
    const b = req.body ?? {};
    const agent = String(b.agent ?? '');
    if (!(MODEL_AGENTS as readonly string[]).includes(agent)) return fail(res, 400, `Unknown agent "${agent}".`);
    const prompt = String(b.prompt ?? '');
    if (!prompt.trim()) return fail(res, 400, 'Empty prompt.');
    if (prompt.length > MAX_PROMPT_CHARS) return fail(res, 400, `Prompt is over ${MAX_PROMPT_CHARS} characters.`);
    const runId = String(b.runId ?? '');
    const counted = d.runner.beginCall(runId);
    if (counted === 'unknown') return fail(res, 404, 'Unknown or finished run.');
    if (counted === 'budget') return fail(res, 429, `A run may make at most ${MAX_RUN_CALLS} model calls.`, 'run_budget');
    const rec = d.runner.run(runId)!;
    try {
      ok(res, { text: await d.llm(prompt, { agent, unattended: rec.trigger !== 'owner' }) });
    } catch (err) {
      if (err instanceof LlmCapped) return fail(res, 429, err.message, 'call_cap');
      if (err instanceof LlmUnreachable) return fail(res, 503, err.message, 'claude_unreachable');
      fail(res, 502, err instanceof Error ? err.message : String(err), 'llm_error');
    }
  });

  // 4. An agent's note about a strategy, shown to the others in that market.
  r.post('/notes', (req: Request, res: Response) => {
    const b = req.body ?? {};
    const s = d.strategy(String(b.strategyId ?? ''));
    if (!s) return fail(res, 404, 'No such strategy.');
    if (!d.runner.isRunning(String(b.runId ?? ''))) return fail(res, 404, 'Unknown or finished run.');
    const text = String(b.text ?? '').trim().slice(0, MAX_NOTE_CHARS);
    if (!text) return fail(res, 400, 'A note needs text.');
    const evidence = Array.isArray(b.evidence) ? (b.evidence as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 6) : [];
    const note: AgentNote = { id: randomUUID(), createdAt: now(), strategyId: s.id, symbol: s.symbol, timeframe: s.timeframe, agent: String(b.agent ?? 'agent').slice(0, 24), runId: String(b.runId), text, evidence };
    d.notes.put(note);
    ok(res, { id: note.id });
  });

  // 5. Turn a SURVIVING test into a proposal. From here it is an ordinary proposal.
  r.post('/proposals', async (req: Request, res: Response) => {
    const b = req.body ?? {};
    const runId = String(b.runId ?? '');
    if (!d.runner.isRunning(runId)) return fail(res, 404, 'Unknown or finished run.');
    const strategyId = String(b.strategyId ?? '');
    if (!d.strategy(strategyId)) return fail(res, 404, 'No such strategy.');
    if (openChange(d.changes.all(500), strategyId)) return fail(res, 409, 'A change to this strategy is already waiting. One at a time.', 'open_change');
    const proposalId = randomUUID();
    let survivor: SurvivedTrial;
    try {
      survivor = claimSurvivor(d.trials, { trialId: String(b.trialId ?? ''), strategyId, changes: isObj(b.changes) ? b.changes : {}, proposalId }, now());
    } catch (err) {
      if (err instanceof TrialRefused) return fail(res, 422, err.message, 'no_survivor');
      throw err;
    }
    const out = await d.propose(survivor, { agent: 'optimizer', proposalId });
    if (!out.proposal) return fail(res, 422, `The server did not accept it: ${out.rejected.join(' ') || 'held back by its checks.'}`, 'rejected');
    d.runner.attachProposal(runId, out.proposal.id);
    ok(res, { proposalId: out.proposal.id, summary: out.proposal.summary });
  });

  return r;
}

/** The owner's side: start a run, see runs, read one step by step. */
export function createAgentRunsRouter(runner: AgentRunner): Router {
  const r = Router();
  r.get('/', (req: Request, res: Response) => {
    const strategyId = typeof req.query.strategyId === 'string' ? req.query.strategyId : null;
    ok(res, runner.list(60).filter((x) => !strategyId || x.strategyId === strategyId).map(({ steps, ...rest }) => ({ ...rest, stepCount: steps.length })));
  });
  r.post('/', (req: Request, res: Response) => {
    const kind = String(req.body?.kind ?? 'diagnose') as RunKind;
    if (!RUN_KINDS.includes(kind)) return fail(res, 400, 'kind must be diagnose or tune.');
    try {
      ok(res, runner.start(String(req.body?.strategyId ?? ''), kind, 'owner'));
    } catch (err) {
      if (err instanceof RunRefused) return fail(res, 409, err.message, 'refused');
      throw err;
    }
  });
  r.get('/:id', async (req: Request, res: Response) => {
    const rec = await runner.get(req.params.id);
    if (!rec) return fail(res, 404, 'No such run.');
    ok(res, rec);
  });
  return r;
}
