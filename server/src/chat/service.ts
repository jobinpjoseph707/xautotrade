import { randomUUID } from 'node:crypto';

import type { Strategy } from '../engine/types.js';
import { critique, type CriticInput } from '../learning/critic.js';
import { buildNotebook, notebookLines } from '../learning/notebook.js';
import type { RecordStore } from '../learning/records.js';
import { changeSignatures } from '../learning/signature.js';
import type { ChangeRecord, DemoStats, MarketSnapshot, Validation } from '../learning/types.js';
import { applyProposal, describeChanges, extractActions, prepareProposals, type ApplyHost, type Proposal } from './actions.js';
import { AGENTS, agentModel, getAgent, routeAgent, type AgentDef, type AgentId } from './agents.js';
import { modelLabel, type ChatBackend } from './backend.js';
import { buildPrompt, type BacktestInfo, type BotInfo, type ChatTurn, type LogInfo } from './prompt.js';

/** Hooks for the learning layer. All optional so the chat works without them. */
export interface LearningDeps {
  changes: RecordStore<ChangeRecord>;
  /** Out-of-sample check on a window the agent never saw. */
  validate?(before: Strategy | null, after: Strategy, safetyChange: boolean): Promise<{ validation: Validation; market?: MarketSnapshot }>;
  /** Realised demo results for a strategy over a period. */
  demoStats?(strategyId: string, from: number, to: number): DemoStats;
  /** User-pinned notebook notes for an agent. */
  notes?(agent: string): string[];
  /** 'llm' = rule checks + a Critic agent call; 'rules' = rule checks only. Default 'llm'. */
  critic?: 'off' | 'rules' | 'llm';
  /** Hold back updates that fail out-of-sample (default true). false = show with a warning. */
  blockFailed?: boolean;
  now?(): number;
}

export interface ChatDeps {
  backend: ChatBackend;
  host: ApplyHost & { list(): Strategy[] };
  bots(): BotInfo[];
  issues(): LogInfo[];
  /** Run (or fetch cached) backtests. Optional: agents work without it. */
  backtests?(strategies: Strategy[]): Promise<BacktestInfo[]>;
  /** Is this symbol offered by the broker? Used to warn before approving a strategy that can never trade. */
  marketCheck?(symbol: string): Promise<{ available: boolean; reason: string | null }>;
  learning?: LearningDeps;
}

export interface ChatResult {
  agent: AgentId;
  agentName: string;
  model: string;
  reply: string;
  proposals: Proposal[];
  /** Actions the agent asked for that were refused, with the reason. */
  rejected: string[];
}

const MAX_KEPT = 100;
const TTL_MS = 24 * 3_600_000;
const DAY = 86_400_000;

function outcomeLine(r: ChangeRecord): string {
  const d = new Date(r.decidedAt ?? r.createdAt).toISOString().slice(0, 10);
  const why = r.score === 'pending' ? 'not scored yet' : `${r.score.toUpperCase()}${r.scoreReasons.length ? ` — ${r.scoreReasons[r.scoreReasons.length - 1]}` : ''}`;
  return `${d} ${r.agent}: ${r.summary.slice(0, 160)} → ${why}`;
}

export class ChatService {
  private proposals = new Map<string, Proposal>();

  constructor(private readonly deps: ChatDeps) {}

  private now(): number {
    return this.deps.learning?.now?.() ?? Date.now();
  }

  agents() {
    return AGENTS.map((a) => ({ id: a.id, name: a.name, tagline: a.tagline, model: modelLabel(this.deps.backend, agentModel(a)) }));
  }

  async chat(input: { agent?: string; message: string; history?: ChatTurn[] }): Promise<ChatResult> {
    const message = input.message?.trim();
    if (!message) throw new Error('Type a message first.');
    const strategies = this.deps.host.list();
    const id: string = input.agent && input.agent !== 'auto' ? input.agent : routeAgent(message, strategies.length > 0);
    const agent = getAgent(id);
    if (!agent) throw new Error(`Unknown agent "${input.agent}".`);
    const model = agentModel(agent);
    const label = modelLabel(this.deps.backend, model);

    // Backtests are slow, so only run them when the request is about performance.
    // Keep this list generous: a false negative here silently drops a diagnosing
    // agent (Doctor/Optimizer/Guard) back to config-only guessing, which is worse than
    // an occasional unnecessary backtest pass (already capped + cached 10 min).
    const wantsBacktest =
      /back\s?test|optimi[sz]|suitab|perform|profit|worth keeping|which (one|strateg)|best|worst|remove|delete|clean|los(s|ing|e)\b|improv|\bworking\b|\bbroken\b|\bresults?\b|\bstats?\b|win\s?rate|drawdown|\bedge\b|how.*doing|why.*(losing|loss|bad)/i.test(
        message,
      );
    let backtests: BacktestInfo[] | undefined;
    if (wantsBacktest && this.deps.backtests && strategies.length && agent.id !== 'strategist') {
      backtests = await this.deps.backtests(strategies);
    }

    const history = this.deps.learning?.changes.all(500) ?? [];
    const notebook = this.deps.learning ? notebookLines(buildNotebook(agent.id, history, this.deps.learning.notes?.(agent.id) ?? [])) : undefined;
    const outcomes = history.filter((r) => r.status === 'approved').slice(0, 8).map(outcomeLine);

    const prompt = buildPrompt({
      agent,
      message,
      history: input.history ?? [],
      strategies,
      bots: this.deps.bots(),
      issues: this.deps.issues(),
      backtests,
      notebook,
      outcomes,
    });
    const text = await this.deps.backend.complete(prompt, { model, tag: agent.id });

    const { reply, raw, parseError } = extractActions(text);
    const prepared = prepareProposals(raw, agent, this.deps.host, () => randomUUID(), () => this.now());
    const rejected = prepared.rejected.map((r) => r.reason);
    const proposals = await this.review(prepared.proposals, agent, label, rejected, history);

    this.prune();
    for (const p of proposals) this.proposals.set(p.id, p);

    return {
      agent: agent.id,
      agentName: agent.name,
      model: label,
      reply: reply || (proposals.length ? 'Here is what I propose:' : '(no reply)'),
      proposals,
      rejected: [...rejected, ...(parseError ? [parseError] : [])],
    };
  }

  /**
   * Validate on unseen data, hold back failures, attach the critic's verdict,
   * and write every proposal (shown or held back) to outcome memory.
   */
  private async review(list: Proposal[], agent: AgentDef, label: string, rejected: string[], history: ChangeRecord[]): Promise<Proposal[]> {
    const L = this.deps.learning;
    if (!L) return list.map((p) => ({ ...p, model: label }));

    const kept: { p: Proposal; rec: ChangeRecord; changedFields: number }[] = [];
    for (const p0 of list) {
      const p: Proposal = { ...p0, model: label };
      const a = p.action;
      const strategyId = a.type === 'create_strategy' ? a.strategy.id : a.id;
      const before = a.type === 'create_strategy' ? null : this.deps.host.get(a.id);
      const after = a.type === 'create_strategy' ? a.strategy : a.type === 'update_strategy' ? a.merged : null;
      const ref = after ?? before;
      const rec: ChangeRecord = {
        id: p.id,
        createdAt: p.createdAt,
        source: 'chat',
        agent: agent.id,
        model: label,
        actionType: a.type,
        strategyId,
        symbol: ref?.symbol ?? null,
        timeframe: ref?.timeframe ?? null,
        summary: p.summary,
        reason: p.reason,
        signatures: changeSignatures(a.type, before, after),
        before,
        after,
        changes: a.type === 'update_strategy' ? a.changes : undefined,
        warnings: p.warnings,
        status: 'pending',
        score: 'pending',
        scoreReasons: [],
      };

      if (after && this.deps.marketCheck) {
        try {
          const m = await this.deps.marketCheck(after.symbol);
          if (!m.available) p.warnings = [`NOT TRADABLE: ${m.reason ?? `${after.symbol} is not offered by your broker.`}`, ...p.warnings];
        } catch {
          /* best effort */
        }
      }

      if (after && L.validate) {
        try {
          const { validation, market } = await L.validate(before, after, !!agent.tightenOnly);
          p.validation = validation;
          rec.validation = validation;
          rec.market = market;
        } catch (err) {
          p.validation = { verdict: 'error', reasons: [`Could not run the unseen-data check: ${err instanceof Error ? err.message : String(err)}`] };
          rec.validation = p.validation;
        }
        const v = p.validation!;
        if (v.verdict === 'fail' && a.type === 'update_strategy' && L.blockFailed !== false) {
          rec.status = 'blocked';
          rec.decidedAt = this.now();
          rec.proposal = p;
          L.changes.put(rec);
          rejected.push(`Held back "${p.summary}" — it did worse on data the agent never saw. ${v.reasons.slice(1).join(' ')}`.trim());
          continue;
        }
        if (v.verdict === 'fail') p.warnings = [...p.warnings, `Failed the unseen-data check: ${v.reasons.slice(1).join(' ')}`];
        if (v.verdict === 'insufficient') p.warnings = [...p.warnings, 'UNPROVEN: not enough data to test this on a window the agent never saw.'];
        if (v.verdict === 'error') p.warnings = [...p.warnings, v.reasons[0]];
      }
      const changedFields = before && after ? describeChanges(before, after).length : 0;
      kept.push({ p, rec, changedFields });
    }

    const mode = L.critic ?? 'llm';
    if (mode !== 'off' && kept.length) {
      const critic = getAgent('critic')!;
      const inputs: CriticInput[] = kept.map(({ p, rec, changedFields }) => ({
        actionType: rec.actionType,
        strategyId: rec.strategyId,
        summary: p.summary,
        reason: p.reason,
        signatures: rec.signatures,
        changedFields,
        warnings: p.warnings,
        validation: p.validation,
      }));
      const lessons = notebookLines(buildNotebook('critic', history, L.notes?.('critic') ?? []));
      const verdicts = await critique(inputs, history, {
        backend: mode === 'llm' ? this.deps.backend : undefined,
        model: agentModel(critic),
        lessons,
        now: this.now(),
      });
      kept.forEach((k, i) => {
        k.p.critic = verdicts[i];
        k.rec.critic = verdicts[i];
      });
    }

    for (const k of kept) {
      k.rec.warnings = k.p.warnings;
      k.rec.proposal = k.p;
      L.changes.put(k.rec);
    }
    return kept.map((k) => k.p);
  }

  pending(): Proposal[] {
    const live = [...this.proposals.values()].filter((p) => p.status === 'pending');
    const seen = new Set(live.map((p) => p.id));
    const cutoff = this.now() - TTL_MS;
    const stored = (this.deps.learning?.changes.all(200) ?? [])
      .filter((r) => r.status === 'pending' && r.proposal && !seen.has(r.id) && r.createdAt >= cutoff)
      .map((r) => r.proposal!);
    return [...live, ...stored];
  }

  async approve(id: string): Promise<Proposal> {
    const p = this.mustGet(id);
    if (p.status !== 'pending') throw new Error(`This proposal was already ${p.status}.`);
    try {
      p.resultMessage = await applyProposal(p, this.deps.host);
      p.status = 'approved';
    } catch (err) {
      p.status = 'failed';
      p.resultMessage = err instanceof Error ? err.message : String(err);
    }
    this.recordDecision(p);
    return p;
  }

  reject(id: string): Proposal {
    const p = this.mustGet(id);
    if (p.status !== 'pending') throw new Error(`This proposal was already ${p.status}.`);
    p.status = 'rejected';
    this.recordDecision(p);
    return p;
  }

  private recordDecision(p: Proposal): void {
    const L = this.deps.learning;
    const rec = L?.changes.get(p.id);
    if (!L || !rec) return;
    const now = this.now();
    rec.status = p.status;
    rec.decidedAt = now;
    rec.resultMessage = p.resultMessage;
    rec.proposal = p;
    if (p.status === 'approved') {
      // What was actually saved (re-merged onto the current version), for fair scoring later.
      if (rec.actionType === 'update_strategy' && rec.strategyId) rec.after = this.deps.host.get(rec.strategyId) ?? rec.after;
      if (rec.actionType === 'create_strategy' && rec.strategyId) rec.after = this.deps.host.get(rec.strategyId) ?? rec.after;
      if (rec.strategyId && L.demoStats && rec.actionType !== 'create_strategy') {
        try {
          rec.demoBefore = L.demoStats(rec.strategyId, now - 7 * DAY, now);
        } catch {
          /* demo stats are best-effort */
        }
      }
      rec.score = rec.actionType === 'start_bot' ? 'n/a' : 'pending';
    } else {
      rec.score = 'n/a';
    }
    L.changes.put(rec);
  }

  private mustGet(id: string): Proposal {
    const p = this.proposals.get(id);
    if (p) return p;
    const rec = this.deps.learning?.changes.get(id);
    if (rec && rec.status !== 'pending') throw new Error(`This proposal was already ${rec.status}.`);
    const stored = rec?.proposal;
    if (stored) {
      this.proposals.set(id, stored);
      return stored;
    }
    throw new Error('Proposal not found (the server may have restarted). Ask the agent again.');
  }

  private prune(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [id, p] of this.proposals) if (p.createdAt < cutoff) this.proposals.delete(id);
    while (this.proposals.size > MAX_KEPT) this.proposals.delete(this.proposals.keys().next().value as string);
  }
}
