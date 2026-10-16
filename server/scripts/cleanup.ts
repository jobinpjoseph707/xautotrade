// Usage (from server/, with the server STOPPED):
//   npm run cleanup            dry run, prints what it would do
//   npm run cleanup -- --apply backs up the database, then does it
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runCleanup } from '../src/scripts/cleanup.js';
import { backupDatabase, strategies } from '../src/store.js';

const apply = process.argv.includes('--apply');
const result = runCleanup(
  {
    store: strategies,
    backup: () => {
      mkdirSync('data/backups', { recursive: true });
      const path = join('data/backups', `xautotrade-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      backupDatabase(path);
      return path;
    },
  },
  { apply },
);
for (const line of result.lines) console.log(line);
