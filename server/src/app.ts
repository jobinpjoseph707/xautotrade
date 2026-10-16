import cors from 'cors';
import express, { type Express } from 'express';

import { router } from './api/routes.js';
import { config } from './config.js';
import { corsOriginAllowed } from './security.js';

/**
 * Builds the Express app without listening, so tests can start it on any port.
 * index.ts owns the API-key bootstrap, the WebSocket and listen().
 */
export function createApp(): Express {
  const app = express();
  // Only this computer, your home network and Tailscale may call the API from a web page.
  app.use(cors({ origin: (origin, cb) => cb(null, corsOriginAllowed(origin)) }));
  app.use(express.json({ limit: '4mb' }));

  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    // Header only: a key in the address would end up in logs and browser history. (The live feed, /ws, takes it in the address.)
    const key = req.header('x-api-key');
    if (key !== config.apiKey) {
      res.status(401).json({ ok: false, error: 'Invalid or missing API key.' });
      return;
    }
    next();
  });

  app.use('/api', router);

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
  return app;
}
