/**
 * Safety moves: the only code allowed to change a strategy without the owner's approval.
 *
 * It accepts exactly two things:
 *   - pause a bot, or
 *   - tighten a short list of risk limits (see TIGHTENING), where every field in the change is
 *     strictly tighter AND `gateViolation()` (the same check proposals must pass) agrees.
 * Anything else throws SafetyMoveRefused and nothing is saved. Unknown means no.
 *
 * Every accepted move writes a trace (the logs table) and an Inbox card with OK and Undo.
 * A bot paused here stays paused until the owner restarts it. There is no HTTP route to this
 * module: only code running inside the server can call it.
 */
import { gateViolation } from '../learning/propose.js';
import type { Inbox } from '../inbox/inbox.js';
import type { RiskConfig, Strategy } from '../engine/types.js';

export class SafetyMoveRefused extends Error {}

/** Which way is "tighter" for each field the safety code may touch. `zeroOff` = 0 means unlimited. */
export const TIGHTENING = {
  fixedLot: { label: 'lot size', direction: 'down', zeroOff: false },
  riskPercent: { label: 'risk per trade (%)', direction: 'down', zeroOff: false },
  maxDailyTrades: { label: 'trades per day', direction: 'down', zeroOff: true },
  maxDailyLossPercent: { label: 'daily loss limit (%)', direction: 'down', zeroOff: true },
  maxSpreadPoints: { label: 'max spread (points)', direction: 'down', zeroOff: true },
  cooldownBars: { label: 'bars between trades', direction: 'up', zeroOff: false },
  minRewardRisk: { label: 'minimum reward:risk', direction: 'up', zeroOff: false },
} as const;
export type TightenField = keyof typeof TIGHTENING;
export type RiskChange = Partial<Record<TightenField, number>>;

export type SafetyMove =
  | { kind: 'pause'; strategyId: string; reason: string }
  | { kind: 'tighten'; strategyId: string; change: RiskChange; reason: string };

/** What an Inbox card keeps so Undo knows what to put back. */
export type UndoData =
  | { move: 'pause'; strategyId: string; wasRunning: boolean }
  | { move: 'tighten'; strategyId: string; before: RiskChange; after: RiskChange };

export interface SafetyDeps {
  strategies: { get(id: string): Strategy | null; save(s: Strategy): Strategy };
  inbox: Inbox;
  /** The permanent record (the logs table in the app). */
  trace(entry: { ts: number; strategyId: string; event: string; message: string; data: unknown }): void;
  /** Stop the bot if it is running. Must also switch off its autostart. */
  stopBot(strategyId: string): void;
  isRunning(strategyId: string): boolean;
  /** Push a changed config into a running bot. */
  reload?(s: Strategy): void;
  /** Start a bot (Undo of a pause that stopped a running bot). */
  startBot?(strategyId: string): Promise<unknown>;
  clock?: () => number;
}

export interface SafetyResult {
  applied: boolean;
  message: string;
}

const isField = (k: string): k is TightenField => Object.hasOwn(TIGHTENING, k);

/** Strictly tighter, for one field. */
function strictlyTighter(field: TightenField, before: number, after: number): boolean {
  const t = TIGHTENING[field];
  if (t.zeroOff) {
    if (before <= 0) return after > 0; // was unlimited: any limit is tighter
    return after > 0 && after < before; // 0 would switch the limit off
  }
  return t.direction === 'down' ? after > 0 && after < before : after > before;
}

/** The single place a safety move reaches the strategy store. */
function persist(deps: SafetyDeps, s: Strategy): Strategy {
  const saved = deps.strategies.save(s);
  deps.reload?.(saved);
  return saved;
}

function refuse(why: string): never {
  throw new SafetyMoveRefused(`Safety move refused: ${why}`);
}

const fmt = (n: number): string => String(Number(n.toFixed(4)));

export function applySafetyMove(move: SafetyMove, deps: SafetyDeps): SafetyResult {
  const now = (deps.clock ?? Date.now)();
  const m = move as { kind?: unknown; strategyId?: unknown; reason?: unknown; change?: unknown };
  if (m.kind !== 'pause' && m.kind !== 'tighten') refuse(`"${String(m.kind)}" is not a move the safety code may make`);
  if (typeof m.strategyId !== 'string' || !m.strategyId) refuse('no strategy given');
  if (typeof m.reason !== 'string' || !m.reason.trim()) refuse('a reason is required, so the Inbox card can say why');
  const s = deps.strategies.get(m.strategyId);
  if (!s) refuse(`strategy ${m.strategyId} not found`);

  if (m.kind === 'pause') {
    if (s.pausedBy) return { applied: false, message: `"${s.name}" is already paused.` };
    const wasRunning = deps.isRunning(s.id);
    deps.stopBot(s.id);
    persist(deps, { ...s, pausedBy: 'safety' });
    const message = `Paused "${s.name}". ${m.reason}`;
    deps.trace({ ts: now, strategyId: s.id, event: 'safety_move', message, data: { move: 'pause', reason: m.reason, wasRunning } });
    deps.inbox.raise({
      kind: 'safety_action',
      severity: 'warn',
      strategyId: s.id,
      dedupeKey: `safety-move:pause:${s.id}`,
      title: `"${s.name}" was paused by a safety check`,
      body: `${m.reason} It stays paused until you restart it. Press Undo to put it back as it was.`,
      undoable: true,
      data: { move: 'pause', strategyId: s.id, wasRunning } satisfies UndoData,
    });
    return { applied: true, message };
  }

  // --- tighten ---------------------------------------------------------------
  const change = m.change;
  if (typeof change !== 'object' || change === null || Array.isArray(change)) refuse('no change given');
  const entries = Object.entries(change as Record<string, unknown>);
  if (entries.length === 0) refuse('the change is empty');

  const before: RiskChange = {};
  const after: RiskChange = {};
  for (const [key, value] of entries) {
    if (!isField(key)) refuse(`"${key}" is not a limit the safety code may change`);
    if (typeof value !== 'number' || !Number.isFinite(value)) refuse(`${key} must be a number`);
    const was = s.risk[key];
    if (!strictlyTighter(key, was, value)) {
      refuse(`${TIGHTENING[key].label} ${fmt(was)} → ${fmt(value)} is not strictly tighter`);
    }
    if (key === 'fixedLot' && value < s.risk.minLot) refuse(`lot size ${fmt(value)} is below the minimum lot ${fmt(s.risk.minLot)}`);
    before[key] = was;
    after[key] = value;
  }

  // Belt and braces: the same check every proposal passes must agree.
  const nextRisk: RiskConfig = { ...s.risk, ...after };
  const violation = gateViolation(s.risk, nextRisk);
  if (violation) refuse(`it ${violation}`);

  persist(deps, { ...s, risk: nextRisk });
  const parts = (Object.keys(after) as TightenField[]).map((k) => `${TIGHTENING[k].label} ${fmt(before[k]!)} → ${fmt(after[k]!)}`);
  const message = `Tightened "${s.name}": ${parts.join(', ')}. ${m.reason}`;
  deps.trace({ ts: now, strategyId: s.id, event: 'safety_move', message, data: { move: 'tighten', reason: m.reason, before, after } });
  deps.inbox.raise({
    kind: 'safety_action',
    severity: 'info',
    strategyId: s.id,
    title: `"${s.name}" was made safer: ${parts.join(', ')}`,
    body: `${m.reason} Press OK to keep it, or Undo to put the old limits back.`,
    undoable: true,
    data: { move: 'tighten', strategyId: s.id, before, after } satisfies UndoData,
  });
  return { applied: true, message };
}

/**
 * The Undo button. It is the owner's decision, so it may loosen what a safety move tightened,
 * but only if the limits still hold the values the safety move set (nobody edited them since).
 */
export async function undoSafetyMove(strategyId: string, raw: unknown, deps: SafetyDeps): Promise<SafetyResult> {
  const data = raw as Partial<UndoData> | null;
  if (!data || typeof data !== 'object' || data.strategyId !== strategyId) {
    throw new SafetyMoveRefused('This card has nothing to undo.');
  }
  const s = deps.strategies.get(strategyId);
  if (!s) throw new SafetyMoveRefused('That strategy no longer exists.');
  const now = (deps.clock ?? Date.now)();

  if (data.move === 'pause') {
    if (s.pausedBy !== 'safety') return { applied: false, message: 'The bot is no longer paused by safety, so there is nothing to undo.' };
    const { pausedBy: _gone, ...rest } = s;
    persist(deps, rest);
    if (data.wasRunning && deps.startBot) await deps.startBot(strategyId);
    const message = `Undid the safety pause on "${s.name}"${data.wasRunning ? ' and started it again' : ''}.`;
    deps.trace({ ts: now, strategyId, event: 'safety_move_undone', message, data });
    return { applied: true, message };
  }

  if (data.move === 'tighten') {
    const { before, after } = data;
    if (!before || !after) throw new SafetyMoveRefused('This card has nothing to undo.');
    const risk: RiskConfig = { ...s.risk };
    for (const key of Object.keys(after)) {
      if (!isField(key) || typeof before[key] !== 'number') throw new SafetyMoveRefused('This card has nothing to undo.');
      if (s.risk[key] !== after[key]) {
        return { applied: false, message: `${TIGHTENING[key].label} was changed after the safety move, so nothing was undone.` };
      }
      risk[key] = before[key]!;
    }
    persist(deps, { ...s, risk });
    const message = `Put the old limits back on "${s.name}".`;
    deps.trace({ ts: now, strategyId, event: 'safety_move_undone', message, data });
    return { applied: true, message };
  }

  throw new SafetyMoveRefused('This card has nothing to undo.');
}
