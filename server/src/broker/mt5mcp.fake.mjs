/**
 * A fake MT5 MCP server used ONLY by mt5mcp.test.ts.
 *
 * It speaks real MCP over stdio and answers with realistic MetaTrader5-shaped
 * payloads, so the stdio spawn path, the tool-name mapping, the retcode
 * checking and the unit conversions can all be exercised without a Windows
 * machine or a live terminal.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// These names were confirmed against a real mcp-metatrader5-server 0.1.8
// running on Windows against MT5 build 6060 — not guessed.
const TOOLS = [
  'initialize', 'shutdown', 'login', 'get_account_info', 'get_terminal_info',
  'get_version', 'get_symbols', 'get_symbols_by_group', 'get_symbol_info',
  'get_symbol_info_tick', 'symbol_select', 'copy_rates_from_pos',
  'copy_rates_from_date', 'copy_rates_range', 'copy_ticks_from_pos',
  'copy_ticks_from_date', 'copy_ticks_range', 'get_last_error', 'order_send',
  'order_check', 'positions_get', 'positions_get_by_ticket', 'orders_get',
  'orders_get_by_ticket', 'history_orders_get', 'history_deals_get',
];

/**
 * Per-symbol specs copied from what MetaQuotes-Demo actually returns.
 * Note XAUUSD: the broker reports tick_value / tick_size / contract_size as
 * NULL, and the field names are tick_* not trade_tick_*. Both details broke
 * position sizing before this fixture reproduced them.
 */
const SYMBOL_INFO = {
  // Real MetaQuotes-Demo EURUSD: nulls here too, confirmed from live logs.
  EURUSD: {
    name: 'EURUSD', point: 0.00001, digits: 5, spread: 12,
    contract_size: null, tick_size: null,
    tick_value: null, tick_value_loss: null, tick_value_profit: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  // A broker that DOES report full tick data — the exact derivation path.
  TICKUSD: {
    name: 'TICKUSD', point: 0.00001, digits: 5, spread: 10,
    contract_size: 100000, tick_size: 0.00001,
    tick_value: 1, tick_value_loss: 1, tick_value_profit: 1,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  // Real MetaQuotes-Demo gold: everything useful is null.
  XAUUSD: {
    name: 'XAUUSD', point: 0.01, digits: 2, spread: 20,
    contract_size: null, tick_size: null,
    tick_value: null, tick_value_loss: null, tick_value_profit: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  /**
   * Reproduces the real MetaQuotes-Demo failure: order_send EXECUTES the trade
   * but the bridge then raises because it doesn't recognise retcode 0.
   * Orders on this symbol always "fail" while really filling.
   */
  FLAKYUSD: {
    name: 'FLAKYUSD', point: 0.01, digits: 2, spread: 20,
    contract_size: null, tick_size: null, tick_value: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  /**
   * Behaves like the real GBPUSD on this account: filling_mode 1 = FOK only,
   * so an IOC order is rejected with 10030 and FOK succeeds.
   */
  FOKONLYUSD: {
    name: 'FOKONLYUSD', point: 0.00001, digits: 5, spread: 16,
    contract_size: 100000, tick_size: null, tick_value: null,
    filling_mode: 1,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  /** Returns bars anchored to the real clock, in skewed server time. */
  RECENTUSD: {
    name: 'RECENTUSD', point: 0.00001, digits: 5, spread: 16,
    contract_size: 100000, tick_size: null, tick_value: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  /** Broker is not quoting — bid/ask come back as 0, as during a daily break. */
  CLOSEDUSD: {
    name: 'CLOSEDUSD', point: 0.01, digits: 2, spread: 0,
    contract_size: null, tick_size: null, tick_value: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  /** Quotes fine, but order_send rejects with 10021 (PRICE_OFF). */
  PRICEOFFUSD: {
    name: 'PRICEOFFUSD', point: 0.01, digits: 2, spread: 20,
    contract_size: null, tick_size: null, tick_value: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  /** Always genuinely rejected by the broker; nothing ever opens. */
  REJECTUSD: {
    name: 'REJECTUSD', point: 0.01, digits: 2, spread: 20,
    contract_size: null, tick_size: null, tick_value: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
  // No tick data, but a contract size — the middle derivation path.
  GBPUSD: {
    name: 'GBPUSD', point: 0.00001, digits: 5, spread: 16,
    contract_size: 100000, tick_size: null, tick_value: null,
    volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  },
};

const state = {
  deals: [],
  nextDeal: 90000,
  positions: [],
  nextTicket: 5000,
  lastOrderRequest: null,
};

const server = new Server(
  { name: 'fake-mt5', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((name) => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
  })),
}));

/**
 * Mirrors FastMCP's real serialisation, verified against a live bridge:
 *  - a dict return comes back as structuredContent directly
 *  - a LIST return is wrapped as structuredContent.result, because structured
 *    output must be an object at the top level
 * Getting this wrong is what let a candle-parsing bug ship green.
 */
const ok = (payload) => {
  const structured = Array.isArray(payload) ? { result: payload } : payload;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: structured,
  };
};

/** The bridge emits ISO-8601 strings, NOT epoch seconds. */
const iso = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');

/**
 * MetaQuotes-Demo runs UTC+3, and the bridge stamps that SERVER time with a
 * "Z" suffix — so every candle looks up to three hours in the future. Code
 * that asks "is this bar finished?" by comparing to the wall clock therefore
 * discards every recent bar. Bars here are generated relative to now with that
 * skew applied, so the bug reproduces instead of being assumed away.
 */
const SERVER_SKEW_SECONDS = 3 * 3600;

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  switch (name) {
    case 'initialize':
      if (!args.path) {
        return { content: [{ type: 'text', text: "Missing required argument: path" }], isError: true };
      }
      return ok({ success: true });

    case 'symbol_select':
      // The real bridge accepts ONLY `symbol`; passing MetaTrader5's second
      // `enable` argument is a pydantic validation error.
      if ('enable' in args) {
        return {
          content: [{ type: 'text', text: "Unexpected keyword argument: enable" }],
          isError: true,
        };
      }
      return ok({ success: true });

    case 'login':
      return ok({ success: true });

    case 'get_symbols':
      return ok(['EURUSD', 'GBPUSD', 'XAUUSD', 'TICKUSD', 'FLAKYUSD', 'REJECTUSD', 'CLOSEDUSD', 'PRICEOFFUSD', 'FOKONLYUSD', 'RECENTUSD']);

    case 'get_symbol_info':
      if (args.symbol === 'BTCUSD') {
        // Exactly what the live MetaQuotes-Demo bridge returned: the broker has no such symbol.
        return { content: [{ type: 'text', text: "Error calling tool 'get_symbol_info': Failed to get info for symbol BTCUSD" }], isError: true };
      }
      if (args.symbol === 'CLOSEONLYUSD') return ok({ ...SYMBOL_INFO.EURUSD, name: 'CLOSEONLYUSD', trade_mode: 3 });
      return ok({ trade_mode: 4, ...(SYMBOL_INFO[args.symbol] ?? SYMBOL_INFO.EURUSD) });

    case 'get_symbol_info_tick':
      if (args.symbol === 'BTCUSD') {
        return { content: [{ type: 'text', text: "Error calling tool 'get_symbol_info_tick': Failed to get tick for symbol BTCUSD. Error: -4 - Terminal: Not found." }], isError: true };
      }
      if (args.symbol === 'LIVEUSD' || args.symbol === 'CLOSEONLYUSD') {
        // A live tick, stamped in broker server time (UTC+3) like the real terminal.
        const ms = Date.now() - 2000 + SERVER_SKEW_SECONDS * 1000;
        return ok({ bid: 1.1, ask: 1.10012, time: Math.floor(ms / 1000), time_msc: ms });
      }
      if (args.symbol === 'CLOSEDUSD') {
        // Exactly what MetaTrader returns when the session is closed.
        return ok({ bid: 0.0, ask: 0.0, time: iso(1786910000) });
      }
      if (args.symbol === 'FLAKYUSD' || args.symbol === 'XAUUSD' || args.symbol === 'PRICEOFFUSD') {
        return ok({ bid: 4417.18, ask: 4417.38, time: iso(1786910000) });
      }
      return ok({ bid: 1.15704, ask: 1.15716, time: iso(1786910000) });

    case 'copy_rates_from_pos': {
      if (args.symbol === 'RECENTUSD') {
        // Bars ending "now", stamped in skewed server time.
        const n = args.count ?? 10;
        const stepSec = (args.timeframe ?? 5) * 60;
        const nowSec = Math.floor(Date.now() / 1000);
        const latest = Math.floor(nowSec / stepSec) * stepSec;
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
          out.push({
            time: iso(latest - i * stepSec + SERVER_SKEW_SECONDS),
            open: 1.36 + i * 0.0001,
            high: 1.3605 + i * 0.0001,
            low: 1.3595 + i * 0.0001,
            close: 1.3602 + i * 0.0001,
            tick_volume: 100 + i,
            spread: 16,
          });
        }
        return ok(out);
      }
      const count = args.count ?? 10;
      const rates = [];
      for (let i = 0; i < count; i++) {
        rates.push({
          time: iso(1786900000 + i * 300), // ISO string, 5-minute spacing
          open: 1.15 + i * 0.0001,
          high: 1.1505 + i * 0.0001,
          low: 1.1495 + i * 0.0001,
          close: 1.1502 + i * 0.0001,
          tick_volume: 100 + i,
          spread: 12,
        });
      }
      return ok(rates);
    }

    case 'get_account_info':
      return ok({
        company: 'MetaQuotes Ltd.',
        currency: 'USD',
        server: 'MetaQuotes-Demo',
        balance: 10000,
        equity: 10025.5,
        margin: 100,
        margin_free: 9925.5,
        leverage: 100,
        trade_mode: 0, // 0 = demo
        name: 'Demo Account',
      });

    case 'positions_get':
      return ok(state.positions);

    case 'history_deals_get':
      return ok(state.deals.filter((d) => args.position == null || String(d.position_id) === String(args.position)));

    case 'order_send': {
      const r = args.request ?? {};
      state.lastOrderRequest = r;

      if (r.symbol === 'FOKONLYUSD' && r.type_filling !== 0) {
        // Exactly what the live account returned for GBPUSD with IOC.
        return ok({ retcode: 10030, comment: 'Unsupported filling mode', deal: 0, order: 0 });
      }

      if (r.symbol === 'PRICEOFFUSD') {
        // The real shape of a daily-break rejection, taken from a live log.
        return ok({ retcode: 10021, comment: 'No prices', deal: 0, order: 0, bid: 0.0, ask: 0.0 });
      }

      if (r.symbol === 'REJECTUSD') {
        // A real rejection: no position is created, so the adapter's
        // verify-against-broker recovery must NOT rescue this one.
        return ok({ retcode: 10015, comment: 'Invalid price' });
      }

      if (r.action === 1) {
        // TRADE_ACTION_DEAL — either an open or a close
        if (r.position) {
          const closing = state.positions.find((p) => String(p.ticket) === String(r.position));
          if (closing) state.deals.push({ ticket: state.nextDeal++, position_id: closing.ticket, entry: 1, type: closing.type === 0 ? 1 : 0, reason: 3, volume: closing.volume, price: r.price ?? closing.price_current, profit: closing.profit ?? 0, commission: 0, swap: 0, fee: 0, symbol: closing.symbol, time_msc: 1786910600000 });
          state.positions = state.positions.filter((p) => String(p.ticket) !== String(r.position));
          if (r.symbol === 'FLAKYUSD') {
            return { content: [{ type: 'text', text: 'Order execution failed: Unknown retcode 0' }], isError: true };
          }
          return ok({ retcode: 10009, position: r.position, comment: 'closed' });
        }
        const ticket = state.nextTicket++;
        state.deals.push({ ticket: state.nextDeal++, position_id: ticket, entry: 0, type: r.type, reason: 3, volume: r.volume, price: r.price, profit: 0, commission: -0.07, swap: 0, fee: 0, symbol: r.symbol, time_msc: 1786910000000 });
        state.positions.push({
          ticket,
          symbol: r.symbol,
          type: r.type, // 0 buy, 1 sell
          volume: r.volume,
          price_open: r.price,
          price_current: r.price,
          sl: r.sl ?? 0,
          tp: r.tp ?? 0,
          profit: 0,
          swap: 0,
          commission: 0,
          time: iso(1786910000),
          comment: r.comment,
        });
        if (r.symbol === 'FLAKYUSD') {
          // Position created above, then the bridge blows up anyway. Exactly the
          // real-world case: the trade is live but the caller sees an error.
          return {
            content: [{ type: 'text', text: 'Order execution failed: Unknown retcode 0 / Comment from broker: Done' }],
            isError: true,
          };
        }
        return ok({ retcode: 10009, position: ticket, order: ticket, comment: 'done' });
      }

      if (r.action === 6) {
        // TRADE_ACTION_SLTP
        const pos = state.positions.find((p) => String(p.ticket) === String(r.position));
        if (pos) {
          pos.sl = r.sl;
          pos.tp = r.tp;
        }
        return ok({ retcode: 10009, comment: 'sltp updated' });
      }

      return ok({ retcode: 10013, comment: 'unsupported action' });
    }

    default:
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
