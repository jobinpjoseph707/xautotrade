import { evaluateWeek } from './evaluate.js';
import type { AgentStore } from './store.js';
import {
  DEFAULT_CRITERIA,
  type ActiveAgent,
  type AgentRecord,
  type SuccessCriteria,
  type WeekOutcome,
} from './types.js';
import type { Strategy } from '../engine/types.js';
import { buildLesson } from './lessons.js';
import type { LessonStore } from './lessonStore.js';
import { proposeNextConfig } from './propose.js';

const DAY = 86_400_000;

export type Logger = (msg: string) => void;

/**
 * STUB (piece 3 fills this in). Deliberately makes no change: it only logs
 * that a modification would happen, so a failed agent's successor currently
 * runs the same config.
 */
export function modifyStrategy(strategy: Strategy, log: Logger = console.log): Strategy {
  log(`would modify strategy here (${strategy.name}) — not implemented yet`);
  return structuredClone(strategy);
}

export interface CloseOutResult {
  record: AgentRecord;
  next: ActiveAgent;
  /** True when this week had already been closed; nothing was recomputed. */
  alreadyClosed: boolean;
}

function nextWeek(agent: ActiveAgent): { weekStart: string; weekEnd: string } {
  const start = new Date(agent.weekEnd).getTime();
  return {
    weekStart: new Date(start).toISOString(),
    weekEnd: new Date(start + 7 * DAY).toISOString(),
  };
}

export function newAgentId(generation: number): string {
  return `agent-${String(generation).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create and store the first agent. */
export function startFirstAgent(
  store: AgentStore,
  strategy: Strategy,
  startingBalance: number,
  weekStart: Date,
): ActiveAgent {
  const agent: ActiveAgent = {
    agentId: newAgentId(1),
    generation: 1,
    parentAgentId: null,
    weekStart: weekStart.toISOString(),
    weekEnd: new Date(weekStart.getTime() + 7 * DAY).toISOString(),
    strategy: structuredClone(strategy),
    startingBalance,
  };
  store.setActive(agent);
  return agent;
}

/**
 * Close out the active agent's week: evaluate, write the immutable record,
 * then either continue (pass / no_trades: same config, agent id kept) or
 * spawn a successor with a modified config (fail).
 *
 * Idempotent: if the record already exists it is returned as-is, and no second
 * successor is spawned.
 */
export function closeOutWeek(
  store: AgentStore,
  agent: ActiveAgent,
  outcome: WeekOutcome,
  criteria: SuccessCriteria = DEFAULT_CRITERIA,
  log: Logger = console.log,
  now: () => Date = () => new Date(),
  lessons?: LessonStore,
): CloseOutResult {
  const existing = store.getRecord(agent.agentId, agent.weekStart);
  if (existing) {
    const active = store.getActive();
    return { record: existing, next: active ?? agent, alreadyClosed: true };
  }

  const ev = evaluateWeek(outcome, criteria);
  const record: AgentRecord = {
    agentId: agent.agentId,
    generation: agent.generation,
    parentAgentId: agent.parentAgentId,
    weekStart: agent.weekStart,
    weekEnd: agent.weekEnd,
    strategy: structuredClone(agent.strategy),
    startingBalance: outcome.startingBalance,
    endingBalance: outcome.endingBalance,
    returnPct: ev.returnPct,
    maxDrawdownPct: ev.maxDrawdownPct,
    tradeCount: outcome.tradeCount,
    verdict: ev.verdict,
    reasons: ev.reasons,
    criteria: { ...criteria },
    closedAt: now().toISOString(),
  };
  store.appendRecord(record);

  const window = nextWeek(agent);
  let next: ActiveAgent;
  if (ev.verdict === 'fail') {
    const generation = agent.generation + 1;
    let nextStrategy: Strategy;
    if (lessons) {
      const lesson = buildLesson(agent, record, outcome);
      const proposal = proposeNextConfig(agent.strategy, lesson, lessons.all().map((e) => e.lesson));
      lessons.append({ lesson, proposal, createdAt: now().toISOString() });
      nextStrategy = proposal.strategy;
      log(`lesson recorded (${lesson.rootCause ?? 'no clear cause'}): ${proposal.reasoning}`);
    } else {
      nextStrategy = modifyStrategy(agent.strategy, log);
    }
    next = {
      agentId: newAgentId(generation),
      generation,
      parentAgentId: agent.agentId,
      ...window,
      strategy: nextStrategy,
      startingBalance: outcome.endingBalance,
    };
    log(`${agent.agentId} FAILED — spawned ${next.agentId}`);
  } else {
    // pass: keep going with the unchanged config. no_trades: nothing learned, so also unchanged.
    next = { ...agent, ...window, strategy: structuredClone(agent.strategy), startingBalance: outcome.endingBalance };
    log(`${agent.agentId} ${ev.verdict.toUpperCase()} — same config continues`);
  }
  store.setActive(next);
  return { record, next, alreadyClosed: false };
}
