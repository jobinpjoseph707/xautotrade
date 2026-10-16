/**
 * Auto-evolve: OFF by default, explicit opt-in per strategy.
 *
 * On a schedule, the Optimizer proposes ONE variant of each opted-in strategy.
 * Variants must pass the unseen-data check and may never loosen risk. Passing
 * variants are then shadow-tested forward: at the end of the test period both
 * the original and the variant are backtested on the bars that formed during
 * it (the same execution model as a paper bot, and nothing trades). Winners
 * wait for the user to promote them with one tap. Nothing is applied
 * automatically.
 */
import { randomUUID } from 'node:crypto';

import { gateViolation } from './propose.js';
import { extractActions, prepareProposals, describeChanges } from '../chat/actions.js';
import { agentModel, getAgent } from '../chat/agents.js';
import { modelLabel, type ChatBackend } from '../chat/backend.js';
import { buildPrompt } from '../chat/prompt.js';
import { validateStrategy } from '../engine/rules.js';
import type { Strategy } from '../engine/types.js';
import type { Lab } from './lab.js';
import { describeDisproof, type Disproof, type Theory } from './hypothesis.js';
import { marketState, settingOf } from './ledger.js';
import { heldSettings, retrieve } from './retrieve.js';
import type { RecordStore } from './records.js';
import { changeSignatures } from './signature.js';
import { openChange, type SurvivedTrial, type Trial } from './trials.js';
import { DEFAULT_EVOLVE, type ChangeRecord, type EvolveCandidate, type EvolveSettings, type MarketSnapshot, type Rationale, type Validation } from './types.js';
import { scoreForward } from './validate.js';

const DAY = 86_400_000;
const MAX_PER_CYCLE = 3;
/** What an auto-evolve variant must not do on unseen bars: lose money. */
export const EVOLVE_DISPROOF: Disproof = { metric: 'profitFactor', op: '<', value: 1 };
const EVIDENCE_DAYS = 14;

export interface EvolveHost {
  list(): Strategy[];
  get(id: string): Strategy | null;
  save(s: Strategy): Strategy;
  reload(s: Strategy): void;
}

export interface EvolveDeps {
  backend: ChatBackend;
  host: EvolveHost;
  lab: Lab;
  candidates: RecordStore<EvolveCandidate>;
  changes: RecordStore<ChangeRecord>;
  getSettings(): EvolveSettings;
  setSettings(s: EvolveSettings): void;
  notes?(agent: string): string[];
  /** The strategy's market right now (for matching lessons). */
  market?(s: Strategy): Promise<MarketSnapshot | null>;
  /** The one test every theory goes through (learning/trials.ts). When set, a variant must survive it. */
  trial?(theory: Theory, parent: Strategy): Promise<Trial | SurvivedTrial>;
  tier?(strategyId: string): string;
  log?(message: string): void;
  now?(): number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function mergeChanges(current: Strategy, changes: Record<string, unknown>): Strategy {
  return { ...current, ...changes, id: current.id, risk: { ...current.risk, ...(isObj(changes.risk) ? changes.risk : {}) } } as Strategy;
}

export class Evolver {
  constructor(private readonly d: EvolveDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  settings(): EvolveSettings {
    return { ...DEFAULT_EVOLVE, ...this.d.getSettings() };
  }

  updateSettings(patch: Partial<EvolveSettings>): EvolveSettings {
    const cur = this.settings();
    const next: EvolveSettings = {
      ...cur,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      strategyIds: Array.isArray(patch.strategyIds) ? patch.strategyIds.filter((x) => typeof x === 'string').slice(0, 10) : cur.strategyIds,
      intervalHours: typeof patch.intervalHours === 'number' && patch.intervalHours >= 24 ? patch.intervalHours : cur.intervalHours,
      testDays: typeof patch.testDays === 'number' && patch.testDays >= 3 && patch.testDays <= 30 ? patch.testDays : cur.testDays,
    };
    this.d.setSettings(next);
    return next;
  }

  isDue(): boolean {
    const s = this.settings();
    return s.enabled && s.strategyIds.length > 0 && (s.lastRunAt == null || this.now() - s.lastRunAt >= s.intervalHours * 3_600_000);
  }

  list(): EvolveCandidate[] {
    return this.d.candidates.all(200);
  }

  /** Make one variant per opted-in strategy. `force` runs even when disabled/not due (the "Run now" button). */
  async runCycle(force = false): Promise<{ created: EvolveCandidate[]; skipped: string[] }> {
    const s = this.settings();
    const created: EvolveCandidate[] = [];
    const skipped: string[] = [];
    if (!force && !this.isDue()) return { created, skipped: ['Auto-evolve is off or not due yet.'] };
    const optimizer = getAgent('optimizer')!;
    const model = agentModel(optimizer);
    const label = modelLabel(this.d.backend, model);
    const testing = new Set(this.list().filter((c) => c.status === 'testing').map((c) => c.parentId));
    const history = this.d.changes.all(500);

    for (const id of s.strategyIds.slice(0, MAX_PER_CYCLE)) {
      const parent = this.d.host.get(id);
      if (!parent) { skipped.push(`${id}: strategy no longer exists.`); continue; }
      if (testing.has(id)) { skipped.push(`${parent.name}: a variant is already being tested.`); continue; }
      if (openChange(history, id)) { skipped.push(`${parent.name}: a change is already waiting (in the Inbox, or to be scored). One at a time.`); continue; }

      let snap: MarketSnapshot | null = null;
      try {
        snap = (await this.d.market?.(parent)) ?? null;
      } catch {
        snap = null;
      }
      const got = retrieve(history, { agent: 'optimizer', symbol: parent.symbol, timeframe: parent.timeframe, market: snap }, this.now());
      const prompt = buildPrompt({
        agent: optimizer,
        message:
          `AUTO-EVOLVE MODE (the user is not present). Propose exactly ONE update_strategy for strategy id "${id}" ("${parent.name}"). ` +
          'Change one or two parameters at most, with a clear reason. Do NOT loosen any risk limit (no bigger lots, higher risk %, higher daily caps or wider spread caps). ' +
          'It will be shadow-tested for a week and only kept if it beats the original on data you have not seen.',
        history: [],
        strategies: [parent],
        bots: [],
        issues: [],
        notes: this.d.notes?.('optimizer') ?? [],
        lessons: got.rows,
      });
      let text: string;
      try {
        text = await this.d.backend.complete(prompt, { model, tag: 'evolve', unattended: !force });
      } catch (err) {
        skipped.push(`${parent.name}: agent error — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const { raw } = extractActions(text);
      const { proposals, rejected } = prepareProposals(raw, optimizer, this.d.host, () => randomUUID(), () => this.now());
      const p = proposals.find((x) => x.action.type === 'update_strategy' && x.action.id === id);
      if (!p || p.action.type !== 'update_strategy') {
        skipped.push(`${parent.name}: no usable variant (${rejected.map((r) => r.reason).join('; ') || 'none proposed'}).`);
        continue;
      }
      const variant = p.action.merged;
      const loosens = gateViolation(parent.risk, variant.risk);
      if (loosens) { skipped.push(`${parent.name}: variant rejected — it ${loosens}.`); continue; }

      const held = heldSettings(got);
      const hit = [...new Set(changeSignatures('update_strategy', parent, variant).map(settingOf))].filter((x) => held.has(x));
      if (hit.length) { skipped.push(`${parent.name}: variant dropped — past results disagree about ${hit.join(', ')} in this market.`); continue; }

      let validation: Validation;
      let market: MarketSnapshot | undefined;
      let rationale: Rationale | undefined;
      if (this.d.trial) {
        // Same test as every agent-service theory: unseen bars that cannot overlap the evidence, and a stated disproof.
        const st = marketState(snap);
        const theory: Theory = {
          id: p.id, strategyId: id, agent: 'optimizer', claim: p.reason ?? p.summary, changes: p.action.changes, disproof: EVOLVE_DISPROOF,
          checklist: {
            market: parent.symbol, timeframe: parent.timeframe, marketState: st ? `volatility ${st.volatility}, trend ${st.trend}, spread ${st.spread}` : 'unknown',
            tier: this.d.tier?.(id) ?? 'unknown', evidence: 'An auto-evolve variant: the optimizer saw this strategy\'s recent backtest.',
            change: describeChanges(parent, variant).join('; '), wouldProveWrong: describeDisproof(EVOLVE_DISPROOF),
          },
          formedOn: { from: this.now() - EVIDENCE_DAYS * DAY, to: this.now() }, lessonsUsed: got.rows,
        };
        const t = await this.d.trial(theory, parent);
        market = t.market;
        validation = t.validation ?? { verdict: 'error', reasons: t.reasons };
        if (t.status !== 'survived') validation = { ...validation, verdict: validation.verdict === 'pass' ? 'fail' : validation.verdict, reasons: [...t.reasons] };
        rationale = { trialId: t.id, claim: theory.claim, checklist: theory.checklist, disproof: describeDisproof(EVOLVE_DISPROOF), lessonsUsed: got.rows };
      } else {
        ({ validation, market } = await this.d.lab.validate(parent, variant, false));
      }
      const rec: ChangeRecord = {
        id: p.id, createdAt: this.now(), source: 'evolve', agent: 'optimizer', model: label, actionType: 'update_strategy',
        strategyId: id, symbol: parent.symbol, timeframe: parent.timeframe, summary: `[auto-evolve] ${p.summary}`, reason: p.reason,
        signatures: changeSignatures('update_strategy', parent, variant), before: parent, after: variant, changes: p.action.changes,
        market, validation, warnings: p.warnings, status: 'pending', score: 'n/a', scoreReasons: [], rationale,
      };
      if (validation.verdict !== 'pass') {
        rec.status = 'blocked';
        rec.decidedAt = this.now();
        this.d.changes.put(rec);
        skipped.push(`${parent.name}: variant held back — ${validation.reasons.join(' ')}`);
        continue;
      }
      // Tracked as a candidate; a ChangeRecord is written only when promoted.
      const c: EvolveCandidate = {
        id: p.id, createdAt: this.now(), parentId: id, parentName: parent.name, baseline: parent, variant,
        changes: p.action.changes, summary: p.summary, reason: p.reason, model: label, validation, status: 'testing', verdictReasons: [], rationale,
      };
      this.d.candidates.put(c);
      created.push(c);
      this.d.log?.(`Auto-evolve: testing a variant of "${parent.name}" — ${p.summary}`);
    }
    this.d.setSettings({ ...this.settings(), lastRunAt: this.now() });
    return { created, skipped };
  }

  /** Judge candidates whose shadow test period is over. */
  async evaluate(): Promise<EvolveCandidate[]> {
    const s = this.settings();
    const done: EvolveCandidate[] = [];
    for (const c of this.list().filter((x) => x.status === 'testing')) {
      const age = this.now() - c.createdAt;
      if (age < s.testDays * DAY) continue;
      const fwd = await this.d.lab.forward(c.baseline, c.variant, c.createdAt);
      const res = scoreForward('update_strategy', fwd, this.d.lab.minTrades, age >= s.testDays * 3 * DAY);
      c.forward = fwd ?? undefined;
      c.verdictReasons = res.reasons;
      if (!res.wait) {
        c.status = res.score === 'helped' ? 'winner' : res.score === 'hurt' ? 'loser' : 'inconclusive';
        c.evaluatedAt = this.now();
        done.push(c);
        this.d.log?.(`Auto-evolve: variant of "${c.parentName}" finished testing — ${c.status}.`);
      }
      this.d.candidates.put(c);
    }
    return done;
  }

  /** One tap: apply a finished variant's changes onto the CURRENT parent. */
  promote(id: string): { candidate: EvolveCandidate; strategy: Strategy } {
    const c = this.d.candidates.get(id);
    if (!c) throw new Error('Variant not found.');
    if (c.status !== 'winner' && c.status !== 'inconclusive') throw new Error(`Only finished variants can be promoted (this one is ${c.status}).`);
    const current = this.d.host.get(c.parentId);
    if (!current) throw new Error('The original strategy no longer exists.');
    const merged = mergeChanges(current, c.changes);
    const errs = validateStrategy(merged);
    if (errs.length) throw new Error(errs.join(' '));
    const loosens = gateViolation(current.risk, merged.risk);
    if (loosens) throw new Error(`Refused: this ${loosens}.`);
    const saved = this.d.host.save(merged);
    this.d.host.reload(saved);
    const now = this.now();
    this.d.changes.put({
      id: `evo_${c.id}`, createdAt: now, source: 'evolve', agent: 'optimizer', model: c.model, actionType: 'update_strategy',
      strategyId: c.parentId, symbol: saved.symbol, timeframe: saved.timeframe,
      summary: `[auto-evolve] Update "${current.name}": ${describeChanges(current, saved).join('; ')}`, reason: c.reason,
      signatures: changeSignatures('update_strategy', current, saved), before: current, after: saved, changes: c.changes,
      validation: c.validation, warnings: [], status: 'approved', decidedAt: now, score: 'pending', scoreReasons: [], rationale: c.rationale,
    });
    c.status = 'promoted';
    this.d.candidates.put(c);
    return { candidate: c, strategy: saved };
  }

  dismiss(id: string): EvolveCandidate {
    const c = this.d.candidates.get(id);
    if (!c) throw new Error('Variant not found.');
    if (c.status === 'promoted') throw new Error('Already promoted.');
    c.status = 'dismissed';
    this.d.candidates.put(c);
    return c;
  }
}
