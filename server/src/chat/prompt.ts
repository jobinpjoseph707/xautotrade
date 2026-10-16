import type { Strategy } from '../engine/types.js';
import type { AgentDef } from './agents.js';

export interface ChatTurn {
  role: 'user' | 'agent';
  text: string;
}

/** Just the bot fields an agent needs; keeps the prompt small. */
export interface BotInfo {
  strategyId: string;
  status: string;
  tradesToday: number;
  realisedToday: number;
  openPositions: number;
  blockedReason: string | null;
  error: string | null;
}

/** Result of a server-side backtest on recent broker candles (or why it could not run). */
export interface BacktestInfo {
  strategyId: string;
  bars?: number;
  trades?: number;
  netProfitPct?: number;
  winRatePct?: number;
  profitFactor?: number;
  maxDrawdownPct?: number;
  avgWin?: number;
  avgLoss?: number;
  error?: string;
}

export interface LogInfo {
  ts: number;
  level: string;
  strategyId: string | null;
  message: string;
}

const FORMAT_REFERENCE = `
STRATEGY FORMAT (JSON)
{
  "name": string, "symbol": "XAUUSD", "timeframe": "1m"|"5m"|"15m"|"30m"|"1h"|"4h"|"1d",
  "indicators": [{ "id": "ema_fast", "type": "sma|ema|wma|rsi|atr|macd|bbands|stoch|adx|cci", "source": "close", "params": { "period": 9 } }],
  "entryLong":  { "logic": "AND"|"OR", "conditions": [Condition, ...] },
  "entryShort": { "logic": "AND"|"OR", "conditions": [Condition, ...] },
  "exitLong": optional RuleGroup, "exitShort": optional RuleGroup,
  "risk": RiskConfig (partial allowed; missing fields use safe defaults)
}
Condition = { "left": Operand, "op": "gt|lt|gte|lte|crossesAbove|crossesBelow|risingFor|fallingFor", "right": Operand }
Operand = { "kind":"indicator","id":"ema_fast","line":"value","shift":0 } | { "kind":"price","field":"open|high|low|close|hl2|hlc3|ohlc4","shift":0 } | { "kind":"const","value":30 } | { "kind":"spread" } | { "kind":"hourUTC" }
Indicator params: sma/ema/wma/rsi/atr/cci {period}; macd {fast,slow,signal} lines value|signal|hist; bbands {period,mult} lines upper|middle|lower; stoch {kPeriod,dPeriod,slowing} lines k|d; adx {period} lines adx|plusDI|minusDI.
An indicator's default line is "value". Empty entry conditions mean that side never trades.
RiskConfig fields: lotMode "fixed"|"percentRisk", fixedLot, riskPercent, slMode "points"|"atr"|"none", slPoints, slAtrMult, tpMode "points"|"atr"|"rr"|"none", tpPoints, tpAtrMult, tpRR, atrIndicatorId (needed for atr stops), trailingEnabled, trailingStartPoints, trailingStepPoints, breakEvenPoints, maxSpreadPoints (0 = off), maxOpenPositions, maxDailyLossPercent, maxDailyTrades, cooldownBars, sessions [{startHour,endHour}] in UTC (empty = always), tradingDays [0-6, 0=Sun] (empty = all), closeOnOppositeSignal.
Points are the broker's smallest price step (XAUUSD: 0.01 => 100 points = $1.00; EURUSD: 0.00001 => 10 points = 1 pip). Signals are evaluated on completed bars; a 1m strategy can trade at most about once per 1-3 minutes.
`;

const OUTPUT_RULES = `
HOW YOU ACT
You cannot run anything yourself. You may only PROPOSE actions; the user reviews and approves each one in the app, so propose exactly what you want done.
Write a short, plain reply first (what you did/found and why, in a few sentences). Then, only if you want to change something, add ONE fenced block:

\`\`\`xat-actions
[
  { "type": "create_strategy", "reason": "...", "strategy": { ...full strategy... } },
  { "type": "update_strategy", "id": "<existing id>", "reason": "...", "changes": { "risk": { "slPoints": 80 } } },
  { "type": "delete_strategy", "id": "<existing id>", "reason": "..." },
  { "type": "start_bot", "id": "<existing id>" },
  { "type": "stop_bot", "id": "<existing id>" }
]
\`\`\`

To TEST a change before proposing it, use a what-if block instead (only if your role allows update_strategy):

\`\`\`xat-whatif
{ "id": "<existing id>", "reason": "...", "changes": { "risk": { "slPoints": 250 } } }
\`\`\`

The server backtests the strategy as it is and with your change, then shows the user both sets of numbers next to a one-tap proposal. Use at most one what-if per message. A change that breaks the safety rules is refused and you are not shown why, so keep stop-loss and take-profit set and the target at least 1.5 times the stop.

Only use action types your role allows. "changes" contains only the fields to change (risk is merged field by field; other fields such as indicators or entry rules are replaced whole, so include the full new value). Use existing ids exactly as listed. Valid JSON only inside the block. If you are only answering a question, include no block.
This is a DEMO trading platform for testing. Never promise profits. Be honest when there is not enough data to judge a strategy.
`;

const APP_OVERVIEW = `
APP OVERVIEW (for when the user asks what this app does, what's in it, or how to use it)
XAutoTrade is an algo-trading desk that runs rule-based bots on MetaTrader 5. Its tabs:
- Dashboard: account balance/equity, running bots, today's realised P&L and trade count, a Stop-all switch.
- Journal: every trade any bot has taken — bot, symbol, side, lots, entry/exit, stop-loss, take-profit, how it closed, P&L — filterable by result (win/loss/breakeven/open), period, bot, symbol, and exportable as CSV.
- Strategies: the list of trading strategies (rules + risk settings), each can be backtested or started/stopped as a bot.
- Agents: this chat — five assistant agents (Strategist creates strategies, Optimizer tunes them, Strategy Doctor diagnoses and can stop/delete, Risk Guard only tightens risk, Critic argues against proposals before approval) plus a Learning panel showing which agents/changes have actually helped.
- Inbox: everything that needs the owner (proposals to approve, errors, losing streaks).
- Testboard: which stage each strategy has reached.
- Settings: server connection and account info, log out.
Nothing an agent proposes here takes effect until the user taps Approve.
`;

function compactStrategy(s: Strategy): unknown {
  return { id: s.id, name: s.name, symbol: s.symbol, timeframe: s.timeframe, indicators: s.indicators, entryLong: s.entryLong, entryShort: s.entryShort, exitLong: s.exitLong, exitShort: s.exitShort, risk: s.risk };
}

export function buildPrompt(args: {
  agent: AgentDef;
  message: string;
  history: ChatTurn[];
  strategies: Strategy[];
  bots: BotInfo[];
  issues: LogInfo[];
  backtests?: BacktestInfo[];
  /** Proven lessons from this agent's notebook. */
  notebook?: string[];
  /** Recent approved changes and how they turned out. */
  outcomes?: string[];
  /** When set, this chat is about this one strategy only. */
  focus?: Strategy;
}): string {
  const { agent, message, history, strategies, bots, issues, backtests, notebook, outcomes, focus } = args;
  const parts: string[] = [];
  parts.push(`You are "${agent.name}", one of five assistant agents inside the XAutoTrade app (Strategist, Optimizer, Strategy Doctor, Risk Guard, Critic).`);
  parts.push(`YOUR ROLE\n${agent.role}\nActions you may propose: ${agent.allowed.join(', ')}.`);
  parts.push(APP_OVERVIEW.trim());
  parts.push(FORMAT_REFERENCE.trim());
  parts.push(OUTPUT_RULES.trim());
  parts.push(
    'HOW PROPOSALS ARE CHECKED\nBefore the user sees an update you propose, the server backtests it against an OLDER time window you were never shown. ' +
      'Updates that do worse there are held back automatically, and a Critic agent reviews the rest. So prefer one small, well-reasoned change over many, and do not tune to the exact numbers in the recent backtest.',
  );
  if (notebook && notebook.length) {
    parts.push(`YOUR NOTEBOOK (proven lessons from past approved changes and how they actually turned out; follow them unless the user explicitly overrides)\n${notebook.map((l) => `- ${l}`).join('\n')}`);
  }
  if (outcomes && outcomes.length) {
    parts.push(`RECENT CHANGES AND THEIR OUTCOMES (newest first)\n${outcomes.map((l) => `- ${l}`).join('\n')}`);
  }

  if (focus) {
    parts.push(`THIS CHAT IS ABOUT ONE STRATEGY: "${focus.name}" (${focus.id}). Only that strategy is shown below. Do not discuss or change any other strategy.`);
  }
  parts.push(
    strategies.length
      ? `CURRENT STRATEGIES (${strategies.length})\n${JSON.stringify(strategies.map(compactStrategy))}`
      : 'CURRENT STRATEGIES\nNone yet.',
  );
  parts.push(bots.length ? `BOTS\n${JSON.stringify(bots)}` : 'BOTS\nNone running.');
  if (backtests && backtests.length) {
    parts.push(
      'BACKTEST RESULTS (just run by the server on recent broker candles, 10000 starting balance, spread/slippage/commission included; past results do not predict future ones; fewer than ~30 trades is weak evidence)\n' +
        JSON.stringify(backtests),
    );
  }
  if (issues.length) {
    parts.push(
      'RECENT WARNINGS AND ERRORS (newest first)\n' +
        issues.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.strategyId ?? '-'}: ${l.message.slice(0, 220)}`).join('\n'),
    );
  }
  if (history.length) {
    parts.push('CONVERSATION SO FAR\n' + history.slice(-10).map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text.slice(0, 1500)}`).join('\n'));
  }
  parts.push(`USER'S NEW MESSAGE\n${message}`);
  return parts.join('\n\n');
}
