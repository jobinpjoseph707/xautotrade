import { strategies, logs } from '../store.js';
import { inbox } from '../inbox/instance.js';
import { manager } from '../live/manager.js';
import { applySafetyMove, undoSafetyMove, type SafetyDeps, type SafetyMove } from './applySafetyMove.js';

/** The real wiring. Server code that needs to pause or tighten calls `safetyMoves.apply`. There is no HTTP route to it. */
export const safetyDeps: SafetyDeps = {
  strategies,
  inbox,
  trace: (e) => void logs.add({ ts: e.ts, strategyId: e.strategyId, level: 'warn', event: e.event, message: e.message, data: e.data }),
  stopBot: (id) => void manager.stop(id),
  isRunning: (id) => manager.snapshot(id)?.status === 'running',
  reload: (s) => manager.reload(s),
  startBot: (id) => manager.start(id),
};

export const safetyMoves = {
  apply: (move: SafetyMove) => applySafetyMove(move, safetyDeps),
  undo: (strategyId: string, data: unknown) => undoSafetyMove(strategyId, data, safetyDeps),
};
