/**
 * One-off clean-up of saved strategies (task 1.3). Pure logic: the store and the
 * backup are passed in, so the same code runs from the thin runner in
 * `server/scripts/cleanup.ts` and from tests.
 *
 * What it does, in order:
 *  1. flags every strategy with "(test)" in its name as `isTest`, so it no longer
 *     counts in Journal and Dashboard totals;
 *  2. clamps `risk.maxLot` down to the new default (0.5, or 0.2 on gold);
 *  3. deletes the two "M1 Gold Quick Scalp" copies that trade EURUSD and the
 *     "M1 HFT EMA Scalp" (its break-even sits inside gold's own spread).
 *
 * A dry run changes nothing. A real run writes a backup first and does nothing
 * at all if the backup fails. A second run finds nothing left to do.
 */
import { DEFAULT_RISK, type Strategy } from '../engine/types.js';

export const GOLD_MAX_LOT = 0.2;

export interface CleanupStore {
  list(): Strategy[];
  save(s: Strategy): unknown;
  remove(id: string): void;
}

export interface CleanupPlan {
  flagTest: { id: string; name: string }[];
  clampLot: { id: string; name: string; from: number; to: number }[];
  remove: { id: string; name: string; reason: string }[];
}

export interface CleanupResult {
  plan: CleanupPlan;
  applied: boolean;
  backupPath?: string;
  lines: string[];
}

export const maxLotFor = (symbol: string): number => (symbol.toUpperCase().startsWith('XAU') ? GOLD_MAX_LOT : DEFAULT_RISK.maxLot);

/** Why this strategy should be deleted, or null to keep it. */
export function deleteReason(s: Pick<Strategy, 'name' | 'symbol'>): string | null {
  if (/^M1 HFT EMA Scalp/i.test(s.name)) return 'its break-even and trailing distances sit inside the spread, so the broker rejects its stop moves';
  if (/^M1 Gold Quick Scalp/i.test(s.name) && s.symbol.toUpperCase() === 'EURUSD') return 'named "Gold" but trades EURUSD (a duplicate)';
  return null;
}

export function planCleanup(list: Strategy[]): CleanupPlan {
  const plan: CleanupPlan = { flagTest: [], clampLot: [], remove: [] };
  for (const s of list) {
    const why = deleteReason(s);
    if (why) {
      plan.remove.push({ id: s.id, name: s.name, reason: why });
      continue; // being deleted: no point flagging or clamping it
    }
    if (/\(test\)/i.test(s.name) && !s.isTest) plan.flagTest.push({ id: s.id, name: s.name });
    const cap = maxLotFor(s.symbol);
    if (typeof s.risk?.maxLot === 'number' && s.risk.maxLot > cap) {
      plan.clampLot.push({ id: s.id, name: s.name, from: s.risk.maxLot, to: cap });
    }
  }
  return plan;
}

export const isEmpty = (p: CleanupPlan): boolean => p.flagTest.length + p.clampLot.length + p.remove.length === 0;

export function describePlan(plan: CleanupPlan, apply: boolean): string[] {
  const verb = apply ? 'Done' : 'Would do';
  const lines: string[] = [];
  if (isEmpty(plan)) return ['Nothing to clean up.'];
  for (const f of plan.flagTest) lines.push(`${verb}: mark "${f.name}" as a test strategy (left out of totals)`);
  for (const c of plan.clampLot) lines.push(`${verb}: lower max lot of "${c.name}" from ${c.from} to ${c.to}`);
  for (const r of plan.remove) lines.push(`${verb}: delete "${r.name}" — ${r.reason}`);
  return lines;
}

export function runCleanup(deps: { store: CleanupStore; backup: () => string }, opts: { apply: boolean }): CleanupResult {
  const plan = planCleanup(deps.store.list());
  if (!opts.apply || isEmpty(plan)) {
    const lines = describePlan(plan, false);
    if (!isEmpty(plan)) lines.push('', 'Dry run: nothing was changed. Run again with --apply to do it.');
    return { plan, applied: false, lines };
  }

  // Back up first. If this throws, nothing below runs.
  const backupPath = deps.backup();

  const byId = new Map(deps.store.list().map((s) => [s.id, s]));
  for (const f of plan.flagTest) deps.store.save({ ...byId.get(f.id)!, isTest: true });
  for (const c of plan.clampLot) {
    const cur = deps.store.list().find((s) => s.id === c.id)!;
    deps.store.save({ ...cur, risk: { ...cur.risk, maxLot: c.to } });
  }
  for (const r of plan.remove) deps.store.remove(r.id);

  return {
    plan,
    applied: true,
    backupPath,
    lines: [`Backup written to ${backupPath}`, ...describePlan(plan, true), '', 'Stop any bot that was running a deleted strategy: positions it opened stay open at the broker.'],
  };
}
