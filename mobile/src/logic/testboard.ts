/** Pure Testboard presentation rules (no React Native imports) so they can be unit-tested. */
import type { GateStage, TestboardEntry } from '../types';

export const STAGES: GateStage[] = ['backtest', 'paper', 'demo', 'live'];

export const STAGE_LABEL: Record<GateStage, string> = { backtest: 'Backtest', paper: 'Paper', demo: 'Demo', live: 'Live' };

export const TESTBOARD_SUBTITLE = 'Which stage each strategy has reached';
export const EMPTY_TITLE = 'No strategies to test yet';
export const EMPTY_BODY = 'Each real strategy will show its stage, its progress and a plain verdict here. Test strategies are not listed.';
export const LIVE_LOCKED = 'Locked. Nothing in this app can move a strategy to live.';

/** "40 / 100 trades" while on demo, otherwise nothing. */
export function progressLabel(e: Pick<TestboardEntry, 'progress'>): string | null {
  return e.progress ? `${e.progress.trades} / ${e.progress.tradesNeeded} trades` : null;
}

/** "3.5 / 7 days" while on demo, otherwise nothing. */
export function daysLabel(e: Pick<TestboardEntry, 'progress'>): string | null {
  return e.progress ? `${e.progress.days} / ${e.progress.daysNeeded} days` : null;
}

export const enoughDemoTrades = (e: Pick<TestboardEntry, 'progress'>): boolean => !e.progress || e.progress.trades >= e.progress.tradesNeeded;

/** The one plain line under each strategy. */
export function verdictLine(e: Pick<TestboardEntry, 'stage' | 'latest' | 'progress' | 'waiting'>): string {
  if (e.stage === 'live') return LIVE_LOCKED;
  // On demo the live count is more current than an old test, so it speaks first while the evidence is thin.
  if (e.stage === 'demo' && !enoughDemoTrades(e)) return 'Not enough trades yet';
  if (!e.latest) return 'Not tested yet';
  switch (e.latest.verdict) {
    case 'pass':
      return e.waiting ? 'Passed. Open the Inbox and tap Move to next stage.' : 'Passed.';
    case 'not_enough_evidence':
      return 'Not enough trades yet';
    default:
      return 'Did not pass';
  }
}

export const verdictTone = (e: Pick<TestboardEntry, 'stage' | 'latest'>): 'good' | 'critical' | 'warning' | 'neutral' => {
  if (e.stage === 'live' || !e.latest) return 'neutral';
  return e.latest.verdict === 'pass' ? 'good' : e.latest.verdict === 'fail' ? 'critical' : 'warning';
};

/** Reasons to show under a verdict, at most three. */
export const reasonsToShow = (e: Pick<TestboardEntry, 'latest'>): string[] => (e.latest && !e.latest.passed ? e.latest.reasons.slice(0, 3) : []);

/** Where a stage sits for one strategy: finished, the one it is in, the next ones, or the locked live stage. */
export function stageState(current: GateStage, stage: GateStage): 'done' | 'current' | 'later' | 'locked' {
  if (stage === 'live') return 'locked';
  const a = STAGES.indexOf(stage);
  const b = STAGES.indexOf(current);
  return a < b ? 'done' : a === b ? 'current' : 'later';
}

/** Test strategies are never listed; everything else is, oldest stage first. */
export const canRunTest = (e: Pick<TestboardEntry, 'stage'>): boolean => e.stage !== 'live';
