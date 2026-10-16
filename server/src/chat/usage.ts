/**
 * Token use, grouped the two ways the Settings panel shows it: by UTC day and by agent.
 * Pure: takes the rows, returns the groups. The rows come from the `chat_usage` table.
 */
export interface UsageRow {
  ts: number;
  /** The agent (or "router", "evolve", "digest"); null when the call had no label. */
  tag: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | null;
}

export interface UsageGroup {
  calls: number;
  totalTokens: number;
  costUsd: number;
}

export interface DayUsage extends UsageGroup {
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** The same day split by agent. */
  agents: ({ agent: string } & UsageGroup)[];
}

export interface AgentUsage extends UsageGroup {
  agent: string;
}

const isoDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const empty = (): UsageGroup => ({ calls: 0, totalTokens: 0, costUsd: 0 });
function add(g: UsageGroup, r: UsageRow): void {
  g.calls += 1;
  g.totalTokens += r.inputTokens + r.outputTokens;
  g.costUsd += r.costUsd ?? 0;
}

/** Newest day first; agents within a day, busiest first. */
export function groupUsage(rows: UsageRow[]): { byDay: DayUsage[]; byAgent: AgentUsage[] } {
  const days = new Map<string, { total: UsageGroup; agents: Map<string, UsageGroup> }>();
  const agents = new Map<string, UsageGroup>();
  for (const r of rows) {
    const day = isoDay(r.ts);
    const agent = r.tag ?? 'other';
    const d = days.get(day) ?? { total: empty(), agents: new Map() };
    days.set(day, d);
    add(d.total, r);
    const da = d.agents.get(agent) ?? empty();
    d.agents.set(agent, da);
    add(da, r);
    const a = agents.get(agent) ?? empty();
    agents.set(agent, a);
    add(a, r);
  }
  const byTokens = <T extends UsageGroup>(a: T, b: T): number => b.totalTokens - a.totalTokens;
  return {
    byDay: [...days.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, d]) => ({
        day,
        ...d.total,
        agents: [...d.agents.entries()].map(([agent, g]) => ({ agent, ...g })).sort(byTokens),
      })),
    byAgent: [...agents.entries()].map(([agent, g]) => ({ agent, ...g })).sort(byTokens),
  };
}
