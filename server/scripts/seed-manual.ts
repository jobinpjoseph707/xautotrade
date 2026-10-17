/**
 * Fills a SANDBOX server with known test data so the manual test plan has something to look at.
 *
 *   1. Start a separate server (see docs/plan/xautotrade-manual-test-plan.md, part A):
 *        E2E_SEED=1 BROKER=paper PORT=4100 API_KEY=sandbox-key DB_PATH=./sandbox.db npm run dev
 *   2. In another window:
 *        npm run seed:manual -- http://localhost:4100 sandbox-key
 *
 * It refuses to run against a real broker (health must say mode "paper"), and it only touches
 * strategies whose name starts with "MT ". Running it twice gives the same result.
 * HTTP only: it needs no database access and changes no code path of the app.
 */

const base = (process.argv[2] ?? 'http://localhost:4100').replace(/\/$/, '');
const key = process.argv[3] ?? process.env.API_KEY ?? '';
if (!key) {
  console.error('Usage: npm run seed:manual -- <server url> <api key>');
  process.exit(2);
}

type Json = Record<string, unknown>;
interface Reply<T = Json> {
  status: number;
  ok: boolean;
  data?: T;
  error?: string;
}

async function call<T = Json>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  return { status: res.status, ok: !!j.ok, data: j.data, error: j.error };
}

let failures = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

interface Strat {
  id: string;
  name: string;
  isTest?: boolean;
  risk: Json;
  [k: string]: unknown;
}

async function main() {
  const health = await call<{ mode: string; liveTradingAllowed: boolean }>('GET', '/health');
  if (!health.ok) throw new Error(`Cannot reach ${base} (${health.error ?? health.status}).`);
  if (health.data?.mode !== 'paper') {
    throw new Error(`Refusing to seed: the server at ${base} is in "${health.data?.mode}" mode. Seed only a paper-mode sandbox.`);
  }
  const probe = await call('POST', '/inbox/_seed', { title: 'MT probe' });
  if (probe.status === 404) throw new Error('The server was not started with E2E_SEED=1, so the seed routes are off.');
  console.log(`Sandbox at ${base}: paper mode, seed routes on.\n`);

  // Clean up an earlier run of this script.
  const existing = (await call<Strat[]>('GET', '/strategies')).data ?? [];
  for (const s of existing.filter((x) => x.name.startsWith('MT '))) await call('DELETE', `/strategies/${s.id}`);

  console.log('1. Strategies');
  const make = async (preset: string, symbol: string, name: string) => {
    const r = await call<Strat>('POST', '/strategies', { preset, symbol, name });
    check(`created "${name}"`, r.ok, r.error);
    return r.data!;
  };
  const ema = await make('ema-pullback', 'EURUSD', 'MT EMA Pullback EURUSD');
  const macd = await make('macd-momentum', 'XAUUSD', 'MT MACD Momentum XAUUSD');
  const bb = await make('bollinger-fade', 'EURUSD', 'MT Bollinger Fade EURUSD');
  const rig = await make('order-test', 'EURUSD', 'MT Order Test rig');
  const scalp = await make('fast-scalp-test', 'BTCUSD', 'MT Live Scalp BTCUSD');
  check('the order test rig is marked as a test', rig.isTest === true);

  // The scalp is the one you will start by hand to watch paper trades. The presets close for the day at
  // 21:45 UTC and before the weekend, which would leave a sandbox bot idle at night and on Saturdays.
  const open = await call('PUT', `/strategies/${scalp.id}`, {
    risk: { ...scalp.risk, flatAtUTC: '23:59', flatBeforeWeekend: false, tradingDays: [0, 1, 2, 3, 4, 5, 6], maxLot: 0.1 },
  });
  check('scalp set to trade at any hour (sandbox only)', open.ok, open.error);

  console.log('\n2. Rules that must refuse a save');
  const refuse = async (label: string, edit: (risk: Json) => void, expect: RegExp) => {
    const risk = JSON.parse(JSON.stringify(ema.risk)) as Json;
    edit(risk);
    const { id: _id, ...rest } = ema;
    const r = await call('POST', '/strategies', { strategy: { ...rest, name: `MT refused ${label}`, risk } });
    check(`refused: ${label}`, !r.ok && r.status === 400 && expect.test(r.error ?? ''), r.error);
  };
  await refuse('no stop-loss', (r) => (r.slMode = 'none'), /No stop-loss/);
  await refuse('no take-profit', (r) => (r.tpMode = 'none'), /No take-profit/);
  await refuse('target smaller than 1.5 x stop', (r) => {
    r.slMode = 'atr';
    r.slAtrMult = 2;
    r.tpMode = 'atr';
    r.tpAtrMult = 1;
  }, /smaller than 1\.5/);

  console.log('\n3. Backtests (synthetic candles, so the numbers are repeatable only in shape, not digit for digit)');
  for (const s of [ema, macd, bb]) {
    const r = await call<{ metrics: { totalTrades: number; profitFactor: number; netProfit: number; maxDrawdownPct: number } }>('POST', '/backtest', { strategyId: s.id, bars: 3000 });
    const m = r.data?.metrics;
    check(`backtest ran: ${s.name}`, r.ok && !!m, m ? `${m.totalTrades} trades, profit factor ${m.profitFactor.toFixed(2)}, net ${m.netProfit.toFixed(2)}, drawdown ${m.maxDrawdownPct.toFixed(2)}%` : r.error);
  }

  console.log('\n4. Demo bots for the Testboard (trade history is seeded; no bot is running)');
  const demo = async (name: string, trades: number) => {
    const r = await call('POST', '/testboard/_seed', { name, trades });
    check(`${name}: ${trades} demo trades`, r.ok, r.error);
  };
  await demo('MT Demo 5 trades', 5);
  await demo('MT Demo 40 trades', 40);
  await demo('MT Demo 120 trades', 120);

  console.log('\n5. Inbox cards');
  for (const t of ['MT card A: losing streak on EMA Pullback', 'MT card B: bot stalled', 'MT card C: weekly summary']) {
    const r = await call('POST', '/inbox/_seed', { title: t });
    check(`card "${t}"`, r.ok, r.error);
  }

  console.log('\n6. Saved chats');
  const chat1 = await call('POST', '/chat/sessions/_seed', {
    messages: [
      { role: 'user', text: 'MT chat 1: why is the EMA Pullback quiet today?' },
      { role: 'agent', text: 'It has taken no trades: the flat window is closed and the spread was above the cap.' },
    ],
  });
  check('Agents-tab chat 1', chat1.ok, chat1.error);
  const chat2 = await call('POST', '/chat/sessions/_seed', {
    messages: [
      { role: 'user', text: 'MT chat 2: make all my strategies safer' },
      { role: 'agent', text: 'I would lower the daily loss limit on the gold strategy. No change is made until you approve.' },
    ],
  });
  check('Agents-tab chat 2', chat2.ok, chat2.error);
  const chat3 = await call('POST', '/chat/sessions/_seed', {
    strategyId: ema.id,
    messages: [
      { role: 'user', text: 'MT chat 3: is this strategy too risky?' },
      { role: 'agent', text: 'Not especially: it risks 0.5% a trade with a 3% daily cap.' },
    ],
  });
  check('chat 3 on the EMA Pullback strategy', chat3.ok, chat3.error);

  console.log('\n7. An idea from a competition');
  const idea = await call('POST', '/knowledge/competition', {
    competition: 'MT Cup',
    name: 'MT Asian range break',
    symbol: 'xauusd',
    entry: 'Buy the break of the Asian-session high once the London open candle closes above it.',
    sizing: '25% of equity',
  });
  check('idea saved', idea.ok, idea.error);

  console.log(`\n${failures === 0 ? 'Everything seeded.' : `${failures} step(s) failed. Read the FAIL lines above.`}`);
  console.log('Next: open the app on this sandbox server and follow part A of the manual test plan.');
  console.log('Start the live paper bot by hand: Strategies tab > the "MT Live Scalp BTCUSD" row > Start.');
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
