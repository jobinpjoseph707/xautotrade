import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import { startLearningLoop } from './api/chat.js';
import { startInboxFeed } from './api/inbox.js';
import { createApp } from './app.js';
import { config, selectedBroker } from './config.js';
import { manager } from './live/manager.js';
import { inbox } from './inbox/instance.js';
import { marketStatus } from './api/markets.js';
import { KillSwitch } from './safety/killSwitch.js';
import { StallWatch } from './safety/stall.js';
import { maskKey } from './security.js';
import { logs, settings, strategies } from './store.js';

// An API key is generated and persisted on first boot so the server is never
// wide open by accident, even on a LAN.
if (!config.apiKey) {
  config.apiKey = settings.get<string>('apiKey', '') || randomBytes(16).toString('hex');
  settings.set('apiKey', config.apiKey);
}

const app = createApp();

const server = createServer(app);

// ---------------------------------------------------------------------------
// WebSocket: push bot status and log lines to the app in real time
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set<WebSocket>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', 'http://localhost');
  if (url.searchParams.get('key') !== config.apiKey) {
    ws.close(4001, 'Invalid API key');
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'bots', payload: manager.snapshots() }));
  ws.send(JSON.stringify({ type: 'logs', payload: logs.recent(50) }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// --- Safety: daily loss cap and stall watch ---------------------------------------------------------
const killSwitch = new KillSwitch({
  broker: manager.broker,
  pauseAll: () => manager.pauseAllBySafety(),
  inbox,
  store: settings,
  capPct: () => settings.get<number>('safety:dailyLossCapPct', 3),
});
manager.setStartGuard(() => killSwitch.startBlockedReason());
const stallWatch = new StallWatch({
  snapshots: () => manager.snapshots(),
  strategy: (id) => strategies.get(id),
  marketOpen: async (symbol) => (await marketStatus(symbol)).open,
  inbox,
});

startInboxFeed(); // errors and losing streaks become Inbox cards
manager.on('status', (snap) => broadcast('bot', snap));
manager.on('log', (entry) => broadcast('log', entry));

// Keep the DB from growing without bound.
setInterval(() => logs.prune(5000), 3_600_000).unref();

// ---------------------------------------------------------------------------

server.listen(config.port, () => {
  const kind = selectedBroker();
  const mode =
    kind === 'paper'
      ? 'PAPER (synthetic data — no broker attached)'
      : kind === 'metaapi'
        ? 'METAAPI (cloud MT5 bridge)'
        : config.mt5McpTransport === 'http'
          ? `MT5-MCP (bridge at ${config.mt5McpUrl})`
          : `MT5-MCP (local bridge, spawned via ${config.mt5McpCommand})`;
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '  XAutoTrade server',
      `  ─────────────────────────────────────────────`,
      `  Listening   http://0.0.0.0:${config.port}`,
      `  Mode        ${mode}`,
      `  Live orders ${config.allowLiveTrading ? 'ALLOWED on real accounts' : 'demo accounts only (safe default)'}`,
      `  API key     ${maskKey(config.apiKey)}  (run "npm run key" to show it)`,
      '',
      '  Paste the API key into the mobile app under Settings.',
      '',
    ].join('\n'),
  );
  // Read the heartbeat BEFORE writing a new one, so a long outage is noticed.
  void manager.restoreAutostart().finally(() => manager.startHeartbeat());
  manager.startFloatingRefresh(); // keeps dashboard P&L live between bar closes
  killSwitch.start();
  stallWatch.start();
  startLearningLoop(); // scores approved agent changes, judges auto-evolve variants
});

const shutdown = async (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — stopping bots. Open positions are NOT closed automatically.`);
  manager.stopFloatingRefresh();
  manager.stopHeartbeat();
  await manager.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
