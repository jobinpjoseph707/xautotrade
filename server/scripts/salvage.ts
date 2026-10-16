// Usage (from server/, with the server STOPPED):
//   npm run salvage -- xautotrade.db
//   npm run salvage -- C:\path\to\old.db new.db
// Never changes the damaged file and never overwrites an existing one.
import { salvage } from '../src/scripts/salvage.js';

const source = process.argv[2];
if (!source) {
  console.log('Usage: npm run salvage -- <damaged-file.db> [new-file.db]');
  process.exit(1);
}
const dest = process.argv[3] ?? 'xautotrade.recovered.db';
const r = salvage(source, dest);
for (const line of r.lines) console.log(line);
if ((r.copied.strategies ?? 0) > 0) {
  console.log('');
  console.log('Next, still with the server stopped:');
  console.log('  1. del xautotrade.db*');
  console.log(`  2. ren ${dest} xautotrade.db`);
  console.log('  3. npm run dev');
}
