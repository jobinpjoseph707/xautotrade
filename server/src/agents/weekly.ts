/**
 * Manual weekly trigger:  npm run agents:weekly
 *
 * Runs the active agent's week on the paper broker, closes it out, and prints
 * the verdict. Starts generation 1 (EMA pullback preset) if none exists.
 * Later: schedule this with Windows Task Scheduler / cron.
 *
 * Env: AGENT_MIN_RETURN_PCT (default 1), AGENT_MAX_DRAWDOWN_PCT (default 5),
 *      AGENT_START_BALANCE (default 10000), AGENT_STORE (default data/agents.json)
 */
import { PaperBroker } from '../broker/paper.js';
import { emaPullbackScalp, fitSpreadCap } from '../engine/presets.js';
import { JsonFileAgentStore } from './store.js';
import { JsonFileLessonStore } from './lessonStore.js';
import { runWeekOnPaper } from './paperRunner.js';
import { closeOutWeek, startFirstAgent } from './rotation.js';

const criteria = {
  minReturnPct: Number(process.env.AGENT_MIN_RETURN_PCT ?? 1),
  maxDrawdownPct: Number(process.env.AGENT_MAX_DRAWDOWN_PCT ?? 5),
};
const store = new JsonFileAgentStore(process.env.AGENT_STORE ?? 'data/agents.json');
const lessons = new JsonFileLessonStore(process.env.LESSON_STORE ?? 'data/lessons.json');

let agent = store.getActive();
if (!agent) {
  const symbol = process.env.AGENT_SYMBOL ?? 'XAUUSD';
  const strategy = emaPullbackScalp(symbol);
  // The preset's 20-point spread cap suits EURUSD; on wider-spread symbols (gold ~30)
  // it blocks every entry and the week ends with zero trades. Scale it to the symbol.
  const spec = await new PaperBroker().getSymbolSpec(symbol);
  fitSpreadCap(strategy, spec.spreadPoints);
  agent = startFirstAgent(store, strategy, Number(process.env.AGENT_START_BALANCE ?? 10_000), new Date());
  console.log(`Started ${agent.agentId} (paper mode)`);
}

const outcome = await runWeekOnPaper(agent);
const { record, next, alreadyClosed } = closeOutWeek(store, agent, outcome, criteria, console.log, () => new Date(), lessons);
console.log(alreadyClosed ? '(week was already closed)' : '');
console.log(`${record.agentId} week ${record.weekStart.slice(0, 10)}: ${record.verdict.toUpperCase()}`);
for (const r of record.reasons) console.log(`  - ${r}`);
console.log(`Next: ${next.agentId} (gen ${next.generation}) week ${next.weekStart.slice(0, 10)}`);
