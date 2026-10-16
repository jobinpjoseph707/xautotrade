import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import { startLearningLoop } from './api/chat.js';
import { startInboxFeed } from './api/inbox.js';
import { createApp } from './app.js';
import { config, selectedBroker } from './config.js';
import { manager } from './live/manager.js';
import { logs, settings } from './store.js';

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
      `  API key     ${config.apiKey}`,
      '',
      '  Paste that API key into the mobile app under Settings.',
      '',
    ].join('\n'),
  );
  void manager.restoreAutostart();
  manager.startFloatingRefresh(); // keeps dashboard P&L live between bar closes
  startLearningLoop(); // scores approved agent changes, judges auto-evolve variants
});

const shutdown = async (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — stopping bots. Open positions are NOT closed automatically.`);
  manager.stopFloatingRefresh();
  await manager.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
