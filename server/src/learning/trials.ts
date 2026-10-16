/**
 * The test every theory must survive before it can become a proposal.
 *
 * A theory is tested on bars the agent never saw (the unseen window of the validation). It is dropped,
 * and the attempt recorded, when:
 *   - the test bars overlap the bars the theory was formed on,
 *   - the result meets the theory's own "this would prove me wrong" line,
 *   - or the change does not hold up on the unseen bars.
 *
 * Only `testTheory` and `claimSurvivor` can produce a `SurvivedTrial`; the brand symbol is not exported,
 * so no other code can build one. `ChatService.proposeUpdate` accepts nothing else (the same trick as
 * EligibleStrategy in youtube/gate.ts).
 */
import { randomUUID } from 'node:crypto';

import type { Strategy } from '../engine/types.js';
import { describeDisproof, disproofMet, type Theory } from './hypothesis.js';
import type { RecordStore } from './records.js';
import type { ChangeRecord, MarketSnapshot, Validation } from './types.js';

export type TrialStatus = 'survived' | 'dropped' | 'untestable';

export interface Trial {
  id: string;
  createdAt: number;
  theory: Theory;
  strategyId: string;
  status: TrialStatus;
  reasons: string[];
  /** The unseen bars it was tested on. */
  testWindow?: { from: number; to: number };
  validation?: Validation;
  market?: MarketSnapshot;
  /** A survivor can start one proposal, once. */
  usedBy?: string;
}

declare const survivedBrand: unique symbol;
export type SurvivedTrial = Trial & { status: 'survived'; readonly [survivedBrand]: true };

export const TRIAL_TTL_MS = 60 * 60_000;

export interface TrialDeps {
  store: RecordStore<Trial>;
  /** The same unseen-data check every proposal gets. */
  validate(before: Strategy | null, after: Strategy, safetyChange: boolean): Promise<{ validation: Validation; market?: MarketSnapshot }>;
  /** The strategy as it is, and with the theory's change applied. */
  merge(current: Strategy, changes: Record<string, unknown>): Strategy;
  now?(): number;
}

export const windowsOverlap = (a: { from: number; to: number }, b: { from: number; to: number }): boolean => a.from <= b.to && b.from <= a.to;

const brand = (t: Trial): SurvivedTrial => t as SurvivedTrial;

/** Test a theory, record the attempt (whatever happens), and return it. */
export async function testTheory(theory: Theory, current: Strategy, deps: TrialDeps): Promise<Trial | SurvivedTrial> {
  const now = deps.now?.() ?? Date.now();
  const trial: Trial = { id: randomUUID(), createdAt: now, theory, strategyId: theory.strategyId, status: 'dropped', reasons: [] };
  const finish = (): Trial | SurvivedTrial => {
    deps.store.put(trial);
    return trial.status === 'survived' ? brand(trial) : trial;
  };

  let result: { validation: Validation; market?: MarketSnapshot };
  try {
    result = await deps.validate(current, deps.merge(current, theory.changes), false);
  } catch (err) {
    trial.status = 'untestable';
    trial.reasons = [`The test could not run: ${err instanceof Error ? err.message : String(err)}`];
    return finish();
  }
  const { validation } = result;
  trial.validation = validation;
  trial.market = result.market;
  const oos = validation.outOfSample;
  if (!oos || !oos.after) {
    trial.status = 'untestable';
    trial.reasons = [...validation.reasons, 'There were no unseen bars to test on.'];
    return finish();
  }
  trial.testWindow = { from: oos.from, to: oos.to };

  if (windowsOverlap(trial.testWindow, theory.formedOn)) {
    trial.reasons = ['The test bars overlap the bars the theory was formed on, so they are not unseen.'];
    return finish();
  }
  if (disproofMet(theory.disproof, oos.after)) {
    trial.reasons = [`The theory met its own disproof line (${describeDisproof(theory.disproof)}): it is dropped.`, ...validation.reasons];
    return finish();
  }
  if (validation.verdict !== 'pass') {
    trial.status = validation.verdict === 'insufficient' || validation.verdict === 'error' ? 'untestable' : 'dropped';
    trial.reasons = validation.reasons;
    return finish();
  }
  trial.status = 'survived';
  trial.reasons = validation.reasons;
  return finish();
}

export class TrialRefused extends Error {}

const sameChanges = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Turn a stored survivor back into a `SurvivedTrial` for one proposal. Refuses anything that did not
 * survive, was already used, is for another strategy or another change, or is too old.
 */
export function claimSurvivor(
  store: RecordStore<Trial>,
  req: { trialId: string; strategyId: string; changes: Record<string, unknown>; proposalId: string },
  now = Date.now(),
): SurvivedTrial {
  const t = store.get(req.trialId);
  if (!t) throw new TrialRefused('No such test. A proposal needs a theory that survived a test.');
  if (t.status !== 'survived') throw new TrialRefused(`That theory did not survive its test (${t.status}).`);
  if (t.usedBy) throw new TrialRefused('That test has already been used for a proposal.');
  if (t.strategyId !== req.strategyId) throw new TrialRefused('That test was for a different strategy.');
  if (!sameChanges(t.theory.changes, req.changes)) throw new TrialRefused('That test was for a different change.');
  if (now - t.createdAt > TRIAL_TTL_MS) throw new TrialRefused('That test is too old; run it again on current bars.');
  t.usedBy = req.proposalId;
  store.put(t);
  return brand(t);
}

/** A change that is approved and not yet scored, or still waiting in the Inbox. One at a time per strategy. */
export function openChange(changes: ChangeRecord[], strategyId: string): ChangeRecord | null {
  return (
    changes.find(
      (r) =>
        r.strategyId === strategyId &&
        r.actionType === 'update_strategy' &&
        ((r.status === 'approved' && r.score === 'pending') || r.status === 'pending'),
    ) ?? null
  );
}
