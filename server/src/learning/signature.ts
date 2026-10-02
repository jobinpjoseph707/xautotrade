/**
 * Turn a change into stable "kinds of change" (signatures) so outcomes of
 * similar changes can be grouped: "risk.slPoints:down", "ind.ema.period:up".
 */
import type { Strategy } from '../engine/types.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function dir(a: unknown, b: unknown): string | null {
  if (same(a, b)) return null;
  if (typeof a === 'number' && typeof b === 'number') return b > a ? 'up' : b < a ? 'down' : null;
  if (typeof a === 'boolean' && typeof b === 'boolean') return b ? 'on' : 'off';
  return 'changed';
}

export function changeSignatures(action: string, before: Strategy | null, after: Strategy | null): string[] {
  if (action === 'create_strategy') return ['create'];
  if (action !== 'update_strategy') return [action.replace('_strategy', '')];
  if (!before || !after) return ['update'];

  const sigs: string[] = [];
  if (before.symbol !== after.symbol) sigs.push('symbol:changed');
  if (before.timeframe !== after.timeframe) sigs.push('timeframe:changed');

  const br = before.risk as unknown as Record<string, unknown>;
  const ar = after.risk as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(br), ...Object.keys(ar)])) {
    const d = dir(br[k], ar[k]);
    if (d) sigs.push(`risk.${k}:${d}`);
  }

  const bi = new Map(before.indicators.map((i) => [i.id, i]));
  const ai = new Map(after.indicators.map((i) => [i.id, i]));
  let structural = bi.size !== ai.size;
  for (const [id, a] of ai) {
    const b = bi.get(id);
    if (!b || b.type !== a.type) {
      structural = true;
      continue;
    }
    const bp = (b.params ?? {}) as Record<string, unknown>;
    const ap = (a.params ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
      const d = dir(bp[k], ap[k]);
      if (d) sigs.push(`ind.${a.type}.${k}:${d}`);
    }
  }
  if (structural) sigs.push('indicators:changed');
  if (!same(before.entryLong, after.entryLong) || !same(before.entryShort, after.entryShort)) sigs.push('rules.entry:changed');
  if (!same(before.exitLong, after.exitLong) || !same(before.exitShort, after.exitShort)) sigs.push('rules.exit:changed');
  return sigs.length ? [...new Set(sigs)] : ['update'];
}

const RISK_NAMES: Record<string, string> = {
  slPoints: 'stop-loss distance',
  slAtrMult: 'ATR stop multiple',
  tpPoints: 'take-profit distance',
  tpAtrMult: 'ATR target multiple',
  tpRR: 'reward:risk target',
  fixedLot: 'lot size',
  riskPercent: 'risk per trade',
  maxSpreadPoints: 'spread cap',
  maxDailyTrades: 'daily trade limit',
  maxDailyLossPercent: 'daily loss cap',
  cooldownBars: 'cooldown between trades',
  trailingStartPoints: 'trailing-stop start',
  trailingStepPoints: 'trailing-stop step',
  breakEvenPoints: 'break-even distance',
  trailingEnabled: 'trailing stop',
  sessions: 'session filter',
  tradingDays: 'trading days',
};

/** Plain-English label for a signature, used in notebooks and critic notes. */
export function describeSignature(sig: string): string {
  const [what, d] = sig.split(':');
  const verb = { up: 'raising', down: 'lowering', on: 'turning on', off: 'turning off', changed: 'changing' }[d ?? ''] ?? 'changing';
  if (what === 'create') return 'creating a new strategy';
  if (what === 'delete') return 'deleting a strategy';
  if (what === 'stop_bot') return 'stopping a bot';
  if (what === 'start_bot') return 'starting a bot';
  if (what === 'update') return 'editing a strategy';
  if (what.startsWith('risk.')) {
    const k = what.slice(5);
    if (k === 'slPoints' && d === 'down') return 'tightening the stop-loss';
    if (k === 'slPoints' && d === 'up') return 'widening the stop-loss';
    return `${verb} the ${RISK_NAMES[k] ?? k}`;
  }
  if (what.startsWith('ind.')) {
    const [, type, param] = what.split('.');
    return `${verb} the ${type.toUpperCase()} ${param}`;
  }
  if (what === 'indicators') return 'changing which indicators are used';
  if (what === 'rules.entry') return 'rewriting the entry rules';
  if (what === 'rules.exit') return 'rewriting the exit rules';
  return `${verb} ${what}`;
}
