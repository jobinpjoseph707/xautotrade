/**
 * Rule-based strategy extraction from a transcript. Deterministic and
 * conservative: it only emits a rule when the transcript states concrete
 * numbers/indicators, and records a Gap for everything it could not pin down.
 */
import type { Timeframe } from '../engine/types.js';

export type Side = 'long' | 'short';
export type Cmp = 'gt' | 'lt' | 'crossesAbove' | 'crossesBelow';

export type ExtractedCondition =
  | { kind: 'rsi'; period: number | null; cmp: Cmp; value: number; evidence: string }
  | { kind: 'priceVsMa'; ma: 'sma' | 'ema' | 'wma'; period: number; cmp: 'gt' | 'lt'; evidence: string }
  | { kind: 'maCross'; ma: 'sma' | 'ema' | 'wma'; fast: number; slow: number; cmp: 'crossesAbove' | 'crossesBelow'; evidence: string }
  | { kind: 'macdCross'; params: { fast: number; slow: number; signal: number } | null; cmp: 'crossesAbove' | 'crossesBelow'; evidence: string }
  | { kind: 'bbandsBreak'; period: number | null; mult: number | null; band: 'lower' | 'upper'; cmp: 'gt' | 'lt'; evidence: string }
  | { kind: 'unsupported'; name: string; evidence: string };

export interface Gap {
  /** blocking = no config is produced until resolved; assumed = a stated default was applied. */
  severity: 'blocking' | 'assumed';
  code: string;
  message: string;
  evidence?: string;
}

export type Distance = { value: number; unit: 'percent' | 'points' | 'pips' };

export interface ExtractedStrategy {
  timeframes: Timeframe[];
  entryLong: ExtractedCondition[][];
  entryShort: ExtractedCondition[][];
  exitLong: ExtractedCondition[][];
  exitShort: ExtractedCondition[][];
  stopLoss: Distance | null;
  takeProfit: Distance | null;
  rewardRisk: number | null;
  riskPerTradePct: number | null;
  gaps: Gap[];
}

const NUM_WORDS: Record<string, number> = { one: 1, four: 4, five: 5, ten: 10, fifteen: 15, thirty: 30 };
const num = (s: string): number => (s in NUM_WORDS ? NUM_WORDS[s] : Number(s));

const UNSUPPORTED = [
  'ichimoku', 'vwap', 'supertrend', 'fibonacci', 'fib retracement', 'parabolic sar', 'psar', 'williams %r',
  'on balance volume', 'obv', 'pivot points', 'keltner', 'donchian', 'volume profile', 'order block',
  'fair value gap', 'support and resistance', 'supply and demand', 'trendline', 'trend line',
  'candlestick pattern', 'engulfing', 'head and shoulders',
];

const VAGUE = [
  'looks strong', 'looks good', 'feels right', 'feels strong', 'good setup', 'when it looks', 'gut', 'confirmation',
  'when you see', 'strong momentum', 'momentum is there', 'ready to move', 'price action', 'when the market is ready',
  'looks like it', 'once it looks', 'trust your',
];

const MA_NAME = '(ema|sma|wma|exponential moving average|simple moving average|moving average)';
const PERIOD = '(?:-|\\s)?(?:period|day|bar)?\\s*';

function maType(s: string): 'sma' | 'ema' | 'wma' {
  if (s.startsWith('ema') || s.startsWith('exponential')) return 'ema';
  if (s.startsWith('wma')) return 'wma';
  return 'sma';
}

const cmpFrom = (w: string): Cmp => {
  const above = /above|over|greater|rises?|rising|higher/.test(w);
  if (/cross/.test(w)) return above ? 'crossesAbove' : 'crossesBelow';
  return above ? 'gt' : 'lt';
};

function detectTimeframes(text: string): Timeframe[] {
  const found = new Set<Timeframe>();
  for (const m of text.matchAll(/\b(one|five|ten|fifteen|thirty|\d+)[\s-]*(?:minute|min)s?\b/g)) {
    const tf = ({ 1: '1m', 5: '5m', 15: '15m', 30: '30m' } as Record<number, Timeframe>)[num(m[1])];
    if (tf) found.add(tf);
  }
  for (const m of text.matchAll(/\b(one|four|\d+)[\s-]*hours?\b/g)) {
    const n = num(m[1]);
    if (n === 1) found.add('1h');
    if (n === 4) found.add('4h');
  }
  if (/\bhourly\b|\bh1\b/.test(text)) found.add('1h');
  if (/\bdaily (?:chart|timeframe)|\bday chart|\bd1\b|\bdaily\b/.test(text)) found.add('1d');
  return [...found];
}

function sideOf(sentence: string): Side | null {
  const buy = sentence.search(/\b(buy|buying|long|go long|enter long)\b/);
  const sell = sentence.search(/\b(sell|selling|short|go short|enter short)\b/);
  if (buy < 0 && sell < 0) return null;
  if (buy >= 0 && (sell < 0 || buy < sell)) return 'long';
  return 'short';
}

function conditionsIn(sentence: string): ExtractedCondition[] {
  const out: ExtractedCondition[] = [];
  const ev = sentence.trim();

  // RSI <cmp> N   (period from "RSI(14)", "14 period RSI", "RSI period 14")
  const rsiRe = /\brsi\b[^.]*?\b(crosses? above|crossing above|crosses? below|crossing below|drops? below|falls? below|below|under|less than|rises? above|above|over|greater than)\s+(?:the\s+)?(\d{1,3})\b/g;
  for (const m of sentence.matchAll(rsiRe)) {
    const pre = sentence.slice(Math.max(0, m.index! - 20), m.index! + m[0].length);
    const pm =
      pre.match(/rsi\s*\(\s*(\d{1,3})\s*\)/) ??
      pre.match(/rsi[^.]{0,12}?(?:period|length)\s*(?:of\s*)?(\d{1,3})/) ??
      pre.match(/(\d{1,3})[\s-]*(?:period|day|bar)?[\s-]*rsi/);
    out.push({ kind: 'rsi', period: pm ? Number(pm[1]) : null, cmp: cmpFrom(m[1]), value: Number(m[2]), evidence: ev });
  }

  // MA crossover: "9 ema crosses above the 21 ema"
  const cross = new RegExp(`(\\d+)${PERIOD}${MA_NAME}\\s+(?:line\\s+)?(?:crosses?|crossing)\\s+(above|over|below|under)\\s+(?:the\\s+)?(\\d+)${PERIOD}${MA_NAME}`, 'g');
  for (const m of sentence.matchAll(cross)) {
    out.push({
      kind: 'maCross', ma: maType(m[2]), fast: Number(m[1]), slow: Number(m[4]),
      cmp: /above|over/.test(m[3]) ? 'crossesAbove' : 'crossesBelow', evidence: ev,
    });
  }

  // Price vs MA: "price closes above the 200 ema"
  const pvm = new RegExp(`\\b(?:price|close|candle)s?\\s+(?:closes?|is|trades?|stays?|remains?)?\\s*(above|below|over|under)\\s+(?:the\\s+)?(\\d+)${PERIOD}${MA_NAME}`, 'g');
  for (const m of sentence.matchAll(pvm)) {
    out.push({ kind: 'priceVsMa', ma: maType(m[3]), period: Number(m[2]), cmp: /above|over/.test(m[1]) ? 'gt' : 'lt', evidence: ev });
  }

  // MACD crossing its signal line
  const macd = sentence.match(/\bmacd\b[^.]*?(?:crosses?|crossing)\s+(above|over|below|under)\s+(?:the\s+)?signal/);
  if (macd) {
    const p = sentence.match(/macd\s*\(?\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*\)?/);
    out.push({
      kind: 'macdCross',
      params: p ? { fast: Number(p[1]), slow: Number(p[2]), signal: Number(p[3]) } : null,
      cmp: /above|over/.test(macd[1]) ? 'crossesAbove' : 'crossesBelow',
      evidence: ev,
    });
  }

  // Bollinger band break
  const bb = sentence.match(/\b(?:price|close|candle)s?\s+(?:closes?|touches?|falls?|drops?|breaks?|is)?\s*(below|under|above|over)\s+(?:the\s+)?(lower|upper)\s+(?:bollinger\s+)?band/);
  if (bb) {
    const bp = sentence.match(/bollinger(?:\s+bands?)?\s*\(?\s*(\d+)\s*[, ]?\s*(\d+(?:\.\d+)?)?\s*\)?/);
    out.push({
      kind: 'bbandsBreak', period: bp ? Number(bp[1]) : null, mult: bp && bp[2] ? Number(bp[2]) : null,
      band: bb[2] as 'lower' | 'upper', cmp: /above|over/.test(bb[1]) ? 'gt' : 'lt', evidence: ev,
    });
  }

  // Indicators the engine does not implement, used inside a rule.
  for (const name of UNSUPPORTED) {
    if (sentence.includes(name)) out.push({ kind: 'unsupported', name, evidence: ev });
  }
  return out;
}

function unitOf(u: string): Distance['unit'] {
  if (u.startsWith('pip')) return 'pips';
  if (u.startsWith('point')) return 'points';
  return 'percent';
}

export function extractStrategy(transcript: string): ExtractedStrategy {
  const text = transcript.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  const sentences = text.split(/[.!?;\n]+/).map((s) => s.trim()).filter(Boolean);

  const res: ExtractedStrategy = {
    timeframes: detectTimeframes(text),
    entryLong: [], entryShort: [], exitLong: [], exitShort: [],
    stopLoss: null, takeProfit: null, rewardRisk: null, riskPerTradePct: null,
    gaps: [],
  };
  const gap = (g: Gap) => res.gaps.push(g);

  for (const s of sentences) {
    const sl =
      s.match(/(\d+(?:\.\d+)?)\s*(%|percent|pips?|points?)\s+(?:stop[\s-]*loss|stop)\b/) ??
      s.match(/stop[\s-]*loss\s*(?:of|at|is|to|around|about|set at|placed at)?\s*(\d+(?:\.\d+)?)\s*(%|percent|pips?|points?)/);
    if (sl && !res.stopLoss) res.stopLoss = { value: Number(sl[1]), unit: unitOf(sl[2]) };
    const tp =
      s.match(/(\d+(?:\.\d+)?)\s*(%|percent|pips?|points?)\s+(?:take[\s-]*profit|profit target)\b/) ??
      s.match(/(?:take[\s-]*profit|profit target|target)\s*(?:of|at|is|to|around|about|set at)?\s*(\d+(?:\.\d+)?)\s*(%|percent|pips?|points?)/);
    if (tp && !res.takeProfit) res.takeProfit = { value: Number(tp[1]), unit: unitOf(tp[2]) };
    const rr = s.match(/(?:risk[\s-]*(?:to[\s-]*)?reward|\brr\b|r:r)\D{0,20}1\s*(?::|to)\s*(\d+(?:\.\d+)?)/);
    if (rr && res.rewardRisk == null) res.rewardRisk = Number(rr[1]);
    const rk = s.match(/\brisk(?:ing)?\s+(?:only\s+|just\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent)/);
    if (rk && res.riskPerTradePct == null) res.riskPerTradePct = Number(rk[1]);

    const isExit = /\b(exit|close (?:the )?(?:trade|position|long|short)|take profit when|get out)\b/.test(s);
    const conds = conditionsIn(s);
    const tradeVerb = /\b(buy|buying|sell|selling|long|short|enter|entry|exit|open|close)\b/.test(s);
    const side = sideOf(s);

    if (conds.length > 0) {
      if (!side) {
        gap({ severity: 'blocking', code: 'NO_DIRECTION', message: 'A rule has conditions but no stated buy/sell direction.', evidence: s });
        continue;
      }
      if (isExit) (side === 'long' ? res.exitLong : res.exitShort).push(conds);
      else (side === 'long' ? res.entryLong : res.entryShort).push(conds);
    } else if (tradeVerb && VAGUE.some((v) => s.includes(v))) {
      gap({ severity: 'blocking', code: 'VAGUE_RULE', message: 'A rule is too vague to encode (no indicator or number).', evidence: s });
    }
  }

  if (res.timeframes.length === 0) {
    gap({ severity: 'blocking', code: 'NO_TIMEFRAME', message: 'No timeframe is stated. Supply one via the mapping options.' });
  } else if (res.timeframes.length > 1) {
    gap({ severity: 'blocking', code: 'MULTIPLE_TIMEFRAMES', message: `Several timeframes mentioned (${res.timeframes.join(', ')}); pick one via the mapping options.` });
  }
  if (res.entryLong.length === 0 && res.entryShort.length === 0) {
    gap({ severity: 'blocking', code: 'NO_ENTRY_RULE', message: 'No concrete entry rule (indicator + threshold/cross) was found.' });
  }
  if (!res.stopLoss) {
    gap({ severity: 'assumed', code: 'NO_STOP_LOSS', message: 'No stop-loss stated; the engine default stop will be applied. Review before use.' });
  }
  return res;
}
