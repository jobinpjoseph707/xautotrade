/**
 * Typed client for the XAutoTrade server, plus a self-healing WebSocket for
 * live bot status and log lines.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  AccountInfo,
  InboxAction,
  InboxItem,
  TestboardEntry,
  TierSummary,
  ChatAgent,
  ChatButton,
  ChatProposal,
  ChatResult,
  ChangeRecord,
  EvolveCandidate,
  EvolveSettings,
  Notebook,
  Scoreboard,
  BacktestResult,
  BotSnapshot,
  BrokerPosition,
  Catalog,
  LogEntry,
  LevelsRangeResult,
  LevelsStatus,
  OverlayPreview,
  Strategy,
  StrategyTrades,
  JournalResponse,
  MarketStatus,
  SymbolSpec,
  YoutubeAgentResult,
  YoutubeResult,
} from './types';

export interface Connection {
  baseUrl: string;
  apiKey: string;
}

const STORAGE_KEY = 'xautotrade.connection';

export async function loadConnection(): Promise<Connection | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Connection) : null;
  } catch {
    return null;
  }
}

export async function saveConnection(c: Connection): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

export async function clearConnection(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

// Two remembered server addresses so the phone can switch between home WiFi
// and the Tailscale tunnel without retyping. The API key is shared: auth does
// not depend on the transport.
export type AddressMode = 'local' | 'tailscale' | 'auto';
export interface SavedAddresses {
  local: string;
  tailscale: string;
  mode: AddressMode;
}

const ADDR_KEY = 'xautotrade.addresses';

export async function loadAddresses(): Promise<SavedAddresses> {
  try {
    const raw = await AsyncStorage.getItem(ADDR_KEY);
    if (raw) return { local: '', tailscale: '', mode: 'auto', ...(JSON.parse(raw) as Partial<SavedAddresses>) };
  } catch {
    /* fall through */
  }
  return { local: '', tailscale: '', mode: 'auto' };
}

export async function saveAddresses(a: SavedAddresses): Promise<void> {
  await AsyncStorage.setItem(ADDR_KEY, JSON.stringify(a));
}

/** /api/health is unauthenticated, so this only proves the server is reachable. */
export async function probeServer(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Trim a user-typed URL into something fetch can use. */
export function normaliseUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

export class Api {
  constructor(private conn: Connection) {}

  get baseUrl(): string {
    return this.conn.baseUrl;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 90_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.conn.baseUrl}/api${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.conn.apiKey,
          ...(init.headers ?? {}),
        },
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new ApiError(`Server returned a non-JSON response (${res.status}).`, res.status);
      }
      if (!res.ok || body?.ok === false) {
        throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
      }
      return body.data as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new ApiError('The server took too long to respond.', 0);
      }
      throw new ApiError(
        `Cannot reach ${this.conn.baseUrl}. Check the address and that your phone is on the same network.`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  health = () => this.request<{ status: string; mode: string; liveTradingAllowed: boolean }>('/health');
  catalog = () => this.request<Catalog>('/catalog');
  account = () => this.request<AccountInfo>('/account');

  /** Search the broker's own symbol list. Empty query returns the first page. */
  searchSymbols = (q = '', limit = 50) =>
    this.request<{ total: number; symbols: string[] }>(
      `/symbols?q=${encodeURIComponent(q)}&limit=${limit}`,
      {},
      20_000,
    );

  symbolSpec = (symbol: string) =>
    this.request<SymbolSpec>(`/symbols/${encodeURIComponent(symbol)}/spec`, {}, 30_000);

  // --- Chart levels (drawn on MT5 by the XATLevels EA) ---------------------
  drawRange = (symbol: string, minutes: number, timeframe: number) =>
    this.request<LevelsRangeResult>('/levels/range', {
      method: 'POST',
      body: JSON.stringify({ symbol, minutes, timeframe }),
    }, 60_000);

  strategyOverlay = (
    id: string,
    body: { publish?: boolean; bars?: number; indicators?: boolean; rules?: boolean; trades?: boolean; range?: boolean; rangeMinutes?: number },
  ) => this.request<OverlayPreview>(`/levels/strategy/${id}`, { method: 'POST', body: JSON.stringify(body) }, 60_000);
  clearStrategyOverlay = (id: string) => this.request<{ cleared: boolean }>(`/levels/strategy/${id}`, { method: 'DELETE' });
  levelsStatus = () => this.request<LevelsStatus>('/levels/status');

  clearLevels = () =>
    this.request<{ cleared: boolean; message: string }>('/levels', { method: 'DELETE' });

  strategies = () => this.request<Strategy[]>('/strategies');
  strategy = (id: string) => this.request<Strategy>(`/strategies/${id}`);
  /** Transcript -> candidate -> backtest on real MT5 candles. Saves nothing. Slow: it fetches captions and history. */
  youtubeExtract = (body: { url: string; symbol: string; timeframe?: string }) =>
    this.request<YoutubeResult>('/youtube/extract', { method: 'POST', body: JSON.stringify(body) }, 180_000);
  /** The Strategist agent reads the whole transcript and proposes a strategy (to the Inbox). Slow: it asks Claude. */
  youtubeStrategist = (body: { url: string; symbol: string; timeframe?: string }) =>
    this.request<YoutubeAgentResult>('/youtube/strategist', { method: 'POST', body: JSON.stringify(body) }, 300_000);
  /** Turns the analysed candidate into an Inbox proposal. It still needs Approve. */
  youtubePropose = (candidateId: string) =>
    this.request<{ proposal: ChatProposal; rejected: string[] }>('/youtube/propose', { method: 'POST', body: JSON.stringify({ candidateId }) }, 120_000);
  createStrategy = (body: { preset?: string; symbol?: string; name?: string; strategy?: Strategy }) =>
    this.request<Strategy>('/strategies', { method: 'POST', body: JSON.stringify(body) });
  updateStrategy = (id: string, patch: Partial<Strategy>) =>
    this.request<Strategy>(`/strategies/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
  deleteStrategy = (id: string) =>
    this.request<{ deleted: string }>(`/strategies/${id}`, { method: 'DELETE' });

  backtest = (body: {
    strategyId?: string;
    strategy?: Strategy;
    bars?: number;
    initialBalance?: number;
    spreadPoints?: number;
    commissionPerLot?: number;
  }) => this.request<BacktestResult>('/backtest', { method: 'POST', body: JSON.stringify(body) }, 180_000);

  bots = () => this.request<BotSnapshot[]>('/bots');
  startBot = (id: string) => this.request<BotSnapshot>(`/bots/${id}/start`, { method: 'POST' });
  stopBot = (id: string) => this.request<BotSnapshot>(`/bots/${id}/stop`, { method: 'POST' });
  closeAll = (id: string) => this.request<{ closed: number }>(`/bots/${id}/close-all`, { method: 'POST' });
  panic = () => this.request<{ stopped: boolean; closed: number }>('/panic', { method: 'POST' });

  positions = () => this.request<BrokerPosition[]>('/positions');
  closePosition = (id: string) =>
    this.request<{ closed: string }>(`/positions/${id}/close`, { method: 'POST' });

  // --- Chat agents (Claude Code running on the server's computer) ---------
  inbox = (status: 'open' | 'done' | 'dismissed' = 'open') => this.request<InboxItem[]>(`/inbox?status=${status}`);
  inboxAct = (id: string, action: InboxAction) =>
    this.request<InboxItem>(`/inbox/${encodeURIComponent(id)}/act`, { method: 'POST', body: JSON.stringify({ action }) });
  testboard = () => this.request<TestboardEntry[]>('/testboard');
  tiers = () => this.request<TierSummary[]>('/tiers');
  chatAgents = () => this.request<ChatAgent[]>('/chat/agents');
  chat = (body: { agent?: string; message?: string; history?: { role: 'user' | 'agent'; text: string }[]; strategyId?: string; button?: ChatButton }) =>
    this.request<ChatResult>('/chat', { method: 'POST', body: JSON.stringify(body) }, 210_000);
  approveProposal = (id: string) =>
    this.request<ChatProposal>(`/chat/proposals/${id}/approve`, { method: 'POST' }, 60_000);
  rejectProposal = (id: string) =>
    this.request<ChatProposal>(`/chat/proposals/${id}/reject`, { method: 'POST' });

  // --- Learning -------------------------------------------------------------
  changes = (limit = 50) => this.request<ChangeRecord[]>(`/chat/changes?limit=${limit}`);
  scoreboard = () => this.request<Scoreboard>('/chat/scoreboard');
  notebooks = () => this.request<Notebook[]>('/chat/notebooks');
  addNote = (agent: string, text: string) =>
    this.request<string[]>(`/chat/notebooks/${agent}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
  removeNote = (agent: string, index: number) =>
    this.request<string[]>(`/chat/notebooks/${agent}/notes/${index}`, { method: 'DELETE' });
  runLearning = (forceScore = false) =>
    this.request<{ scored: number; waiting: number; evaluated: number; errors: string[] }>(
      '/chat/learning/run',
      { method: 'POST', body: JSON.stringify({ forceScore }) },
      300_000,
    );
  evolve = () => this.request<{ settings: EvolveSettings; candidates: EvolveCandidate[] }>('/chat/evolve');
  setEvolve = (patch: Partial<EvolveSettings>) =>
    this.request<EvolveSettings>('/chat/evolve', { method: 'PUT', body: JSON.stringify(patch) });
  runEvolve = () =>
    this.request<{ evolved: { created: EvolveCandidate[]; skipped: string[] } }>('/chat/evolve/run', { method: 'POST' }, 600_000);
  promoteCandidate = (id: string) => this.request<unknown>(`/chat/evolve/candidates/${id}/promote`, { method: 'POST' });
  dismissCandidate = (id: string) => this.request<unknown>(`/chat/evolve/candidates/${id}/dismiss`, { method: 'POST' });

  markets = (symbols?: string[]) =>
    this.request<MarketStatus[]>(`/markets${symbols?.length ? `?symbols=${encodeURIComponent(symbols.join(','))}` : ''}`, {}, 60_000);

  journal = (from?: number, to?: number) =>
    this.request<JournalResponse>(`/journal?${from ? `from=${from}` : ''}${to ? `&to=${to}` : ''}`, {}, 120_000);

  strategyTrades = (id: string, from?: number, to?: number) =>
    this.request<StrategyTrades>(
      `/strategies/${id}/trades?${from ? `from=${from}` : ''}${to ? `&to=${to}` : ''}`,
      {},
      60_000,
    );

  logs = (limit = 200, strategyId?: string) =>
    this.request<LogEntry[]>(`/logs?limit=${limit}${strategyId ? `&strategyId=${strategyId}` : ''}`);

  /** Records a client-only action (currently just logout) into the shared activity feed. */
  logClientEvent = (event: string, message: string, data?: unknown) =>
    this.request<LogEntry>('/logs/client', { method: 'POST', body: JSON.stringify({ event, message, data }) });
}

// ---------------------------------------------------------------------------
// Live socket
// ---------------------------------------------------------------------------

type SocketHandlers = {
  onBot?: (snap: BotSnapshot) => void;
  onBots?: (snaps: BotSnapshot[]) => void;
  onLog?: (entry: LogEntry) => void;
  onLogs?: (entries: LogEntry[]) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export class LiveSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private conn: Connection, private handlers: SocketHandlers) {}

  connect(): void {
    if (this.closed) return;
    const url = `${this.conn.baseUrl.replace(/^http/i, 'ws')}/ws?key=${encodeURIComponent(this.conn.apiKey)}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retry = 0;
      this.handlers.onOpen?.();
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'bot') this.handlers.onBot?.(msg.payload);
        else if (msg.type === 'bots') this.handlers.onBots?.(msg.payload);
        else if (msg.type === 'log') this.handlers.onLog?.(msg.payload);
        else if (msg.type === 'logs') this.handlers.onLogs?.(msg.payload);
      } catch {
        /* a malformed frame should never take the socket down */
      }
    };
    this.ws.onerror = () => {
      /* onclose always follows, so reconnection is handled there */
    };
    this.ws.onclose = () => {
      this.handlers.onClose?.();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    // Exponential backoff, capped at 15s so a sleeping phone reconnects fast.
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
