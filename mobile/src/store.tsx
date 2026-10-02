import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Api, LiveSocket, loadConnection, saveConnection, clearConnection, type Connection } from './api';
import type { AccountInfo, BotSnapshot, Catalog, LogEntry, MarketStatus, Strategy } from './types';

interface AppState {
  ready: boolean;
  connection: Connection | null;
  api: Api | null;
  connected: boolean;
  socketUp: boolean;
  account: AccountInfo | null;
  /** When `account` was last fetched (ms), for the "updated Xs ago" hint. */
  accountAt: number | null;
  catalog: Catalog | null;
  strategies: Strategy[];
  /** Market status per symbol used by any strategy (offered? open?), refreshed every minute. */
  markets: Record<string, MarketStatus>;
  bots: Record<string, BotSnapshot>;
  logs: LogEntry[];
  error: string | null;

  connect(c: Connection): Promise<void>;
  disconnect(): Promise<void>;
  refresh(): Promise<void>;
  refreshStrategies(): Promise<void>;
  refreshAccount(): Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connected, setConnected] = useState(false);
  const [socketUp, setSocketUp] = useState(false);
  const [account, setAccountRaw] = useState<AccountInfo | null>(null);
  const [accountAt, setAccountAt] = useState<number | null>(null);
  const setAccount = useCallback((a: AccountInfo | null) => {
    setAccountRaw(a);
    if (a) setAccountAt(Date.now());
  }, []);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [markets, setMarkets] = useState<Record<string, MarketStatus>>({});
  const [bots, setBots] = useState<Record<string, BotSnapshot>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<LiveSocket | null>(null);
  const api = useMemo(() => (connection ? new Api(connection) : null), [connection]);

  const openSocket = useCallback((conn: Connection) => {
    socketRef.current?.close();
    const s = new LiveSocket(conn, {
      onOpen: () => setSocketUp(true),
      onClose: () => setSocketUp(false),
      onBot: (snap) => setBots((prev) => ({ ...prev, [snap.strategyId]: snap })),
      onBots: (snaps) =>
        setBots(Object.fromEntries(snaps.map((s2) => [s2.strategyId, s2]))),
      onLog: (entry) => setLogs((prev) => [entry, ...prev].slice(0, 400)),
      onLogs: (entries) => setLogs(entries),
    });
    s.connect();
    socketRef.current = s;
  }, []);

  const bootstrap = useCallback(
    async (conn: Connection) => {
      const client = new Api(conn);
      await client.health(); // fails fast with a readable message if unreachable
      const [cat, acct, strats, botList, logList] = await Promise.all([
        client.catalog(),
        client.account().catch(() => null),
        client.strategies(),
        client.bots(),
        client.logs(120),
      ]);
      setCatalog(cat);
      setAccount(acct);
      setStrategies(strats);
      setBots(Object.fromEntries(botList.map((b) => [b.strategyId, b])));
      setLogs(logList);
      setConnected(true);
      setError(null);
      openSocket(conn);
    },
    [openSocket],
  );

  // Restore a saved connection on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadConnection();
      if (cancelled) return;
      if (saved) {
        setConnection(saved);
        try {
          await bootstrap(saved);
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      socketRef.current?.close();
    };
  }, [bootstrap]);

  const connect = useCallback(
    async (c: Connection) => {
      await bootstrap(c);
      await saveConnection(c);
      setConnection(c);
    },
    [bootstrap],
  );

  const disconnect = useCallback(async () => {
    socketRef.current?.close();
    socketRef.current = null;
    await clearConnection();
    setConnection(null);
    setConnected(false);
    setSocketUp(false);
    setAccount(null);
    setStrategies([]);
    setBots({});
    setLogs([]);
  }, []);

  const refreshStrategies = useCallback(async () => {
    if (!api) return;
    setStrategies(await api.strategies());
  }, [api]);

  const refreshAccount = useCallback(async () => {
    if (!api) return;
    try {
      setAccount(await api.account());
    } catch {
      /* the account call fails while the market data feed is warming up; harmless */
    }
  }, [api]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [acct, strats, botList] = await Promise.all([
        api.account().catch(() => null),
        api.strategies(),
        api.bots(),
      ]);
      setAccount(acct);
      setStrategies(strats);
      setBots(Object.fromEntries(botList.map((b) => [b.strategyId, b])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  // Which symbols can actually be traded (a strategy on BTCUSD can never run on
  // MetaQuotes-Demo, which has no crypto). Refreshed when strategies change and every minute.
  const symbolsKey = [...new Set(strategies.map((s) => s.symbol.toUpperCase()))].sort().join(',');
  useEffect(() => {
    if (!connected || !api || !symbolsKey) return;
    let alive = true;
    const load = () =>
      api
        .markets(symbolsKey.split(','))
        .then((list) => alive && setMarkets(Object.fromEntries(list.map((m) => [m.symbol.toUpperCase(), m]))))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connected, api, symbolsKey]);

  // Balance/equity are not pushed over the websocket, so keep them fresh on a
  // timer while connected — otherwise the dashboard header drifts from MT5.
  useEffect(() => {
    if (!connected || !api) return;
    const t = setInterval(() => void refreshAccount(), 10_000);
    return () => clearInterval(t);
  }, [connected, api, refreshAccount]);

  // Poll while any bot is live, as a backstop for a dropped socket. Matches
  // the server's floating-P&L refresh cadence so a lost websocket doesn't
  // make the dashboard look any less live than a connected one.
  useEffect(() => {
    const anyRunning = Object.values(bots).some((b) => b.status === 'running');
    if (!connected || !anyRunning || socketUp) return;
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [connected, bots, socketUp, refresh]);

  const value: AppState = {
    ready,
    connection,
    api,
    connected,
    socketUp,
    account,
    accountAt,
    catalog,
    strategies,
    markets,
    bots,
    logs,
    error,
    connect,
    disconnect,
    refresh,
    refreshStrategies,
    refreshAccount,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
