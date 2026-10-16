import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SPEC, type Strategy } from '../engine/types.js';
import { BotRunner, liveEnv, positionTag } from '../live/runner.js';
import { settings } from '../store.js';
import { ScriptedBroker, alwaysLong, fakeClock, flat, until } from '../testkit/index.js';
import { DEFAULT_TIER_CONFIG, TIER_NAMES, capPctOfEquity, validateTierConfig, type TierConfig } from './config.js';
import { maxDrawdownPctFromEquity } from './drawdown.js';
import { createGuard } from './guard.js';
import { loadTierConfig, saveTierConfig } from './instance.js';
import { betKey, checkOrder, positionRisk, stopPointsOf, type RiskPosition } from './openRisk.js';
import { TierService } from './service.js';
import { MemoryTierStore } from './store.js';
import { nextTierState, tierFromMeasures, tierOfValue, TIER_LIMITS, utcDayNumber, type TierMeasures } from './tiers.js';

const m = (o: Partial<TierMeasures> = {}): TierMeasures => ({ riskPerTradePct: 0.1, maxDrawdownPct: 1, worstDayPct: 0.2, ...o });

test('T-1: each row of the tier table lands in its tier', () => {
  const rows: [keyof TierMeasures, number, number][] = [
    ['riskPerTradePct', 0.25, 1], ['riskPerTradePct', 0.26, 2], ['riskPerTradePct', 0.5, 2], ['riskPerTradePct', 0.51, 3],
    ['riskPerTradePct', 1, 3], ['riskPerTradePct', 1.01, 4], ['riskPerTradePct', 1.5, 4], ['riskPerTradePct', 1.51, 5],
    ['maxDrawdownPct', 3, 1], ['maxDrawdownPct', 3.1, 2], ['maxDrawdownPct', 6, 2], ['maxDrawdownPct', 10, 3],
    ['maxDrawdownPct', 15, 4], ['maxDrawdownPct', 15.1, 5],
    ['worstDayPct', 0.5, 1], ['worstDayPct', 1, 2], ['worstDayPct', 2, 3], ['worstDayPct', 3, 4], ['worstDayPct', 3.01, 5],
  ];
  for (const [key, value, tier] of rows) {
    assert.equal(tierOfValue(value, TIER_LIMITS[key]), tier, `${key} = ${value}`);
    assert.equal(tierFromMeasures(m({ [key]: value })).tier, tier, `${key} = ${value} alone decides`);
  }
  assert.equal(TIER_NAMES.length, 5);
});

test('T-2: the worst of the three measures decides the tier', () => {
  const d = tierFromMeasures(m({ riskPerTradePct: 0.2, maxDrawdownPct: 12, worstDayPct: 0.4 }));
  assert.equal(d.tier, 4);
  assert.equal(d.decidedBy, 'maxDrawdownPct');
  assert.deepEqual(d.byMeasure, { riskPerTradePct: 1, maxDrawdownPct: 4, worstDayPct: 1 });
});

test('T-3: moving to a riskier tier is immediate; moving to a safer one needs 3 days in a row', () => {
  const d0 = 20_000;
  let s = nextTierState(null, 3, d0);
  assert.equal(s.tier, 3);
  s = nextTierState(s, 5, d0 + 1);
  assert.equal(s.tier, 5, 'riskier is immediate');
  // safer: two days is not enough
  s = nextTierState(s, 2, d0 + 2);
  s = nextTierState(s, 2, d0 + 3);
  assert.equal(s.tier, 5);
  // a check on the same day changes nothing
  assert.deepEqual(nextTierState(s, 2, d0 + 3), s);
  // the third day in a row moves it, and only as far as the riskiest of the three days
  s = nextTierState(s, 3, d0 + 4);
  assert.equal(s.tier, 3);
  // a day that is not safer breaks the streak
  let t = nextTierState(null, 4, d0);
  t = nextTierState(t, 2, d0 + 1);
  t = nextTierState(t, 2, d0 + 2);
  t = nextTierState(t, 4, d0 + 3);
  t = nextTierState(t, 2, d0 + 4);
  t = nextTierState(t, 2, d0 + 5);
  assert.equal(t.tier, 4, 'the streak started over');
  // a missed day breaks it too
  let u = nextTierState(null, 4, d0);
  u = nextTierState(u, 2, d0 + 1);
  u = nextTierState(u, 2, d0 + 3);
  u = nextTierState(u, 2, d0 + 4);
  assert.equal(u.tier, 4);
  assert.equal(utcDayNumber(Date.UTC(1970, 0, 2)), 1);
});

test('T-4: open risk is the sum of lot × stop distance × point value', () => {
  // EURUSD long 0.5 lot, entry 1.10000, stop 1.09800: 200 points × 1.0 per point per lot
  const eur = { lots: 0.5, stopPoints: stopPointsOf(1.1, 1.098, 0.00001), pointValuePerLot: 1 };
  // USDJPY short 0.3 lot, entry 150.000, stop 150.150: 150 points × 0.67
  const jpy = { lots: 0.3, stopPoints: stopPointsOf(150, 150.15, 0.001), pointValuePerLot: 0.67 };
  assert.ok(Math.abs(eur.stopPoints - 200) < 1e-6);
  assert.ok(Math.abs(jpy.stopPoints - 150) < 1e-6);
  assert.ok(Math.abs(positionRisk(eur) - 100) < 1e-6);
  assert.ok(Math.abs(positionRisk(jpy) - 30.15) < 1e-6);
  assert.ok(Math.abs(positionRisk(eur) + positionRisk(jpy) - 130.15) < 1e-6);
  assert.equal(stopPointsOf(1.1, null, 0.00001), Number.POSITIVE_INFINITY, 'no stop = unbounded risk');
});

const cfg: TierConfig = { riskBudgetPct: 3, capSharePct: [50, 40, 30, 25, 20], groups: [['EURUSD', 'GBPUSD']] };
const pos = (o: Partial<RiskPosition> = {}): RiskPosition => ({ strategyId: 'a', symbol: 'XAUUSD', side: 'long', lots: 1, stopPoints: 10, pointValuePerLot: 1, tier: 3, ...o });
const order = (o: Partial<Parameters<typeof checkOrder>[0]> = {}) => checkOrder({ equity: 10_000, tier: 5, newRisk: 10, symbol: 'XAUUSD', side: 'long', open: [], config: cfg, ...o });

test('T-5: an order that would pass the tier cap is blocked and logged', async () => {
  assert.equal(capPctOfEquity(cfg, 5), 0.6, 'budget 3% × top tier 20% = 0.6% of equity');
  assert.equal(order({ newRisk: 60 }).allowed, true, 'exactly at the cap is allowed');
  const blocked = order({ newRisk: 60.5 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'tier');
  assert.match(blocked.reason ?? '', /Tier cap reached: Aggressive may have 0.60%/);
  // Existing risk in the same tier counts, other tiers do not.
  assert.equal(order({ newRisk: 30, open: [pos({ tier: 5, lots: 1, stopPoints: 40 })] }).allowed, false);
  assert.equal(order({ newRisk: 30, open: [pos({ tier: 2, lots: 1, stopPoints: 400, symbol: 'EURUSD' })] }).allowed, true);

  // End to end: the bot's order is blocked and the block is written to its log.
  const { broker, bot, events } = await botWith({ lots: 0.5, tier: 5 });
  assert.deepEqual(broker.calls, [], 'no order went out');
  assert.ok(events.some((e) => e.event === 'order_blocked' && /Tier cap reached/.test(e.message)), 'the block is logged');
  assert.match(bot.snapshot().blockedReason ?? '', /Tier cap reached/);
});

test('T-6: an order below the cap goes through', async () => {
  const { broker } = await botWith({ lots: 0.1, tier: 5 });
  assert.equal(broker.positions.length, 1);
});

test('T-7: a cap never closes a position that is already open', async () => {
  const s = strategyWith(0.5);
  s.risk = { ...s.risk, maxOpenPositions: 3 }; // so only the cap, not the position limit, can stop a second order
  const broker = brokerFor();
  // Already holding 1.0% of equity at risk, which is over the 0.6% cap for this tier.
  broker.addPosition({ comment: positionTag(s.id), symbol: 'EURUSD', side: 'long', volume: 0.5, openPrice: 1.1, stopLoss: 1.098, takeProfit: 1.2 });
  await startBot(s, broker, 5);
  assert.ok(!broker.calls.some((c) => c.startsWith('close')), 'nothing was closed');
  assert.equal(broker.positions.length, 1, 'the position is still open');
  assert.ok(!broker.calls.some((c) => c.startsWith('open')), 'and no second one was opened');
});

test('T-8: the top tier cannot be set above 20%', () => {
  const bad = { ...DEFAULT_TIER_CONFIG, capSharePct: [50, 40, 30, 25, 21] };
  assert.throws(() => validateTierConfig(bad), /cannot be set above 20%/);
  assert.doesNotThrow(() => validateTierConfig({ ...DEFAULT_TIER_CONFIG, capSharePct: [50, 40, 30, 25, 20] }));
  assert.throws(() => saveTierConfig(bad), /cannot be set above 20%/);
  assert.throws(() => validateTierConfig({ ...DEFAULT_TIER_CONFIG, capSharePct: [50, 40, 30, 25] }), /exactly 5/);
  // A bad value that somehow got saved is never trusted when it is read back.
  settings.set('tierConfig', bad);
  assert.deepEqual(loadTierConfig(), DEFAULT_TIER_CONFIG);
  settings.set('tierConfig', null);
  saveTierConfig({ ...DEFAULT_TIER_CONFIG, riskBudgetPct: 2 });
  assert.equal(loadTierConfig().riskBudgetPct, 2);
  settings.set('tierConfig', null);
});

test('T-9: two strategies long gold count as one bet', () => {
  // A (tier 3, cap 0.9%) holds 0.5% long gold. B (tier 5, cap 0.6%) wants 0.3% more, long gold.
  const open = [pos({ strategyId: 'a', tier: 3, lots: 1, stopPoints: 50 })]; // $50 = 0.5%
  const alone = order({ tier: 5, newRisk: 30, symbol: 'EURUSD', open: [] });
  assert.equal(alone.allowed, true, 'on its own, 0.3% is fine for tier 5');
  const together = order({ tier: 5, newRisk: 30, open });
  assert.equal(together.allowed, false);
  assert.equal(together.scope, 'bet');
  assert.match(together.reason ?? '', /Counted as one bet/);
  // The stricter tier's cap applies, so a bet that fits tier 5's 0.6% is allowed.
  assert.equal(order({ tier: 5, newRisk: 10, open }).allowed, true);
  assert.equal(betKey('XAUUSD', 'long', cfg.groups), betKey('XAUUSD', 'long', cfg.groups));
});

test('T-10: long and short on the same symbol are not grouped', () => {
  assert.notEqual(betKey('XAUUSD', 'long', cfg.groups), betKey('XAUUSD', 'short', cfg.groups));
  const open = [pos({ tier: 3, lots: 1, stopPoints: 50, side: 'long' })];
  assert.equal(order({ tier: 5, newRisk: 30, side: 'short', open }).allowed, true, 'the short is its own bet');
  assert.equal(order({ tier: 5, newRisk: 30, side: 'long', open }).allowed, false);
});

test('T-11: EURUSD long and GBPUSD long count as one bet', () => {
  assert.equal(betKey('EURUSD', 'long', cfg.groups), betKey('GBPUSD', 'long', cfg.groups));
  assert.notEqual(betKey('EURUSD', 'long', cfg.groups), betKey('GBPUSD', 'short', cfg.groups));
  const open = [pos({ symbol: 'EURUSD', tier: 3, lots: 1, stopPoints: 50 })];
  const r = order({ tier: 5, symbol: 'GBPUSD', newRisk: 30, open });
  assert.equal(r.allowed, false);
  assert.equal(r.scope, 'bet');
  // Not linked in the config: no longer one bet.
  assert.equal(order({ tier: 5, symbol: 'GBPUSD', newRisk: 30, open, config: { ...cfg, groups: [] } }).allowed, true);
});

test('T-12: a tier taken from a backtest is marked provisional', async () => {
  const store = new MemoryTierStore();
  const s: Strategy = { ...alwaysLong(), id: 'bt_only', isTest: false };
  const day = Date.UTC(2026, 9, 16, 10);
  const closes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ts: day - (n - i) * 3_600_000, strategyId: s.id, level: 'trade' as const, event: 'position_closed', message: 'x', data: { profit: i % 2 ? 5 : -5 } }));
  let entries = closes(5);
  const svc = new TierService({
    store,
    strategies: { list: () => [s] },
    tradesBetween: () => entries,
    latestBacktest: () => ({ maxDrawdownPct: 12 }),
    equity: async () => 10_000,
    specOf: async () => ({ ...DEFAULT_SPEC }),
    config: () => cfg,
    now: () => day,
  });
  const [thin] = await svc.recompute();
  assert.equal(thin.provisional, true, 'five trades is too few: the backtest is used');
  assert.equal(thin.measured, 4, '12% drawdown from the backtest');
  // With enough real trades it is measured, not provisional.
  entries = closes(30);
  const [real] = await svc.recompute();
  assert.equal(real.provisional, false);
  assert.ok(real.measures!.maxDrawdownPct < 1);
  // Nothing measured at all: the default tier, still provisional.
  const empty = new TierService({ ...{ store: new MemoryTierStore(), strategies: { list: () => [s] }, tradesBetween: () => [], latestBacktest: () => null, equity: async () => 10_000, specOf: async () => ({ ...DEFAULT_SPEC }), config: () => cfg, now: () => day } });
  const [none] = await empty.recompute();
  assert.equal(none.provisional, true);
  assert.equal(none.state.tier, 3);
  // Test strategies are never given a tier.
  const rig: Strategy = { ...s, id: 'rig', isTest: true };
  const only = new TierService({ store: new MemoryTierStore(), strategies: { list: () => [rig] }, tradesBetween: () => [], latestBacktest: () => null, equity: async () => 10_000, specOf: async () => ({ ...DEFAULT_SPEC }), config: () => cfg, now: () => day });
  assert.deepEqual(await only.recompute(), []);
});

test('T-13: drawdown is measured on equity and catches a dip that recovers', () => {
  // Balance never moves (no closed trades) but equity dips 8% and recovers to +3%.
  const curve = [
    { time: 1, equity: 10_000 },
    { time: 2, equity: 9_200 },
    { time: 3, equity: 10_300 },
  ];
  assert.ok(Math.abs(maxDrawdownPctFromEquity(10_000, curve) - 8) < 1e-9);
  // Peak is running: a dip after a new high is measured from that high.
  const dd = maxDrawdownPctFromEquity(10_000, [
    { time: 1, equity: 11_000 },
    { time: 2, equity: 10_450 },
  ]);
  assert.ok(Math.abs(dd - 5) < 1e-9);
  // The starting balance seeds the peak.
  assert.ok(Math.abs(maxDrawdownPctFromEquity(10_000, [{ time: 1, equity: 9_000 }]) - 10) < 1e-9);
});

// --- helpers for the end-to-end rows ---------------------------------------------------------------

const clock = () => fakeClock(Date.UTC(2026, 9, 7, 10, 0, 0)).now;

function strategyWith(lots: number): Strategy {
  const s = alwaysLong();
  s.risk = { ...s.risk, fixedLot: lots, maxLot: Math.max(lots, 0.5), slMode: 'points', slPoints: 200, tpMode: 'points', tpPoints: 300 };
  return s;
}

function brokerFor(): ScriptedBroker {
  const b = new ScriptedBroker();
  b.bid = 3;
  b.candles = [...flat(300, 3), ...flat(1, 3, { start: Date.UTC(2026, 9, 7, 6, 0, 0) })];
  return b;
}

const running: BotRunner[] = [];
async function startBot(s: Strategy, broker: ScriptedBroker, tier: number): Promise<{ bot: BotRunner; events: { event: string; message: string }[] }> {
  const events: { event: string; message: string }[] = [];
  const env = { ...liveEnv, orderGuard: createGuard({ config: () => cfg, tierOf: () => tier, strategyIdOf: (c) => (c === positionTag(s.id) ? s.id : null) }) };
  const bot = new BotRunner(s, broker, false, clock(), env);
  bot.on('log', (e: { event: string; message: string }) => events.push(e));
  running.push(bot);
  await bot.start();
  await until(() => bot.snapshot().lastTickAt != null);
  return { bot, events };
}
async function botWith(o: { lots: number; tier: number }) {
  const broker = brokerFor();
  const { bot, events } = await startBot(strategyWith(o.lots), broker, o.tier);
  return { broker, bot, events };
}

import { afterEach } from 'node:test';
afterEach(() => {
  while (running.length) running.pop()!.stop();
});

test('a manual trade with no stop is left out of the caps; one with a stop is counted', async () => {
  const s = strategyWith(0.1);
  const noStop = brokerFor();
  noStop.addPosition({ comment: undefined, symbol: 'EURUSD', side: 'long', volume: 5, openPrice: 1.1, stopLoss: null });
  await startBot(s, noStop, 3);
  assert.equal(noStop.positions.filter((p) => p.comment === positionTag(s.id)).length, 1, 'the bot still trades');

  const withStop = brokerFor();
  withStop.addPosition({ comment: undefined, symbol: 'EURUSD', side: 'long', volume: 5, openPrice: 1.1, stopLoss: 1.098 }); // $1000 = 10% at risk
  await startBot(strategyWith(0.1), withStop, 3);
  assert.equal(withStop.positions.filter((p) => p.comment?.startsWith('XAT')).length, 0, 'a large manual risk with a stop blocks the new order');
});
