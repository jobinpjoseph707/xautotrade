/**
 * Show or replace the API key the phone app must send.
 *   npm run key            prints the current key (once, on request)
 *   npm run key -- rotate  makes a new random key; the old one stops working at once
 * Restart the server after rotating. Paste the new key into the app under Settings.
 */
import { randomBytes } from 'node:crypto';

import { settings } from '../src/store.js';

const current = settings.get<string>('apiKey', '');
if (process.argv[2] === 'rotate') {
  const next = randomBytes(16).toString('hex');
  settings.set('apiKey', next);
  console.log(`New API key: ${next}`);
  console.log('Restart the server, then paste this key into the app under Settings.');
  if (process.env.API_KEY) console.log('Note: API_KEY is set in your environment or .env and overrides this. Change it there too.');
} else if (current) {
  console.log(`API key: ${current}`);
} else {
  console.log('No key yet. Start the server once and one will be made.');
}
