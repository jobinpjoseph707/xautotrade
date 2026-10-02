// server/src/engine/levels.ts
//
// Computes price levels and publishes them to the CSV that XATLevels.mq5 reads.
// The MT5 MCP bridge has no chart-object tools, so rendering is the EA's job;
// this module only ever writes a file.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * HLINE/TREND/RECT: the original EA kinds (TREND rays to the right).
 * SEG: a trend segment WITHOUT a ray — polyline pieces for indicator curves.
 * LABEL: a text row pinned to the chart's top-left corner; price1 = row index.
 * SEG and LABEL need XATLevels v2 (older EAs skip unknown kinds harmlessly).
 */
export type LevelKind = 'HLINE' | 'TREND' | 'RECT' | 'SEG' | 'LABEL';

export interface Level {
  symbol: string;
  kind: LevelKind;
  id: string;            // stable — same id overwrites, new id adds
  price1: number;
  time1?: number;        // epoch SECONDS (MQL5 datetime), omit for HLINE
  price2?: number;
  time2?: number;
  color?: string;        // 'Red' | 'Blue' | ... or 0xBBGGRR as decimal string
  width?: number;
  style?: number;        // 0 solid, 1 dash, 2 dot, 3 dashdot, 4 dashdotdot
  label?: string;
}

// Fixed path — same for every terminal instance, unlike MQL5\Files which sits
// behind a per-instance hash directory.
export const COMMON_FILES_DIR =
  process.env.MT5_COMMON_FILES ??
  path.join(os.homedir(), 'AppData', 'Roaming', 'MetaQuotes', 'Terminal', 'Common', 'Files');

export const LEVELS_FILE = process.env.MT5_LEVELS_FILE ?? 'xat_levels.csv';

const HEADER = 'symbol,kind,id,price1,time1,price2,time2,color,width,style,label';

// ---------------------------------------------------------------------------
// Candle normalisation
// ---------------------------------------------------------------------------

export interface Bar {
  time: number;   // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * FastMCP wraps list returns as { result: [...] }; dicts come through bare.
 * Timestamps arrive as ISO-8601 strings, NOT epoch seconds — Number(t) on
 * those yields NaN silently, which is the failure mode already logged in the
 * runbook. Handle both shapes.
 */
export function normaliseBars(raw: any): Bar[] {
  const rows: any[] = Array.isArray(raw) ? raw : (raw?.result ?? []);
  if (!Array.isArray(rows)) {
    throw new Error(`normaliseBars: expected array, got ${typeof rows}`);
  }

  return rows.map((r, i) => {
    const t = r.time;
    let epochSec: number;

    if (typeof t === 'number') {
      epochSec = t;                                  // already epoch seconds
    } else if (typeof t === 'string') {
      const ms = Date.parse(t);
      if (Number.isNaN(ms)) {
        throw new Error(`normaliseBars: unparseable time at row ${i}: ${t}`);
      }
      epochSec = Math.floor(ms / 1000);
    } else {
      throw new Error(`normaliseBars: missing time at row ${i}`);
    }

    const bar: Bar = {
      time: epochSec,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    };

    for (const k of ['open', 'high', 'low', 'close'] as const) {
      if (!Number.isFinite(bar[k])) {
        throw new Error(`normaliseBars: bad ${k} at row ${i}`);
      }
    }
    return bar;
  });
}

// ---------------------------------------------------------------------------
// Level computation
// ---------------------------------------------------------------------------

export interface RangeLevels {
  high: number;
  low: number;
  fromTime: number;
  toTime: number;
  barCount: number;
}

/** Highest high / lowest low across the supplied completed bars. */
export function rangeOf(bars: Bar[]): RangeLevels {
  if (bars.length === 0) throw new Error('rangeOf: no bars');

  let high = -Infinity;
  let low = Infinity;
  let fromTime = Infinity;
  let toTime = -Infinity;

  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    if (b.time < fromTime) fromTime = b.time;
    if (b.time > toTime) toTime = b.time;
  }

  return { high, low, fromTime, toTime, barCount: bars.length };
}

/**
 * Last N minutes of resistance/support on a given timeframe.
 *
 * IMPORTANT: pass bars fetched with start_pos = 1, not 0. Position 0 is the
 * forming bar, whose high/low are still moving; including it makes the level
 * jitter and breaks parity with the backtester, which only ever reads
 * completed bars.
 */
export function levelsFromRange(
  symbol: string,
  bars: Bar[],
  opts: { idPrefix?: string; label?: string } = {}
): Level[] {
  const r = rangeOf(bars);
  const prefix = opts.idPrefix ?? 'rng';
  const label = opts.label ?? `${symbol} range`;

  return [
    {
      symbol,
      kind: 'HLINE',
      id: `${prefix}_res`,
      price1: r.high,
      color: 'Red',
      width: 2,
      style: 0,
      label: `${label} — resistance`,
    },
    {
      symbol,
      kind: 'HLINE',
      id: `${prefix}_sup`,
      price1: r.low,
      color: 'Green',
      width: 2,
      style: 0,
      label: `${label} — support`,
    },
  ];
}

/** How many M-timeframe bars cover the last `minutes`. */
export function barsForMinutes(minutes: number, timeframeMinutes: number): number {
  if (timeframeMinutes <= 0) throw new Error('timeframeMinutes must be > 0');
  return Math.max(1, Math.ceil(minutes / timeframeMinutes));
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function csvEscape(s: string): string {
  // Commas and newlines would corrupt the row; the EA splits naively on ','.
  return s.replace(/[\r\n,]/g, ' ').trim();
}

export function serialise(levels: Level[]): string {
  const rows = levels.map(l =>
    [
      csvEscape(l.symbol),
      l.kind,
      csvEscape(l.id),
      l.price1,
      l.time1 ?? '',
      l.price2 ?? '',
      l.time2 ?? '',
      l.color ?? 'Red',
      l.width ?? 1,
      l.style ?? 0,
      csvEscape(l.label ?? l.id),
    ].join(',')
  );

  return [
    `# generated ${new Date().toISOString()}`,
    HEADER,
    ...rows,
    '',
  ].join('\n');
}

/**
 * Who contributed which levels.
 *
 * There is one file and the EA reads all of it, so a second writer would wipe
 * the first. Keeping levels per source and publishing the union means a bot on
 * GBPUSD and a bot on XAUUSD can both draw, and a manual publish doesn't erase
 * either of them.
 */
const sources = new Map<string, Level[]>();

/** Replace one source's levels and rewrite the file as the union of all. */
export async function publishFromSource(
  sourceId: string,
  levels: Level[],
): Promise<{ file: string; count: number }> {
  if (levels.length === 0) sources.delete(sourceId);
  else sources.set(sourceId, levels);

  const merged: Level[] = [];
  const seen = new Set<string>();
  for (const list of sources.values()) {
    for (const l of list) {
      // Ids are the EA's object keys — a duplicate would just overwrite itself.
      const key = `${l.symbol}:${l.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(l);
    }
  }
  return publishLevels(merged);
}

/** Forget a source entirely, e.g. when its bot stops. */
export async function clearSource(sourceId: string): Promise<void> {
  if (!sources.has(sourceId)) return;
  await publishFromSource(sourceId, []);
}

export function listSources(): { sourceId: string; count: number }[] {
  return [...sources.entries()].map(([sourceId, l]) => ({ sourceId, count: l.length }));
}

/**
 * Write via temp file + rename. The EA polls on a timer and could otherwise
 * read a half-written file; rename is atomic within the same directory.
 */
export async function publishLevels(levels: Level[]): Promise<{ file: string; count: number }> {
  await fs.mkdir(COMMON_FILES_DIR, { recursive: true });

  const target = path.join(COMMON_FILES_DIR, LEVELS_FILE);
  const tmp = path.join(COMMON_FILES_DIR, `.${LEVELS_FILE}.tmp`);

  await fs.writeFile(tmp, serialise(levels), 'ascii');
  await fs.rename(tmp, target);

  return { file: target, count: levels.length };
}

export async function clearLevels(): Promise<void> {
  await publishLevels([]);
}

/** Read back what is currently published — useful for a status endpoint. */
export async function readPublished(): Promise<string> {
  const target = path.join(COMMON_FILES_DIR, LEVELS_FILE);
  try {
    return await fs.readFile(target, 'ascii');
  } catch {
    return '';
  }
}
