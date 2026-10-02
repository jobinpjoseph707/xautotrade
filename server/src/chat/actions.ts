/**
 * Parsing, validating and applying agent-proposed actions.
 * Pure of storage: the host (store + bot manager) is injected, so this is testable.
 */
import { gateViolation } from '../agents/propose.js';
import { validateStrategy } from '../engine/rules.js';
import { DEFAULT_RISK, TIMEFRAME_MS, type RiskConfig, type Strategy } from '../engine/types.js';
import { SUPPORTED_INDICATORS } from '../youtube/map.js';
import type { CriticVerdict, Validation } from '../learning/types.js';
import type { ActionType, AgentDef } from './agents.js';

export type ChatAction =
  | { type: 'create_strategy'; strategy: Strategy }
  | { type: 'update_strategy'; id: string; merged: Strategy; changes: Record<string, unknown> }
  | { type: 'delete_strategy'; id: string }
  | { type: 'start_bot'; id: string }
  | { type: 'stop_bot'; id: string };

export interface Proposal {
  id: string;
  agent: string;
  /** Which model produced it (see modelLabel). */
  model?: string;
  /** Out-of-sample check result (updates and new strategies). */
  validation?: Validation;
  /** The critic agent's verdict. */
  critic?: CriticVerdict;
  action: ChatAction;
  /** One line the user reads before approving. */
  summary: string;
  reason?: string;
  warnings: string[];
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  createdAt: number;
  resultMessage?: string;
}

export interface Rejected {
  reason: string;
  raw: unknown;
}

export interface ReadHost {
  get(id: string): Strategy | null;
}

export interface ApplyHost extends ReadHost {
  save(s: Strategy): Strategy;
  remove(id: string): void;
  reload(s: Strategy): void;
  start(id: string): Promise<unknown>;
  stop(id: string): unknown;
}

const BLOCK = /```xat-actions\s*([\s\S]*?)```/g;

/** Split the model's text into the human reply and its (unvalidated) action list. */
export function extractActions(text: string): { reply: string; raw: unknown[]; parseError?: string } {
  const raw: unknown[] = [];
  let parseError: string | undefined;
  for (const m of text.matchAll(BLOCK)) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) raw.push(...parsed);
      else raw.push(parsed);
    } catch (err) {
      parseError = `Could not read the proposed actions (${(err as Error).message}).`;
    }
  }
  return { reply: text.replace(BLOCK, '').trim(), raw, parseError };
}

const UPDATABLE = ['name', 'symbol', 'timeframe', 'indicators', 'entryLong', 'entryShort', 'exitLong', 'exitShort', 'risk', 'showLevels', 'levelsMinutes', 'showOverlays'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkShape(s: Strategy): string[] {
  const errs: string[] = [];
  if (!s.name || typeof s.name !== 'string') errs.push('Missing strategy name.');
  if (!s.symbol || typeof s.symbol !== 'string') errs.push('Missing symbol.');
  if (!(s.timeframe in TIMEFRAME_MS)) errs.push(`Unknown timeframe "${s.timeframe}".`);
  if (!Array.isArray(s.indicators)) errs.push('indicators must be a list.');
  else {
    for (const i of s.indicators) {
      if (!i || !(SUPPORTED_INDICATORS as readonly string[]).includes(i.type)) errs.push(`Unsupported indicator type "${i?.type}".`);
      if (!i?.id) errs.push('An indicator is missing its id.');
    }
  }
  for (const k of ['entryLong', 'entryShort'] as const) {
    const g = s[k];
    if (!g || !Array.isArray(g.conditions) || (g.logic !== 'AND' && g.logic !== 'OR')) errs.push(`${k} must be {logic, conditions[]}.`);
  }
  const numericRisk: (keyof RiskConfig)[] = ['fixedLot', 'riskPercent', 'slPoints', 'tpPoints', 'maxDailyLossPercent', 'maxDailyTrades', 'maxSpreadPoints'];
  for (const k of numericRisk) {
    const v = s.risk?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errs.push(`risk.${String(k)} must be a non-negative number.`);
  }
  return errs;
}

function riskWarnings(s: Strategy): string[] {
  const w: string[] = [];
  if (s.risk.lotMode === 'fixed' && s.risk.fixedLot > 0.1) w.push(`Lot size ${s.risk.fixedLot} is above 0.1 — large for a test.`);
  if (s.risk.lotMode === 'percentRisk' && s.risk.riskPercent > 2) w.push(`Risk per trade ${s.risk.riskPercent}% is above 2%.`);
  if (s.risk.slMode === 'none') w.push('No stop-loss.');
  if (s.risk.maxDailyLossPercent <= 0) w.push('Daily loss cap is off.');
  return w;
}

function fmt(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/** Human-readable diff of an update, one line per changed field (max 8). */
export function describeChanges(before: Strategy, after: Strategy): string[] {
  const lines: string[] = [];
  for (const k of UPDATABLE) {
    const a = (before as unknown as Record<string, unknown>)[k];
    const b = (after as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (k === 'risk' && isObj(a) && isObj(b)) {
      for (const rk of Object.keys(b)) {
        if (JSON.stringify(a[rk]) !== JSON.stringify(b[rk])) lines.push(`risk.${rk}: ${fmt(a[rk])} → ${fmt(b[rk])}`);
      }
    } else if (typeof a !== 'object') {
      lines.push(`${k}: ${fmt(a)} → ${fmt(b)}`);
    } else {
      lines.push(`${k} changed`);
    }
  }
  return lines.slice(0, 8);
}

export function prepareProposals(
  raw: unknown[],
  agent: AgentDef,
  host: ReadHost,
  newId: () => string,
  now: () => number = Date.now,
): { proposals: Proposal[]; rejected: Rejected[] } {
  const proposals: Proposal[] = [];
  const rejected: Rejected[] = [];

  for (const item of raw) {
    const reject = (reason: string) => rejected.push({ reason, raw: item });
    if (!isObj(item) || typeof item.type !== 'string') {
      reject('Not a valid action.');
      continue;
    }
    const type = item.type as ActionType;
    if (!agent.allowed.includes(type)) {
      reject(`${agent.name} is not allowed to ${type.replace('_', ' ')}.`);
      continue;
    }
    const reason = typeof item.reason === 'string' ? item.reason : undefined;
    const base = { id: newId(), agent: agent.id, reason, warnings: [] as string[], status: 'pending' as const, createdAt: now() };

    if (type === 'create_strategy') {
      const src = item.strategy;
      if (!isObj(src)) { reject('create_strategy needs a strategy object.'); continue; }
      const strategy = {
        ...(src as unknown as Strategy),
        id: `str_${newId().slice(0, 8)}`,
        risk: { ...DEFAULT_RISK, ...(isObj(src.risk) ? src.risk : {}) },
      } as Strategy;
      const errs = [...checkShape(strategy), ...validateStrategy(strategy)];
      if (errs.length) { reject(`Invalid strategy: ${errs.join(' ')}`); continue; }
      proposals.push({ ...base, action: { type, strategy }, summary: `Create "${strategy.name}" — ${strategy.symbol} ${strategy.timeframe}`, warnings: riskWarnings(strategy) });
    } else if (type === 'update_strategy') {
      const id = String(item.id ?? '');
      const existing = host.get(id);
      if (!existing) { reject(`No strategy with id ${id}.`); continue; }
      if (!isObj(item.changes)) { reject('update_strategy needs a changes object.'); continue; }
      const bad = Object.keys(item.changes).filter((k) => !UPDATABLE.includes(k));
      if (bad.length) { reject(`Cannot change: ${bad.join(', ')}.`); continue; }
      const c = item.changes as Record<string, unknown>;
      const merged = { ...existing, ...c, id, risk: { ...existing.risk, ...(isObj(c.risk) ? c.risk : {}) } } as Strategy;
      const errs = [...checkShape(merged), ...validateStrategy(merged)];
      if (errs.length) { reject(`Invalid change: ${errs.join(' ')}`); continue; }
      const lines = describeChanges(existing, merged);
      if (lines.length === 0) { reject('That change would not alter anything.'); continue; }
      const warnings = riskWarnings(merged);
      const violation = gateViolation(existing.risk, merged.risk);
      if (violation) {
        if (agent.tightenOnly) { reject(`Risk Guard may only tighten risk, but this ${violation}.`); continue; }
        warnings.push(`This loosens a risk limit (${violation}).`);
      }
      proposals.push({ ...base, action: { type, id, merged, changes: c }, summary: `Update "${existing.name}": ${lines.join('; ')}`, warnings });
    } else {
      const id = String(item.id ?? '');
      const existing = host.get(id);
      if (!existing) { reject(`No strategy with id ${id}.`); continue; }
      const verb = { delete_strategy: 'Delete', start_bot: 'Start bot for', stop_bot: 'Stop bot for' }[type as 'delete_strategy' | 'start_bot' | 'stop_bot'];
      proposals.push({
        ...base,
        action: { type, id } as ChatAction,
        summary: `${verb} "${existing.name}" (${existing.symbol} ${existing.timeframe})`,
        warnings: type === 'delete_strategy' ? ['Deleting also removes its saved backtests. Open positions are not closed.'] : [],
      });
    }
  }
  return { proposals, rejected };
}

/** Carry out an approved proposal. Throws with a readable message on failure. */
export async function applyProposal(p: Proposal, host: ApplyHost): Promise<string> {
  const a = p.action;
  switch (a.type) {
    case 'create_strategy': {
      const saved = host.save(a.strategy);
      return `Created "${saved.name}". Backtest it before starting a bot.`;
    }
    case 'update_strategy': {
      const current = host.get(a.id);
      if (!current) throw new Error('That strategy no longer exists.');
      // Re-merge onto the CURRENT version so edits made since the proposal are not lost.
      const merged = { ...current, ...a.changes, id: a.id, risk: { ...current.risk, ...(isObj(a.changes.risk) ? a.changes.risk : {}) } } as Strategy;
      const errs = validateStrategy(merged);
      if (errs.length) throw new Error(errs.join(' '));
      const saved = host.save(merged);
      host.reload(saved);
      return `Updated "${saved.name}". A running bot picks it up on its next bar.`;
    }
    case 'delete_strategy': {
      const s = host.get(a.id);
      host.remove(a.id);
      return `Deleted "${s?.name ?? a.id}".`;
    }
    case 'start_bot':
      await host.start(a.id);
      return 'Bot started.';
    case 'stop_bot':
      host.stop(a.id);
      return 'Bot stopped. Open positions were left untouched.';
  }
}
