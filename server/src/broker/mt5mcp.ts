/**
 * MT5-via-MCP adapter — EXPERIMENTAL.
 *
 * Talks to a locally-running MetaTrader 5 desktop terminal through the
 * community "mcp-metatrader5-server" (a FastMCP wrapper around the official
 * `MetaTrader5` Python package's COM API: https://github.com/Qoyyuum/mcp-metatrader5-server).
 * This is the free/self-hosted alternative to the MetaApi cloud bridge: no
 * subscription, but YOUR machine has to run MT5 desktop and this Python
 * server continuously — see server/README-mt5mcp.md for the Windows-side setup.
 *
 * Honesty about the state of this file: the MCP wrapper is new (weeks old at
 * the time this was written) and its tool schemas are only partially
 * documented. The tool names and field names below come from the underlying
 * `MetaTrader5` Python package's well-established API (order_send, positions_get,
 * copy_rates_from_pos, etc. have been stable for years), but the exact way the
 * MCP wrapper exposes them was not something that could be verified against a
 * live server from this environment — there's no Windows machine or MT5
 * terminal here to test against. `connect()` logs the server's real tool list
 * the first time it runs specifically so a mismatch is fast to spot and fix.
 *
 * Every call that talks to the tool server goes through `callTool()`, which
 * gives one place to fix a field name if the real server disagrees with the
 * assumption made here.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { Candle, SymbolSpec, Timeframe } from '../engine/types.js';
import { estimateServerOffset } from '../live/daily.js';
import type {
  AccountInfo,
  Broker,
  BrokerPosition,
  MarketStatus,
  OpenOrderRequest,
  PositionHistory,
  Quote,
} from './types.js';

// MT5 Python API timeframe constants (stable, documented for years —
// https://www.mql5.com/en/docs/python_metatrader5/mt5copyratesfrom_py).
const TF_TO_MT5: Record<Timeframe, number> = {
  '1m': 1, // TIMEFRAME_M1
  '5m': 5, // TIMEFRAME_M5
  '15m': 15, // TIMEFRAME_M15
  '30m': 30, // TIMEFRAME_M30
  '1h': 16385, // TIMEFRAME_H1  (0x4000 | 1)
  '4h': 16388, // TIMEFRAME_H4  (0x4000 | 4)
  '1d': 16408, // TIMEFRAME_D1  (0x4000 | 24)
};

// MT5 trade constants.
const TRADE_ACTION_DEAL = 1;
const TRADE_ACTION_SLTP = 6;
const ORDER_TYPE_BUY = 0;
const ORDER_TYPE_SELL = 1;
const ORDER_TIME_GTC = 0;
const TRADE_RETCODE_DONE = 10009;
const TRADE_RETCODE_PLACED = 10008;
const TRADE_RETCODE_DONE_PARTIAL = 10010;
/**
 * Retcodes that mean the request succeeded.
 *
 * 0 is in here deliberately. MetaQuotes-Demo returns `retcode: 0` with a real
 * deal ticket and comment "Done" — the trade executed. The community bridge
 * treats 0 as unknown and raises, so a genuinely filled order surfaces to us
 * as an error. Never treat that as "nothing happened".
 */
const SUCCESS_RETCODES = new Set([0, TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE, TRADE_RETCODE_DONE_PARTIAL]);

/**
 * Thrown when the broker isn't quoting — market closed, weekend, or the
 * instrument's daily maintenance break. This is a normal, expected condition,
 * not a fault: the runner reports it as "waiting" rather than an error, and
 * doesn't treat it as a reason to stop the bot.
 */
export class MarketClosedError extends Error {
  readonly marketClosed = true;
  constructor(message: string) {
    super(message);
    this.name = 'MarketClosedError';
  }
}

/** Plain-English meanings for the retcodes worth explaining. */
const RETCODE_MESSAGES: Record<number, string> = {
  10004: 'Requote — the price moved before the order reached the broker.',
  10006: 'The broker rejected the request.',
  10013: 'Invalid request — a field the broker did not accept.',
  10014: 'Invalid volume — check lot size against the symbol’s min/max/step.',
  10015: 'Invalid price.',
  10016: 'Invalid stops — the stop or target is too close to the current price.',
  10018: 'The market for this symbol is closed.',
  10019: 'Not enough money in the account for this trade size.',
  10021: 'No prices — the broker is not quoting this symbol right now. Usually the market is closed, or the instrument is in its daily maintenance break.',
  10030: 'Unsupported filling mode for this symbol — retrying with one the symbol allows.',
};

/** Retcodes that mean "not now", rather than "something is wrong". */
const MARKET_CLOSED_RETCODES = new Set([10018, 10021]);

function describeRetcode(retcode: number, brokerComment?: string): string {
  const known = RETCODE_MESSAGES[retcode];
  const suffix = brokerComment ? ` Broker said: "${brokerComment}".` : '';
  return known ? `${known}${suffix}` : `Broker returned retcode ${retcode}.${suffix}`;
}

/** Does this error text indicate the broker simply isn't quoting? */
function looksMarketClosed(text: string): boolean {
  return /PRICE_OFF|No prices|MARKET_CLOSED|market is closed|10021|10018/i.test(text);
}

export interface Mt5McpOptions {
  /**
   * How to reach the bridge.
   *
   * 'stdio' (the default and the mode this Python server is actually built
   * for) spawns it as a child process of this server and talks over pipes —
   * no extra terminal window, no port, no URL. 'http' is only useful if you
   * are running the bridge on a different machine and have got its HTTP
   * transport working, which is not reliable in current releases.
   */
  transport?: 'stdio' | 'http';
  /** Streamable-HTTP endpoint — only used when transport is 'http'. */
  url?: string;
  /** Executable to spawn for stdio transport. Default: uvx. */
  command?: string;
  /** Arguments for that executable. */
  args?: string[];
  /**
   * Full path to terminal64.exe. Only needed if the bridge cannot attach to an
   * already-running terminal — normally leave this unset.
   */
  terminalPath?: string;
  /** Optional MT5 login — leave unset if you log into the terminal by hand. */
  login?: string;
  password?: string;
  server?: string;
  /**
   * Force one filling mode instead of detecting it per symbol. Leave unset:
   * the adapter reads each symbol's own mask and adapts, which is what a
   * broker that differs between instruments requires.
   */
  fillMode?: 'ioc' | 'fok' | 'return';
  /** Slippage allowance in points for market orders. */
  deviationPoints?: number;
}

/** Stamped on every order so this app's trades are identifiable in MT5's log. */
const MAGIC = 20260816;

const DEFAULT_COMMAND = 'uvx';
const DEFAULT_ARGS = ['--from', 'mcp-metatrader5-server', 'mt5mcp'];

/**
 * ORDER_TYPE_FILLING values passed as `type_filling` on an order.
 * These are NOT the same numbers as the symbol's SYMBOL_FILLING_* bitmask.
 */
const ORDER_FILLING = { fok: 0, ioc: 1, return: 2 } as const;
const FILL_MODE: Record<string, number> = ORDER_FILLING;

/** Bits in a symbol's `filling_mode` mask, saying which modes it permits. */
const SYMBOL_FILLING_FOK = 1;
const SYMBOL_FILLING_IOC = 2;

/**
 * Which filling modes this symbol accepts, best first.
 *
 * Brokers vary per instrument — the same account took IOC on XAUUSD and
 * rejected it on GBPUSD with retcode 10030. The symbol's own mask says what is
 * allowed, so read it rather than making the user guess in a config file.
 * Falls back to trying everything when the broker doesn't report a mask.
 */
function fillingCandidates(mask: number | null): number[] {
  if (mask == null || mask <= 0) return [ORDER_FILLING.ioc, ORDER_FILLING.fok, ORDER_FILLING.return];

  const allowed: number[] = [];
  // IOC first: a partial fill beats an outright rejection on a market order.
  if (mask & SYMBOL_FILLING_IOC) allowed.push(ORDER_FILLING.ioc);
  if (mask & SYMBOL_FILLING_FOK) allowed.push(ORDER_FILLING.fok);
  // RETURN is not in the mask but is accepted by some brokers; keep it last.
  allowed.push(ORDER_FILLING.return);
  return allowed;
}

export class Mt5McpBroker implements Broker {
  readonly kind = 'mt5mcp' as const;

  private client: Client | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private loggedTools = false;
  private specCache = new Map<string, { spec: SymbolSpec; at: number }>();
  /** Symbol -> SYMBOL_FILLING_* bitmask, and the mode last known to work. */
  private fillingMask = new Map<string, number | null>();
  private fillingThatWorked = new Map<string, number>();
  private symbolsCache: { list: string[]; at: number } | null = null;

  constructor(private opts: Mt5McpOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client({ name: 'xautotrade-server', version: '0.1.0' });
      const useHttp = this.opts.transport === 'http';

      const command = this.opts.command ?? DEFAULT_COMMAND;
      const args = this.opts.args ?? DEFAULT_ARGS;

      const transport = useHttp
        ? new StreamableHTTPClientTransport(new URL(this.opts.url ?? 'http://127.0.0.1:8000/mcp'))
        : new StdioClientTransport({
            command,
            args,
            // Let the Python server's own logs and banner reach our console —
            // in stdio mode FastMCP logs to stderr, so this cannot corrupt the
            // JSON-RPC stream on stdout.
            stderr: 'inherit',
          });

      if (!useHttp) {
        // eslint-disable-next-line no-console
        console.log(`[mt5mcp] Launching bridge: ${command} ${args.join(' ')}`);
      }

      try {
        await client.connect(transport);
      } catch (err) {
        throw new Error(
          useHttp
            ? `Could not reach the MT5 MCP server at ${this.opts.url}. Is it running on that address? ` +
              `Original error: ${errMsg(err)}`
            : `Could not start the MT5 bridge with "${command} ${args.join(' ')}". ` +
              `Check that ${command} is installed and on this machine's PATH (try running that ` +
              `exact command yourself in a terminal), and that MetaTrader 5 desktop is open and ` +
              `logged in. Original error: ${errMsg(err)}`,
        );
      }

      if (!this.loggedTools) {
        try {
          const { tools } = await client.listTools();
          // eslint-disable-next-line no-console
          console.log(
            `[mt5mcp] Connected. Server exposes ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`,
          );
        } catch {
          /* non-fatal — just a diagnostic aid */
        }
        this.loggedTools = true;
      }

      this.client = client;

      // This bridge's `initialize` requires an explicit path to terminal64.exe.
      // Only call it when one is configured: when MT5 desktop is already open
      // and logged in, the underlying MetaTrader5 library attaches to the
      // running terminal on its own and this call is unnecessary.
      if (this.opts.terminalPath) {
        await this.tryCall('initialize', { path: this.opts.terminalPath });
      }
      if (this.opts.login && this.opts.password && this.opts.server) {
        const res = await this.tryCall('login', {
          account: Number(this.opts.login),
          password: this.opts.password,
          server: this.opts.server,
        });
        if (res && (res as any).error) {
          throw new Error(`MT5 login failed: ${JSON.stringify((res as any).error)}`);
        }
      }

      this.connected = true;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.connected = false;
    this.client = null;
  }

  private async ensure(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  /** Calls a tool and returns its parsed result, throwing a readable error on failure. */
  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    if (!this.client) throw new Error('mt5mcp: not connected');
    let res: Awaited<ReturnType<Client['callTool']>>;
    try {
      res = await this.client.callTool({ name, arguments: args });
    } catch (err) {
      throw new Error(
        `mt5mcp: tool "${name}" failed — ${errMsg(err)}. If the server's tool list (logged at ` +
          `connect time) shows a different name for this operation, that mapping needs updating ` +
          `in server/src/broker/mt5mcp.ts.`,
      );
    }
    if ((res as any).isError) {
      throw new Error(`mt5mcp: tool "${name}" returned an error: ${extractText(res)}`);
    }
    const structured = (res as any).structuredContent;
    if (structured !== undefined) return unwrapResult(structured);
    const text = extractText(res);
    if (text == null) return null;
    try {
      return unwrapResult(JSON.parse(text));
    } catch {
      return text; // some tools may just return plain text/status
    }
  }

  /** Same as callTool but never throws — used for setup calls that may already be satisfied. */
  private async tryCall(name: string, args: Record<string, unknown>): Promise<any> {
    try {
      return await this.callTool(name, args);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mt5mcp] "${name}" call did not succeed (continuing): ${errMsg(err)}`);
      return null;
    }
  }

  /**
   * Diagnostic escape hatch: call a tool and get its raw, unparsed result.
   *
   * Restricted to read-only tools — this exists to debug shape mismatches
   * between what this adapter expects and what the bridge actually returns,
   * not to place trades from a URL bar.
   */
  async debugCallTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const READ_ONLY = new Set([
      'get_account_info', 'get_terminal_info', 'get_version', 'get_symbols',
      'get_symbols_by_group', 'get_symbol_info', 'get_symbol_info_tick',
      'symbol_select', 'copy_rates_from_pos', 'copy_rates_from_date',
      'copy_rates_range', 'copy_ticks_from_pos', 'copy_ticks_from_date',
      'copy_ticks_range', 'get_last_error', 'positions_get',
      'positions_get_by_ticket', 'orders_get', 'orders_get_by_ticket',
      'history_orders_get', 'history_deals_get', 'order_check',
    ]);
    if (!READ_ONLY.has(name)) {
      throw new Error(`Refusing to call "${name}" from the debug endpoint — read-only tools only.`);
    }
    await this.ensure();
    if (!this.client) throw new Error('mt5mcp: not connected');
    const res = await this.client.callTool({ name, arguments: args });
    return {
      isError: (res as any).isError ?? false,
      structuredContent: (res as any).structuredContent,
      text: extractText(res),
    };
  }

  /** Tool names the connected bridge advertises. */
  async listToolNames(): Promise<string[]> {
    await this.ensure();
    if (!this.client) throw new Error('mt5mcp: not connected');
    const { tools } = await this.client.listTools();
    return tools.map((t) => t.name);
  }

  // ---------------------------------------------------------------------
  // Broker interface
  // ---------------------------------------------------------------------

  async getSymbols(): Promise<string[]> {
    await this.ensure();
    // A broker can list thousands of symbols and this is hit on every search
    // keystroke, so cache the list rather than round-tripping each time.
    if (this.symbolsCache && Date.now() - this.symbolsCache.at < 3_600_000) {
      return this.symbolsCache.list;
    }
    const res = await this.callTool('get_symbols', {});
    const list: string[] = Array.isArray(res) ? res : (res?.symbols ?? res?.result ?? []);
    this.symbolsCache = { list, at: Date.now() };
    return list;
  }

  async getSymbolSpec(symbol: string): Promise<SymbolSpec> {
    await this.ensure();
    const cached = this.specCache.get(symbol);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.spec;

    // A symbol that isn't in Market Watch returns no data. Selecting it first
    // is harmless when it's already there, and fixes the case where it isn't.
    // The bridge wraps MetaTrader5.symbol_select() taking only the name — it
    // rejects the library's second `enable` argument.
    await this.tryCall('symbol_select', { symbol });

    const info = await this.callTool('get_symbol_info', { symbol });
    const point: number = info.point ?? 10 ** -(info.digits ?? 5);

    // Field names as the bridge actually emits them, with the raw MetaTrader5
    // names kept as a fallback. On MetaQuotes-Demo several of these come back
    // null, so every step below has to survive a missing value.
    const tickSize: number | null = firstNumber(info.tick_size, info.trade_tick_size);
    const tickValue: number | null = firstNumber(
      info.tick_value_loss, info.tick_value, info.trade_tick_value, info.tick_value_profit,
    );
    const contractSize: number | null = firstNumber(info.contract_size, info.trade_contract_size);

    const pointValue = derivePointValue(symbol, point, tickSize, tickValue, contractSize);

    const spec: SymbolSpec = {
      symbol,
      point,
      digits: info.digits ?? 5,
      contractSize: contractSize ?? 100_000,
      spreadPoints: info.spread ?? 15,
      // The wrapped API doesn't expose commission; same as MetaApi, this is user-configured.
      commissionPerLot: 0,
      slippagePoints: this.opts.deviationPoints ?? 5,
      pointValuePerLot: pointValue.value,
      pointValueEstimated: pointValue.estimated,
      description: info.description ?? undefined,
      minVolume: firstNumber(info.volume_min) ?? 0.01,
      maxVolume: firstNumber(info.volume_max) ?? 100,
      volumeStep: firstNumber(info.volume_step) ?? 0.01,
    };
    this.specCache.set(symbol, { spec, at: Date.now() });
    this.fillingMask.set(symbol, firstNumber(info.filling_mode));
    return spec;
  }

  async getQuote(symbol: string): Promise<Quote> {
    await this.ensure();
    const t = await this.callTool('get_symbol_info_tick', { symbol });
    const spec = this.specCache.get(symbol)?.spec;
    const point = spec?.point ?? 0.00001;
    return {
      symbol,
      bid: t.bid,
      ask: t.ask,
      spreadPoints: Math.round((t.ask - t.bid) / point),
      time: toMillis(t.time),
    };
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    await this.ensure();
    const tf = TF_TO_MT5[timeframe] ?? 5;
    const res = await this.callTool('copy_rates_from_pos', {
      symbol,
      timeframe: tf,
      start_pos: 0,
      count: Math.min(limit, 5000),
    });
    const rows: any[] = Array.isArray(res) ? res : (res?.rates ?? res?.result ?? []);
    return rows
      .map((r) => ({
        time: toMillis(r.time),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.tick_volume ?? r.real_volume ?? 0,
        spread: r.spread,
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getAccountInfo(): Promise<AccountInfo> {
    await this.ensure();
    const info = await this.callTool('get_account_info', {});
    const server: string = info.server ?? '';
    const isDemo =
      (typeof info.trade_mode === 'number' && info.trade_mode === 0) ||
      /demo/i.test(server) ||
      /demo/i.test(String(info.name ?? ''));
    return {
      broker: info.company ?? 'MetaTrader 5 (local)',
      currency: info.currency ?? 'USD',
      server,
      balance: info.balance ?? 0,
      equity: info.equity ?? 0,
      margin: info.margin ?? 0,
      freeMargin: info.margin_free ?? 0,
      leverage: info.leverage ?? 0,
      type: isDemo ? 'demo' : 'real',
      name: info.name ?? '',
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    await this.ensure();
    const res = await this.callTool('positions_get', {});
    const rows: any[] = Array.isArray(res) ? res : (res?.positions ?? res?.result ?? []);
    return rows.map((p) => ({
      id: String(p.ticket),
      symbol: p.symbol,
      side: p.type === ORDER_TYPE_BUY ? 'long' : 'short',
      volume: p.volume,
      openPrice: p.price_open,
      currentPrice: p.price_current ?? p.price_open,
      stopLoss: p.sl || null,
      takeProfit: p.tp || null,
      profit: p.profit ?? 0,
      swap: p.swap ?? 0,
      commission: p.commission ?? 0,
      openTime: toMillis(p.time),
      comment: p.comment,
    }));
  }

  /** Broker server time minus real UTC, learned from fresh ticks (MetaQuotes-Demo: +3h). */
  private serverOffsetMs: number | null = null;

  /**
   * Whether a symbol exists on this account, what trading it allows, and
   * whether its price is moving right now. Never throws: an unknown symbol
   * comes back as available=false with a readable reason.
   */
  async getMarketStatus(symbol: string): Promise<MarketStatus> {
    const now = Date.now();
    const base: MarketStatus = {
      symbol, available: false, tradeMode: null, open: null, lastTickAt: null,
      bid: null, ask: null, spreadPoints: null, description: null, reason: null, checkedAt: now,
    };
    await this.ensure();
    await this.tryCall('symbol_select', { symbol });
    let info: any;
    try {
      info = await this.callTool('get_symbol_info', { symbol });
    } catch {
      return { ...base, reason: `${symbol} is not offered by your broker, so a bot on it can never trade. Pick a symbol your broker lists.` };
    }
    const tradeMode = TRADE_MODES[info?.trade_mode as number] ?? null;
    const point: number = info?.point ?? 10 ** -(info?.digits ?? 5);
    let tick: any = null;
    try {
      tick = await this.callTool('get_symbol_info_tick', { symbol });
    } catch {
      /* no tick: treated as closed below */
    }
    const bid = typeof tick?.bid === 'number' ? tick.bid : null;
    const ask = typeof tick?.ask === 'number' ? tick.ask : null;
    const rawTick = tick ? (typeof tick.time_msc === 'number' && tick.time_msc > 0 ? tick.time_msc : toMillis(tick.time)) : null;
    if (rawTick != null) {
      const learned = estimateServerOffset(rawTick, now, this.serverOffsetMs ?? Number.NaN);
      if (Number.isFinite(learned)) this.serverOffsetMs = learned;
    }
    const lastTickAt = rawTick != null && this.serverOffsetMs != null ? rawTick - this.serverOffsetMs : null;
    const fresh = lastTickAt != null ? now - lastTickAt < MARKET_STALE_MS : null;
    const pricesOk = !!bid && !!ask;
    const open = !pricesOk ? false : fresh;

    let reason: string | null = null;
    if (tradeMode === 'disabled') reason = `Trading ${symbol} is disabled on this account.`;
    else if (tradeMode === 'close_only') reason = `${symbol} is close-only on this account: existing trades can be closed, no new ones opened.`;
    else if (open === false) reason = `${symbol} market is closed right now${lastTickAt ? ` (last price ${new Date(lastTickAt).toUTCString().slice(17, 22)} UTC)` : ''}. The bot waits and trades when it reopens.`;

    return {
      ...base,
      available: true,
      tradeMode,
      open,
      lastTickAt,
      bid,
      ask,
      spreadPoints: bid && ask ? Math.round((ask - bid) / point) : null,
      description: info?.description ?? null,
      reason,
    };
  }

  /**
   * Deal history for one position via history_deals_get(position=...), which
   * is how MT5 reports what really happened: TP/SL hits, stop-outs, manual
   * closes, and the realised profit including commission, swap and fees.
   */
  async getPositionHistory(positionId: string): Promise<PositionHistory | null> {
    await this.ensure();
    const res = await this.callTool('history_deals_get', { position: Number(positionId) });
    const deals: any[] = Array.isArray(res) ? res : (res?.deals ?? res?.result ?? []);
    return positionHistoryFromDeals(positionId, deals);
  }

  async openPosition(req: OpenOrderRequest): Promise<{ positionId: string }> {
    await this.ensure();
    const quote = await this.getQuote(req.symbol);

    // Cheapest possible check: a bid or ask of zero means the broker is not
    // quoting. Catching it here turns a confusing rejection into a clear
    // "market is closed", and saves a pointless round trip.
    if (!(quote.bid > 0) || !(quote.ask > 0)) {
      throw new MarketClosedError(
        `${req.symbol}: the broker is not quoting a price right now (bid ${quote.bid}, ask ${quote.ask}). ` +
          `The market is closed, or the instrument is in its daily break.`,
      );
    }

    const price = req.side === 'long' ? quote.ask : quote.bid;

    // Snapshot what is already open so a position that appears despite an
    // error can be recognised as ours rather than assumed not to exist.
    const before = new Set((await this.getPositions()).map((p) => p.id));

    const payload = {
      request: {
        action: TRADE_ACTION_DEAL,
        symbol: req.symbol,
        volume: req.volume,
        type: req.side === 'long' ? ORDER_TYPE_BUY : ORDER_TYPE_SELL,
        price,
        sl: req.stopLoss ?? 0,
        tp: req.takeProfit ?? 0,
        deviation: this.opts.deviationPoints ?? 20,
        magic: MAGIC, // fixed id so trades from this app are identifiable in MT5's log
        comment: (req.comment ?? 'XAT').slice(0, 26),
        type_time: ORDER_TIME_GTC,
        // sendWithFilling() replaces this per attempt; the value here is only
        // a placeholder so the request shape is complete.
        type_filling: ORDER_FILLING.ioc,
      },
    };

    let result: any;
    try {
      result = await this.sendWithFilling(req.symbol, payload);
    } catch (err) {
      // The bridge raises on retcodes it doesn't recognise — including 0, which
      // MetaQuotes-Demo returns for a FILLED order. Treating that as a failure
      // would leave a live position the bot believes it never opened, so check
      // the broker before believing the error.
      const landed = await this.findNewPosition(req.symbol, before);
      if (landed) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mt5mcp] order_send reported an error but the position DID open (ticket ${landed.id}). ` +
            `Treating it as filled. Bridge said: ${errMsg(err)}`,
        );
        return { positionId: landed.id };
      }
      // The bridge raises rather than returning, so the retcode is only
      // available in the message text.
      if (looksMarketClosed(errMsg(err))) {
        throw new MarketClosedError(
          `${req.symbol}: the broker is not quoting a price right now. The market is closed, or the ` +
            `instrument is in its daily maintenance break.`,
        );
      }
      throw new Error(
        `Order failed and no position appeared at the broker. ${errMsg(err)} — if this mentions a ` +
          `filling mode, try 'fok' or 'return' via MT5MCP_FILL_MODE in the server .env.`,
      );
    }

    const retcode = result?.retcode;
    if (!SUCCESS_RETCODES.has(retcode)) {
      // Same defence on the non-throwing path.
      const landed = await this.findNewPosition(req.symbol, before);
      if (landed) return { positionId: landed.id };
      if (MARKET_CLOSED_RETCODES.has(retcode)) {
        throw new MarketClosedError(`${req.symbol}: ${describeRetcode(retcode, result?.comment)}`);
      }
      throw new Error(`Order rejected. ${describeRetcode(retcode, result?.comment)}`);
    }

    const positionId = result?.position ?? result?.order ?? result?.deal;
    if (!positionId) {
      const landed = await this.findNewPosition(req.symbol, before);
      if (landed) return { positionId: landed.id };
      throw new Error(`Order appeared to succeed but no position id was returned: ${JSON.stringify(result)}`);
    }
    return { positionId: String(positionId) };
  }

  /**
   * Send an order, adapting the filling mode to what the symbol accepts.
   *
   * Retcode 10030 ("Unsupported filling mode") is per-symbol, not per-account —
   * this broker takes IOC on gold and refuses it on GBPUSD. Rather than make
   * the user discover that by hand and edit a config file, try the modes the
   * symbol's own mask permits and remember which one worked.
   *
   * An explicit MT5MCP_FILL_MODE always wins, so the override still works.
   */
  private async sendWithFilling(symbol: string, payload: any): Promise<any> {
    // Make sure the mask is populated — it is read as part of the spec.
    if (!this.fillingMask.has(symbol)) {
      try {
        await this.getSymbolSpec(symbol);
      } catch {
        /* fall through to the try-everything path */
      }
    }

    const forced = this.opts.fillMode ? FILL_MODE[this.opts.fillMode] : undefined;
    const remembered = this.fillingThatWorked.get(symbol);
    const candidates =
      forced !== undefined
        ? [forced]
        : remembered !== undefined
          ? [remembered, ...fillingCandidates(this.fillingMask.get(symbol) ?? null).filter((m) => m !== remembered)]
          : fillingCandidates(this.fillingMask.get(symbol) ?? null);

    let lastError: unknown = null;

    for (const mode of candidates) {
      const attempt = { request: { ...payload.request, type_filling: mode } };
      try {
        const result = await this.callTool('order_send', attempt);
        if (result?.retcode === 10030) {
          lastError = new Error(describeRetcode(10030, result?.comment));
          continue; // this mode is not allowed here — try the next
        }
        this.fillingThatWorked.set(symbol, mode);
        return result;
      } catch (err) {
        lastError = err;
        // Only a filling-mode complaint is worth retrying. Anything else —
        // no prices, no money, bad stops — would fail identically every time.
        if (!/10030|INVALID_FILL|filling mode/i.test(errMsg(err))) throw err;
      }
    }

    throw lastError ?? new Error(`order_send failed for ${symbol} with every filling mode tried.`);
  }

  /** A position on `symbol` that exists now but didn't before the request. */
  private async findNewPosition(symbol: string, before: Set<string>): Promise<BrokerPosition | null> {
    try {
      const now = await this.getPositions();
      return now.find((p) => p.symbol === symbol && !before.has(p.id)) ?? null;
    } catch {
      return null;
    }
  }

  async modifyPosition(positionId: string, stopLoss: number | null, takeProfit: number | null): Promise<void> {
    await this.ensure();
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.id === positionId);
    if (!pos) throw new Error(`Position ${positionId} not found (already closed?)`);

    let result: any;
    try {
      result = await this.callTool('order_send', {
        request: {
          action: TRADE_ACTION_SLTP,
          symbol: pos.symbol,
          position: Number(positionId),
          sl: stopLoss ?? 0,
          tp: takeProfit ?? 0,
        },
      });
    } catch (err) {
      // Verify against the broker rather than trusting the error.
      if (await this.stopsMatch(positionId, stopLoss, takeProfit)) return;
      throw new Error(`Could not modify stop/target: ${errMsg(err)}`);
    }

    const retcode = result?.retcode;
    if (!SUCCESS_RETCODES.has(retcode)) {
      if (await this.stopsMatch(positionId, stopLoss, takeProfit)) return;
      throw new Error(`Could not modify stop/target (retcode ${retcode}): ${result?.comment ?? 'no reason given'}`);
    }
  }

  /** Did the stop/target actually end up where we asked? */
  private async stopsMatch(positionId: string, sl: number | null, tp: number | null): Promise<boolean> {
    try {
      const pos = (await this.getPositions()).find((p) => p.id === positionId);
      if (!pos) return false;
      const close = (a: number | null, b: number | null) =>
        (a ?? 0) === 0 && (b ?? 0) === 0 ? true : Math.abs((a ?? 0) - (b ?? 0)) < 1e-6;
      return close(pos.stopLoss, sl) && close(pos.takeProfit, tp);
    } catch {
      return false;
    }
  }

  async closePosition(positionId: string): Promise<void> {
    await this.ensure();
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.id === positionId);
    if (!pos) throw new Error(`Position ${positionId} not found (already closed?)`);

    const quote = await this.getQuote(pos.symbol);
    // Closing a position is placing the opposite deal against it (hedging-style
    // accounts). Netting-account brokers behave slightly differently — if this
    // errors on your account type, that's the likely reason.
    const payload = {
      request: {
        action: TRADE_ACTION_DEAL,
        symbol: pos.symbol,
        volume: pos.volume,
        type: pos.side === 'long' ? ORDER_TYPE_SELL : ORDER_TYPE_BUY,
        position: Number(positionId),
        price: pos.side === 'long' ? quote.bid : quote.ask,
        deviation: this.opts.deviationPoints ?? 20,
        magic: MAGIC,
        comment: 'XAT close',
        type_time: ORDER_TIME_GTC,
        // sendWithFilling() replaces this per attempt; the value here is only
        // a placeholder so the request shape is complete.
        type_filling: ORDER_FILLING.ioc,
      },
    };

    let result: any;
    try {
      result = await this.sendWithFilling(pos.symbol, payload);
    } catch (err) {
      // A close that "failed" but actually worked is just as dangerous as an
      // open that did — the bot would keep trying to manage a dead position.
      if (await this.positionGone(positionId)) return;
      if (looksMarketClosed(errMsg(err))) {
        throw new MarketClosedError(
          `${pos.symbol}: cannot close right now — the broker is not quoting a price.`,
        );
      }
      throw new Error(`Could not close position: ${errMsg(err)}`);
    }

    const retcode = result?.retcode;
    if (!SUCCESS_RETCODES.has(retcode)) {
      if (await this.positionGone(positionId)) return;
      throw new Error(`Could not close position (retcode ${retcode}): ${result?.comment ?? 'no reason given'}`);
    }
  }

  private async positionGone(positionId: string): Promise<boolean> {
    try {
      return !(await this.getPositions()).some((p) => p.id === positionId);
    } catch {
      return false;
    }
  }
}

/** First argument that is a usable, non-zero number. MT5 returns null a lot. */
function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return v;
  }
  return null;
}

const pointValueWarned = new Set<string>();

/**
 * Value of one point, per 1.00 lot, in account currency. This number decides
 * position size and every P&L figure, so a wrong value here silently mis-sizes
 * every trade — worth being explicit about which path produced it.
 *
 *  1. tick value / tick size — exact, when the broker reports them
 *  2. contract size × point — correct when the quote currency is the account
 *     currency (XAUUSD, EURUSD on a USD account); wrong for e.g. USDJPY
 *  3. 1.0 — the value for a standard-lot USD-quoted instrument. Right for
 *     EURUSD and XAUUSD, wrong for JPY-quoted pairs, so it warns.
 */
function derivePointValue(
  symbol: string,
  point: number,
  tickSize: number | null,
  tickValue: number | null,
  contractSize: number | null,
): { value: number; estimated: boolean } {
  if (tickValue != null && tickSize != null && tickSize > 0) {
    return { value: tickValue * (point / tickSize), estimated: false };
  }
  if (contractSize != null && contractSize > 0) {
    return { value: contractSize * point, estimated: false };
  }
  if (!pointValueWarned.has(symbol)) {
    pointValueWarned.add(symbol);
    // eslint-disable-next-line no-console
    console.warn(
      `[mt5mcp] ${symbol}: broker reported no tick value or contract size, so point value ` +
        `per lot is assumed to be 1.0. That is correct for USD-quoted instruments such as ` +
        `EURUSD and XAUUSD. If you trade a JPY-quoted or cross pair, position sizes and P&L ` +
        `figures for it will be wrong — check the numbers against MetaTrader before trusting them.`,
    );
  }
  return { value: 1, estimated: true };
}

function extractText(res: any): string | null {
  const block = res?.content?.find((c: any) => c.type === 'text');
  return block?.text ?? null;
}

/**
 * MCP structured output must be an object at the top level, so a tool that
 * returns a LIST comes back wrapped as `{ result: [...] }` while a tool that
 * returns a dict comes back as-is. Unwrap that single-key envelope so callers
 * see the value the tool actually meant to return.
 */
function unwrapResult(value: any): any {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'result' in value
  ) {
    return value.result;
  }
  return value;
}

/**
 * Normalise a MetaTrader timestamp to epoch milliseconds.
 *
 * The bridge emits ISO-8601 strings ("2026-08-17T00:05:00Z"), while the raw
 * MetaTrader5 Python API uses epoch SECONDS. Accept either, plus milliseconds,
 * so a change on either side cannot silently produce NaN dates.
 */
/** MT5 SYMBOL_TRADE_MODE values. */
const TRADE_MODES: Record<number, MarketStatus['tradeMode']> = { 0: 'disabled', 1: 'long_only', 2: 'short_only', 3: 'close_only', 4: 'full' };
/** No price update for this long while prices exist = market closed (FX/metals tick every few seconds when open). */
const MARKET_STALE_MS = 5 * 60_000;

const DEAL_ENTRY_IN = 0;
const DEAL_ENTRY_OUT = 1;
const DEAL_ENTRY_OUT_BY = 3;
const DEAL_REASONS: Record<number, PositionHistory['reason']> = { 0: 'manual', 1: 'manual', 2: 'manual', 3: 'bot', 4: 'sl', 5: 'tp', 6: 'stop_out' };

/** Pure: MT5 deals of one position → what happened to it. Exported for tests. */
export function positionHistoryFromDeals(positionId: string, deals: any[]): PositionHistory | null {
  if (!Array.isArray(deals) || deals.length === 0) return null;
  const t = (d: any) => (typeof d.time_msc === 'number' ? d.time_msc : toMillis(d.time));
  const sorted = [...deals].sort((a, b) => t(a) - t(b));
  const entry = sorted.find((d) => d.entry === DEAL_ENTRY_IN) ?? sorted[0];
  const outs = sorted.filter((d) => d.entry === DEAL_ENTRY_OUT || d.entry === DEAL_ENTRY_OUT_BY);
  const inVolume = sorted.filter((d) => d.entry === DEAL_ENTRY_IN).reduce((a, d) => a + (d.volume ?? 0), 0) || (entry.volume ?? 0);
  const outVolume = outs.reduce((a, d) => a + (d.volume ?? 0), 0);
  const last = outs[outs.length - 1];
  const profit = sorted.reduce((a, d) => a + (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0) + (d.fee ?? 0), 0);
  return {
    positionId: String(positionId),
    symbol: entry.symbol,
    side: entry.type === ORDER_TYPE_BUY ? 'long' : 'short',
    volume: entry.volume ?? 0,
    entryTime: t(entry),
    entryPrice: entry.price,
    closed: outs.length > 0 && outVolume >= inVolume - 1e-9,
    closeTime: last ? t(last) : null,
    closePrice: last ? last.price : null,
    profit: Math.round(profit * 100) / 100,
    reason: last ? (DEAL_REASONS[last.reason] ?? 'other') : null,
  };
}

function toMillis(value: unknown): number {
  if (value == null) return Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Anything past ~2001 in milliseconds is already milliseconds.
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  if (!Number.isNaN(parsed)) return parsed;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber > 1e12 ? asNumber : asNumber * 1000;
  return Date.now();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
