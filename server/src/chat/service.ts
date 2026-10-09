import { randomUUID } from 'node:crypto';

import type { Strategy } from '../engine/types.js';
import { critique, type CriticInput } from '../learning/critic.js';
import { buildNotebook, notebookLines } from '../learning/notebook.js';
import type { RecordStore } from '../learning/records.js';
import { changeSignatures } from '../learning/signature.js';
import type { ChangeRecord, DemoStats, MarketSnapshot, Validation } from '../learning/types.js';
import { applyProposal, describeChanges, extractActions, extractWhatIf, prepareProposals, type ApplyHost, type Proposal } from './actions.js';
import { AGENTS, BUTTON_MESSAGE, CHAT_BUTTONS, FALLBACK_AGENT, agentModel, getAgent, isChatButton, parseRouterAnswer, routerPrompt, type AgentDef, type AgentId } from './agents.js';
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
  /** Mirrors proposals into the Inbox. Optional so the chat works without one. */
  inbox?: { proposalCreated(p: Proposal): void; proposalDecided(p: Proposal): void };
  /** Cheap model that picks an agent for free text (default env CHAT_ROUTER_MODEL, else "haiku"). */
  routerModel?: string;
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
const MAX_TURNS = 20;
const TTL_MS = 24 * 3_600_000;
const DAY = 86_400_000;

function outcomeLine(r: ChangeRecord): string {
  const d = new Date(r.decidedAt ?? r.createdAt).toISOString().slice(0, 10);
  const why = r.score === 'pending' ? 'not scored yet' : `${r.score.toUpperCase()}${r.scoreReasons.length ? ` — ${r.scoreReasons[r.scoreReasons.length - 1]}` : ''}`;
  return `${d} ${r.agent}: ${r.summary.slice(0, 160)} → ${why}`;
}

const n1 = (v: number | undefined, suffix = '') => (v === undefined || Number.isNaN(v) ? 'n/a' : `${v}${suffix}`);

/** One readable line comparing the two backtests. */
export function whatIfLine(b: BacktestInfo, a: BacktestInfo): string {
  if (b.error || a.error) return `What-if backtest failed: ${b.error ?? a.error}.`;
  return `What-if backtest, now → with this change: trades ${n1(b.trades)} → ${n1(a.trades)}, profit factor ${n1(b.profitFactor)} → ${n1(a.profitFactor)}, net ${n1(b.netProfitPct, '%')} → ${n1(a.netProfitPct, '%')}, max drawdown ${n1(b.maxDrawdownPct, '%')} → ${n1(a.maxDrawdownPct, '%')}.`;
}

export class ChatService {
  private proposals = new Map<string, Proposal>();
  /** One conversation per strategy, kept here so one strategy's chat can never leak into another's prompt. */
  private convos = new Map<string, ChatTurn[]>();

  constructor(private readonly deps: ChatDeps) {}

  private now(): number {
    return this.deps.learning?.now?.() ?? Date.now();
  }

  agents() {
    return AGENTS.map((a) => ({ id: a.id, name: a.name, tagline: a.tagline, model: modelLabel(this.deps.backend, agentModel(a)) }));
  }

  /** Pick the agent for a message: a button is a fixed choice, an agent id is taken as given, free text goes to the cheap router. */
  private async pick(input: { agent?: string; button?: string }, message: string, scoped: boolean, hasStrategies: boolean): Promise<string> {
    if (input.button !== undefined) {
      if (!isChatButton(input.button)) throw new Error(`Unknown button "${input.button}".`);
      return CHAT_BUTTONS[input.button];
    }
    if (input.agent && input.agent !== 'auto') return input.agent;
    if (!hasStrategies) return 'strategist';
    try {
      const answer = await this.deps.backend.complete(routerPrompt(message, scoped), {
        model: this.deps.routerModel ?? process.env.CHAT_ROUTER_MODEL ?? 'haiku',
        tag: 'router',
      });
      return parseRouterAnswer(answer, scoped) ?? FALLBACK_AGENT;
    } catch {
      return FALLBACK_AGENT;
    }
  }

  /** Forget one strategy's conversation (e.g. when it is deleted). */
  clearConversation(strategyId: string): void {
    this.convos.delete(strategyId);
  }

  async chat(input: { agent?: string; message?: string; history?: ChatTurn[]; strategyId?: string; button?: string }): Promise<ChatResult> {
    const focus = input.strategyId ? this.deps.host.get(input.strategyId) : null;
    if (input.strategyId && !focus) throw new Error('That strategy no longer exists.');
    if (input.button !== undefined && !isChatButton(input.button)) throw new Error(`Unknown button "${input.button}".`);
    const buttonText = isChatButton(input.button) ? BUTTON_MESSAGE[input.button] : '';
    const message = input.message?.trim() || buttonText;
    if (!message) throw new Error('Type a message first.');
    const strategies = focus ? [focus] : this.deps.host.list();
    const id = await this.pick(input, message, !!focus, strategies.length > 0);
    const agent = getAgent(id);
    if (!agent) throw new Error(`Unknown agent "${input.agent}".`);
    if (focus && agent.id === 'strategist') throw new Error('The Strategist creates new strategies. Ask it from the Agents tab.');
    const model = agentModel(agent);
    const label = modelLabel(this.deps.backend, model);

    // Every agent except the Strategist sees real backtest numbers for the strategies in scope.
    // (Results are cached for 10 minutes and capped, so asking twice does not run twice.)
    let backtests: BacktestInfo[] | undefined;
    if (this.deps.backtests && strategies.length && agent.id !== 'strategist') {
      backtests = await this.deps.backtests(strategies);
    }

    const history = this.deps.learning?.changes.all(500) ?? [];
    const notebook = this.deps.learning ? notebookLines(buildNotebook(agent.id, history, this.deps.learning.notes?.(agent.id) ?? [])) : undefined;
    const outcomes = history.filter((r) => r.status === 'approved' && (!focus || r.strategyId === focus.id)).slice(0, 8).map(outcomeLine);

    const prompt = buildPrompt({
      agent,
      message,
      history: focus ? (this.convos.get(focus.id) ?? []) : (input.history ?? []),
      strategies,
      bots: focus ? this.deps.bots().filter((b) => b.strategyId === focus.id) : this.deps.bots(),
      issues: focus ? this.deps.issues().filter((i) => i.strategyId === focus.id) : this.deps.issues(),
      focus: focus ?? undefined,
      backtests,
      notebook,
      outcomes,
    });
    const text = await this.deps.backend.complete(prompt, { model, tag: agent.id });

    const wi = extractWhatIf(text);
    const { reply, raw, parseError } = extractActions(wi.reply);
    const prepared = prepareProposals(raw, agent, this.deps.host, () => randomUUID(), () => this.now());
    const rejected = prepared.rejected.map((r) => r.reason);
    if (wi.error) rejected.push(wi.error);
    if (wi.extra) rejected.push(`Only one what-if is run per message; ${wi.extra} more ignored.`);
    if (wi.request) {
      if (focus && wi.request.id !== focus.id) rejected.push('This chat is about one strategy; the what-if named a different one.');
      else {
        const p = await this.whatIf(wi.request, agent, rejected);
        if (p) prepared.proposals.push(p);
      }
    }
    const proposals = await this.review(prepared.proposals, agent, label, rejected, history);

    if (focus) {
      const turns = [...(this.convos.get(focus.id) ?? []), { role: 'user' as const, text: message }, { role: 'agent' as const, text: reply || '(no reply)' }];
      this.convos.set(focus.id, turns.slice(-MAX_TURNS));
    }

    this.prune();
    for (const p of proposals) {
      this.proposals.set(p.id, p);
      this.deps.inbox?.proposalCreated(p);
    }

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
   * A strategy built outside the chat (a YouTube transcript, say) goes through the same checks and the
   * same Approve step as an agent's proposal: rule validation, the unseen-data check, the critic, the
   * Inbox card. Nothing is saved or started until the owner approves it.
   */
  async proposeStrategy(strategy: Strategy, info: { reason?: string; warnings?: string[]; label?: string }): Promise<{ proposal: Proposal | null; rejected: string[] }> {
    const agent = getAgent('strategist');
    if (!agent) throw new Error('The Strategist agent is missing.');
    const prepared = prepareProposals([{ type: 'create_strategy', strategy, reason: info.reason }], agent, this.deps.host, () => randomUUID(), () => this.now());
    const rejected = prepared.rejected.map((r) => r.reason);
    for (const p of prepared.proposals) p.warnings = [...(info.warnings ?? []), ...p.warnings];
    const history = this.deps.learning?.changes.all(500) ?? [];
    const proposals = await this.review(prepared.proposals, agent, info.label ?? 'Imported', rejected, history);
    this.prune();
    for (const p of proposals) {
      this.proposals.set(p.id, p);
      this.deps.inbox?.proposalCreated(p);
    }
    return { proposal: proposals[0] ?? null, rejected };
  }

  /**
   * Run the agent's "test this change first" request: build the update through the same checks as any
   * proposal (so every rule applies), then backtest the strategy as it is and with the change, in ONE call.
   */
  private async whatIf(req: { id: string; changes: Record<string, unknown>; reason?: string }, agent: AgentDef, rejected: string[]): Promise<Proposal | null> {
    const prepared = prepareProposals([{ type: 'update_strategy', id: req.id, changes: req.changes, reason: req.reason }], agent, this.deps.host, () => randomUUID(), () => this.now());
    for (const r of prepared.rejected) rejected.push(`What-if not run: ${r.reason}`);
    const p = prepared.proposals[0];
    if (!p || p.action.type !== 'update_strategy') return null;
    const before = this.deps.host.get(req.id)!;
    if (this.deps.backtests) {
      try {
        const [b, a] = await this.deps.backtests([before, { ...p.action.merged, id: `${before.id}~whatif` }]);
        p.whatIf = { before: { ...b, strategyId: before.id }, after: { ...a, strategyId: before.id } };
        p.reason = [p.reason, whatIfLine(p.whatIf.before, p.whatIf.after)].filter(Boolean).join(' ');
      } catch (err) {
        p.warnings = [...p.warnings, `The what-if backtest could not run: ${err instanceof Error ? err.message : String(err)}`];
      }
    } else {
      p.warnings = [...p.warnings, 'No backtest was available for this what-if.'];
    }
    return p;
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
      if (p.action.type === 'delete_strategy') this.convos.delete(p.action.id);
    } catch (err) {
      p.status = 'failed';
      p.resultMessage = err instanceof Error ? err.message : String(err);
    }
    this.recordDecision(p);
    this.deps.inbox?.proposalDecided(p);
    return p;
  }

  reject(id: string): Proposal {
    const p = this.mustGet(id);
    if (p.status !== 'pending') throw new Error(`This proposal was already ${p.status}.`);
    p.status = 'rejected';
    this.recordDecision(p);
    this.deps.inbox?.proposalDecided(p);
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
