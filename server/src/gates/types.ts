import type { Candle, GateStage, Strategy, SymbolSpec } from '../engine/types.js';

/** The marks a strategy has to beat. Written down once so the app, the tests and the Help text agree. */
export const PASS_MARKS = {
  backtest: {
    minTrades: 100,
    minUnseenTrades: 30,
    /** Profit factor needed on bars the strategy was never tuned on, for the first attempt. */
    minUnseenProfitFactor: 1.2,
    /** Each further attempt on the same bars raises the bar by this much. */
    attemptStep: 0.05,
    /** After this many attempts on the same bars, wait for new bars. */
    maxAttempts: 5,
    newBarsAfterMax: 500,
    /** Share of the candles held back as unseen. */
    unseenShare: 0.3,
    /** The strategy must still not lose with the spread this many times wider. */
    stressSpreadMultiple: 2,
    stressMinProfitFactor: 1,
  },
  demo: {
    minDays: 7,
    minTrades: 100,
    /** Strictly above this. */
    minProfitFactor: 1.2,
    defaultMaxDrawdownPct: 25,
  },
} as const;

export type GateVerdict = 'pass' | 'fail' | 'not_enough_evidence';

/** One finished test. Written once, never changed. */
export interface GateAttempt {
  id: string;
  strategyId: string;
  /** The stage that was tested, i.e. the one the strategy is in. */
  stage: GateStage;
  at: number;
  passed: boolean;
  verdict: GateVerdict;
  reasons: string[];
  /** The numbers the verdict rests on. */
  evidence: Record<string, number>;
  /** Backtest only: which try this is on the current unseen bars (1..5). */
  attemptNo?: number;
  /** Backtest only: the profit factor this try had to beat. */
  requiredProfitFactor?: number;
  /** Backtest only: first bar (ms) of the unseen window, fixed for the whole run of attempts. */
  unseenFrom?: number;
  /** Backtest only: time of the last candle the attempt used. */
  lastBar?: number;
}

export interface GateStore {
  /** Add a record. Throws if the id already exists; nothing can be changed or removed. */
  append(a: GateAttempt): void;
  /** Oldest first. */
  list(strategyId: string, stage?: GateStage): GateAttempt[];
  latest(strategyId: string, stage?: GateStage): GateAttempt | null;
}

/** What a gate needs to test a strategy on: real candles and the real contract. Always supplied by the caller. */
export interface GateData {
  candles: Candle[];
  spec: SymbolSpec;
  /** MT5 candle stamps are broker server time; sessions and the flat window need real UTC. */
  serverOffsetMs?: number;
}
export type GateDataSource = (strategy: Strategy) => Promise<GateData>;

/** Evidence from the demo account. */
export interface DemoEvidence {
  days: number;
  trades: number;
  profitFactor: number;
  avgWin: number;
  /** Positive number: the average size of a losing trade. */
  avgLoss: number;
  maxDrawdownPct: number;
}

export interface GateRefusal {
  refused: true;
  reason: string;
}

export class GateLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateLockedError';
  }
}
