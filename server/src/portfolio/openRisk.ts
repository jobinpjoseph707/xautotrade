import { capPctOfEquity, tierName, type TierConfig } from './config.js';

export interface RiskPosition {
  strategyId: string | null;
  symbol: string;
  side: 'long' | 'short';
  lots: number;
  /** Distance from the entry to the stop, in points. */
  stopPoints: number;
  pointValuePerLot: number;
  tier: number;
}

/** Money at risk to the stop: lot size × stop distance in points × value of a point. */
export const positionRisk = (p: Pick<RiskPosition, 'lots' | 'stopPoints' | 'pointValuePerLot'>): number => p.lots * p.stopPoints * p.pointValuePerLot;

/** Distance from entry to stop in points. No stop means the risk is unbounded. */
export function stopPointsOf(openPrice: number, stopLoss: number | null, point: number): number {
  return stopLoss == null ? Number.POSITIVE_INFINITY : Math.abs(openPrice - stopLoss) / point;
}

/**
 * Positions that are the same bet: same symbol and direction, or the same direction in two markets that
 * are configured as moving together. Long and short on the same market are different bets.
 */
export function betKey(symbol: string, side: 'long' | 'short', groups: string[][]): string {
  const g = groups.findIndex((grp) => grp.includes(symbol));
  return `${g >= 0 ? `group${g}` : symbol}:${side}`;
}

export interface OrderCheck {
  allowed: boolean;
  scope?: 'tier' | 'bet' | 'equity';
  /** Plain sentence for the log and the Help page. */
  reason?: string;
  capPct?: number;
  /** Open risk this order would bring the tier (or the bet) to, % of equity. */
  wouldBePct?: number;
}

export interface OrderCheckInput {
  equity: number;
  tier: number;
  newRisk: number;
  symbol: string;
  side: 'long' | 'short';
  open: RiskPosition[];
  config: TierConfig;
}

const pct = (n: number) => `${n.toFixed(2)}%`;

/**
 * May this order go out? Checks the tier's cap on everything open in that tier, then the cap on the bet
 * it would join (counted together, against the strictest tier in that bet). A cap only ever stops a NEW
 * order: nothing in here can close a position that is already open.
 */
export function checkOrder(i: OrderCheckInput): OrderCheck {
  if (!(i.equity > 0)) return { allowed: false, scope: 'equity', reason: 'The account equity is not known, so the open risk cannot be checked.' };
  const asPct = (money: number) => (money / i.equity) * 100;

  const tierCap = capPctOfEquity(i.config, i.tier);
  const tierNow = i.open.filter((p) => p.tier === i.tier).reduce((a, p) => a + positionRisk(p), 0);
  const tierWould = asPct(tierNow + i.newRisk);
  if (tierWould > tierCap + 1e-9) {
    return {
      allowed: false,
      scope: 'tier',
      capPct: tierCap,
      wouldBePct: tierWould,
      reason: `Tier cap reached: ${tierName(i.tier)} may have ${pct(tierCap)} of equity at risk to the stop, and this order would bring it to ${pct(tierWould)}.`,
    };
  }

  const key = betKey(i.symbol, i.side, i.config.groups);
  const mates = i.open.filter((p) => betKey(p.symbol, p.side, i.config.groups) === key);
  if (mates.length > 0) {
    const strictest = Math.min(capPctOfEquity(i.config, i.tier), ...mates.map((p) => capPctOfEquity(i.config, p.tier)));
    const betWould = asPct(mates.reduce((a, p) => a + positionRisk(p), 0) + i.newRisk);
    if (betWould > strictest + 1e-9) {
      return {
        allowed: false,
        scope: 'bet',
        capPct: strictest,
        wouldBePct: betWould,
        reason: `Counted as one bet: ${mates.length} open position${mates.length === 1 ? '' : 's'} already ${i.side} on ${i.symbol} or a linked market. Together with this order that is ${pct(betWould)} at risk, over the ${pct(strictest)} the strictest tier among them allows.`,
      };
    }
  }
  return { allowed: true, capPct: tierCap, wouldBePct: tierWould };
}
