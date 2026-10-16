/**
 * Writes agents-py/tests/fixtures/risk_cases.json: risk changes and whether the server's own check
 * (gateViolation) calls each one looser. The Python Risk Guard must give the same answers; a server
 * test fails if this file is out of date, and a Python test fails if the guard disagrees.
 *   npx tsx src/scripts/riskCases.ts
 */
import { writeFileSync } from 'node:fs';

import { DEFAULT_RISK, type RiskConfig } from '../engine/types.js';
import { gateViolation } from '../learning/propose.js';

export interface RiskCase {
  name: string;
  before: RiskConfig;
  changes: Partial<RiskConfig>;
  loosens: boolean;
  why: string | null;
}

const base: RiskConfig = { ...DEFAULT_RISK, maxDailyLossPercent: 3, maxDailyTrades: 10, maxSpreadPoints: 40, cooldownBars: 3, minRewardRisk: 1.5, sessions: [{ startHour: 7, endHour: 17 }], tradingDays: [1, 2, 3, 4, 5], flatAtUTC: '21:45', flatBeforeWeekend: true };

const raw: [string, Partial<RiskConfig>, Partial<RiskConfig>?][] = [
  ['wider stop (not a gate)', { slPoints: 260 }],
  ['tighter stop', { slPoints: 150 }],
  ['bigger lot', { fixedLot: 0.05 }],
  ['smaller lot', { fixedLot: 0.01 }],
  ['higher risk percent', { riskPercent: 2 }],
  ['higher max lot', { maxLot: 1 }],
  ['more open positions', { maxOpenPositions: 5 }],
  ['daily loss limit switched off', { maxDailyLossPercent: 0 }],
  ['daily loss limit raised', { maxDailyLossPercent: 5 }],
  ['daily loss limit lowered', { maxDailyLossPercent: 2 }],
  ['daily trades switched off', { maxDailyTrades: 0 }],
  ['daily trades raised', { maxDailyTrades: 20 }],
  ['daily trades lowered', { maxDailyTrades: 5 }],
  ['spread cap switched off', { maxSpreadPoints: 0 }],
  ['spread cap widened', { maxSpreadPoints: 60 }],
  ['spread cap narrowed', { maxSpreadPoints: 30 }],
  ['shorter cooldown', { cooldownBars: 1 }],
  ['longer cooldown', { cooldownBars: 6 }],
  ['lower minimum reward:risk', { minRewardRisk: 1 }],
  ['higher minimum reward:risk', { minRewardRisk: 2 }],
  ['higher spread/stop ratio', { maxSpreadToStopRatio: 0.5 }],
  ['weekend flat rule off', { flatBeforeWeekend: false }],
  ['flat time later', { flatAtUTC: '23:00' }],
  ['flat time earlier', { flatAtUTC: '20:00' }],
  ['wider session', { sessions: [{ startHour: 6, endHour: 17 }] }],
  ['narrower session', { sessions: [{ startHour: 8, endHour: 16 }] }],
  ['sessions cleared (all hours)', { sessions: [] }],
  ['extra trading day', { tradingDays: [0, 1, 2, 3, 4, 5] }],
  ['fewer trading days', { tradingDays: [1, 2, 3] }],
  ['no trading days listed (all days)', { tradingDays: [] }],
  ['trailing on (not a gate)', { trailingEnabled: true }],
];

export function riskCases(): RiskCase[] {
  return raw.map(([name, changes]) => {
    const after = { ...base, ...changes };
    const why = gateViolation(base, after);
    return { name, before: base, changes, loosens: why !== null, why };
  });
}

if (process.argv[1]?.endsWith('riskCases.ts')) {
  writeFileSync(new URL('../../../agents-py/tests/fixtures/risk_cases.json', import.meta.url), JSON.stringify(riskCases(), null, 2) + '\n');
  console.log(`wrote ${raw.length} cases`);
}
