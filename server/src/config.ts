import 'dotenv/config';

export type BrokerKind = 'paper' | 'metaapi' | 'mt5mcp';

export const config = {
  port: Number(process.env.PORT ?? 4000),

  /**
   * MetaApi API token. Leave unset (and MT5MCP_URL unset too) to run the whole
   * app in paper mode against synthetic data — useful for building and testing
   * strategies offline.
   */
  metaApiToken: process.env.METAAPI_TOKEN ?? '',
  metaApiAccountId: process.env.METAAPI_ACCOUNT_ID ?? '',
  /** MetaApi deployment region, e.g. new-york, london, singapore. */
  metaApiRegion: process.env.METAAPI_REGION ?? 'new-york',

  /**
   * MT5-via-MCP bridge — the free, self-hosted alternative to MetaApi. Talks to
   * a locally running MT5 desktop terminal through the community
   * mcp-metatrader5-server. See server/README-mt5mcp.md for setup.
   *
   * Default transport is stdio: this server spawns the Python bridge itself as
   * a child process, so there is no second terminal window and no port to
   * configure. MT5 desktop still has to be open and logged in.
   */
  mt5McpTransport: (process.env.MT5MCP_TRANSPORT as 'stdio' | 'http') || 'stdio',
  mt5McpCommand: process.env.MT5MCP_COMMAND ?? 'uvx',
  /** Comma-separated, to keep it expressible in a .env file. */
  mt5McpArgs: (process.env.MT5MCP_ARGS ?? '--from,mcp-metatrader5-server,mt5mcp')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean),
  mt5McpUrl: process.env.MT5MCP_URL ?? '',
  /**
   * Path to terminal64.exe. Normally leave blank — the bridge attaches to an
   * already-running terminal. Only set this if account calls fail because MT5
   * was not initialised.
   */
  mt5McpTerminalPath: process.env.MT5MCP_TERMINAL_PATH ?? '',
  mt5McpLogin: process.env.MT5MCP_LOGIN ?? '',
  mt5McpPassword: process.env.MT5MCP_PASSWORD ?? '',
  mt5McpServer: process.env.MT5MCP_SERVER ?? '',
  /**
   * Empty means auto-detect per symbol from the broker's own filling mask,
   * which is what a broker that accepts IOC on one instrument and refuses it
   * on another requires. Set it only to pin one mode for debugging.
   */
  mt5McpFillMode: (process.env.MT5MCP_FILL_MODE as 'ioc' | 'fok' | 'return' | '') || undefined,
  mt5McpDeviationPoints: Number(process.env.MT5MCP_DEVIATION_POINTS ?? 20),

  dbPath: process.env.DB_PATH ?? './xautotrade.db',
  /**
   * Shared secret the mobile app must send as `x-api-key`. Generated on first
   * boot if unset and printed to the console.
   */
  apiKey: process.env.API_KEY ?? '',
  /**
   * Hard safety switch. While false the server will refuse to place orders on
   * an account whose type is not demo, no matter what the app asks for.
   */
  allowLiveTrading: process.env.ALLOW_LIVE_TRADING === 'true',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

/**
 * Explicit BROKER=paper|metaapi|mt5mcp always wins. Otherwise infer from
 * which credentials are present, preferring MetaApi if both happen to be set.
 */
export function selectedBroker(): BrokerKind {
  const explicit = (process.env.BROKER ?? '').toLowerCase();
  if (explicit === 'paper' || explicit === 'metaapi' || explicit === 'mt5mcp') return explicit;
  if (config.metaApiToken && config.metaApiAccountId) return 'metaapi';
  // The stdio bridge has no URL to detect, so mt5mcp must be chosen explicitly
  // via BROKER=mt5mcp — that also stops it being selected by accident.
  if (config.mt5McpUrl) return 'mt5mcp';
  return 'paper';
}

/**
 * The broker the owner clearly chose, or null when nothing was chosen. The server uses this at startup so a
 * missing or misplaced .env can never silently turn into fake "paper" data: no choice = it refuses to start.
 * Paper is only used when BROKER=paper is written down on purpose (the automated tests do that).
 */
export function chosenBroker(env: Record<string, string | undefined> = process.env): BrokerKind | null {
  const explicit = (env.BROKER ?? '').trim().toLowerCase();
  if (explicit === 'paper' || explicit === 'metaapi' || explicit === 'mt5mcp') return explicit;
  if (env.METAAPI_TOKEN && env.METAAPI_ACCOUNT_ID) return 'metaapi';
  if (env.MT5MCP_URL) return 'mt5mcp';
  return null;
}

export const isPaperMode = () => selectedBroker() === 'paper';
