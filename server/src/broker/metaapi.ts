/**
 * MetaApi cloud adapter.
 *
 * MetaApi hosts a real MetaTrader 5 terminal for your account and exposes it
 * over an API, which is how this app can automate a platform whose phone client
 * has no Expert Advisor support at all.
 *
 * We use an RPC connection rather than a streaming one: for M5 scalping the
 * extra round trip is irrelevant next to the bar interval, and RPC is far more
 * robust to reconnects. Symbol specs and candles are cached, because they are
 * the two calls that would otherwise dominate the request quota.
 */

// The package's default "." export resolves to a BROWSER bundle that crashes on
// Node with "window is not defined". The /esm-node subpath is the Node build.
import MetaApi from 'metaapi.cloud-sdk/esm-node';

import type { Candle, SymbolSpec, Timeframe } from '../engine/types.js';
import type {
  AccountInfo,
  Broker,
  BrokerPosition,
  OpenOrderRequest,
  Quote,
} from './types.js';

/** Our Timeframe values already match MetaApi's vocabulary. */
const TF_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

interface SpecCacheEntry {
  spec: SymbolSpec;
  at: number;
}

export class MetaApiBroker implements Broker {
  readonly kind = 'metaapi' as const;

  private api: any;
  private account: any;
  private connection: any;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private specCache = new Map<string, SpecCacheEntry>();
  private symbolsCache: { list: string[]; at: number } | null = null;

  constructor(
    private token: string,
    private accountId: string,
    private region = 'new-york',
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    // Collapse concurrent connect() calls onto one in-flight attempt.
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const Ctor: any = (MetaApi as any).default ?? MetaApi;
      this.api = new Ctor(this.token, { region: this.region, requestTimeout: 60_000 });
      this.account = await this.api.metatraderAccountApi.getAccount(this.accountId);

      if (this.account.state !== 'DEPLOYED') {
        await this.account.deploy();
      }
      await this.account.waitConnected();

      this.connection = this.account.getRPCConnection();
      await this.connection.connect();
      await this.connection.waitSynchronized();
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
      if (this.connection) await this.connection.close();
    } catch {
      /* closing a already-dead connection is not an error worth surfacing */
    }
    this.connected = false;
    this.connection = null;
  }

  private async ensure(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  async getAccountInfo(): Promise<AccountInfo> {
    await this.ensure();
    const info = await this.connection.getAccountInformation();
    return {
      broker: info.broker ?? 'unknown',
      currency: info.currency ?? 'USD',
      server: info.server ?? '',
      balance: info.balance ?? 0,
      equity: info.equity ?? 0,
      margin: info.margin ?? 0,
      freeMargin: info.freeMargin ?? 0,
      leverage: info.leverage ?? 0,
      type: (info.type ?? '').toLowerCase().includes('demo') ? 'demo' : 'real',
      name: info.name ?? '',
    };
  }

  async getSymbols(): Promise<string[]> {
    await this.ensure();
    if (this.symbolsCache && Date.now() - this.symbolsCache.at < 3_600_000) {
      return this.symbolsCache.list;
    }
    const list = await this.connection.getSymbols();
    this.symbolsCache = { list, at: Date.now() };
    return list;
  }

  async getSymbolSpec(symbol: string): Promise<SymbolSpec> {
    await this.ensure();
    const cached = this.specCache.get(symbol);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.spec;

    const s = await this.connection.getSymbolSpecification(symbol);
    const point: number = s.point ?? 10 ** -(s.digits ?? 5);
    const tickSize: number = s.tickSize ?? point;
    // lossTickValue is per tick per lot in ACCOUNT currency; scale it to a point.
    const tickValue: number = s.lossTickValue ?? s.profitTickValue ?? 1;
    const pointValuePerLot = tickSize > 0 ? tickValue * (point / tickSize) : tickValue;

    let spreadPoints = 15;
    try {
      const q = await this.getQuote(symbol);
      spreadPoints = q.spreadPoints;
    } catch {
      /* fall back to the default estimate if the market is closed */
    }

    const spec: SymbolSpec = {
      symbol,
      point,
      digits: s.digits ?? 5,
      contractSize: s.contractSize ?? 100_000,
      spreadPoints,
      // MetaApi does not expose commission; treat it as a user-configured cost.
      commissionPerLot: 0,
      slippagePoints: 3,
      pointValuePerLot,
    };
    this.specCache.set(symbol, { spec, at: Date.now() });
    return spec;
  }

  async getQuote(symbol: string): Promise<Quote> {
    await this.ensure();
    const p = await this.connection.getSymbolPrice(symbol, true);
    const spec = this.specCache.get(symbol)?.spec;
    const point = spec?.point ?? 0.00001;
    return {
      symbol,
      bid: p.bid,
      ask: p.ask,
      spreadPoints: Math.round((p.ask - p.bid) / point),
      time: p.time ? new Date(p.time).getTime() : Date.now(),
    };
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    endTime?: Date,
  ): Promise<Candle[]> {
    await this.ensure();
    const tf = TF_MAP[timeframe] ?? '5m';
    const out: Candle[] = [];
    let cursor: Date | undefined = endTime;
    let remaining = limit;

    // MetaApi returns at most 1000 candles per call, walking backwards in time.
    while (remaining > 0) {
      const take = Math.min(remaining, 1000);
      const batch: any[] = await this.account.getHistoricalCandles(symbol, tf, cursor, take);
      if (!batch || batch.length === 0) break;

      for (const c of batch) {
        out.push({
          time: new Date(c.time).getTime(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.tickVolume ?? c.volume ?? 0,
          spread: c.spread,
        });
      }
      remaining -= batch.length;
      cursor = new Date(new Date(batch[0].time).getTime() - 1);
      if (batch.length < take) break;
    }

    out.sort((a, b) => a.time - b.time);
    // De-duplicate on time, which the paging boundaries can produce.
    const seen = new Set<number>();
    return out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)));
  }

  async getPositions(): Promise<BrokerPosition[]> {
    await this.ensure();
    const positions = await this.connection.getPositions();
    return (positions ?? []).map((p: any) => ({
      id: String(p.id),
      symbol: p.symbol,
      side: p.type === 'POSITION_TYPE_BUY' ? 'long' : 'short',
      volume: p.volume,
      openPrice: p.openPrice,
      currentPrice: p.currentPrice ?? p.openPrice,
      stopLoss: p.stopLoss ?? null,
      takeProfit: p.takeProfit ?? null,
      profit: p.profit ?? 0,
      swap: p.swap ?? 0,
      commission: p.commission ?? 0,
      openTime: p.time ? new Date(p.time).getTime() : Date.now(),
      comment: p.comment,
    }));
  }

  async openPosition(req: OpenOrderRequest): Promise<{ positionId: string }> {
    await this.ensure();
    const opts: any = {};
    if (req.comment) opts.comment = req.comment.slice(0, 26);
    if (req.clientId) opts.clientId = req.clientId.slice(0, 26);

    const res =
      req.side === 'long'
        ? await this.connection.createMarketBuyOrder(
            req.symbol,
            req.volume,
            req.stopLoss ?? undefined,
            req.takeProfit ?? undefined,
            opts,
          )
        : await this.connection.createMarketSellOrder(
            req.symbol,
            req.volume,
            req.stopLoss ?? undefined,
            req.takeProfit ?? undefined,
            opts,
          );

    if (res.numericCode !== undefined && res.numericCode !== 0 && res.numericCode !== 10009) {
      throw new Error(`Broker rejected the order: ${res.stringCode ?? res.message ?? res.numericCode}`);
    }
    return { positionId: String(res.positionId ?? res.orderId ?? '') };
  }

  async modifyPosition(positionId: string, stopLoss: number | null, takeProfit: number | null): Promise<void> {
    await this.ensure();
    await this.connection.modifyPosition(positionId, stopLoss ?? undefined, takeProfit ?? undefined);
  }

  async closePosition(positionId: string): Promise<void> {
    await this.ensure();
    await this.connection.closePosition(positionId, {});
  }
}
