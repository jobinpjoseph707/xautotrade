import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ActiveAgent, AgentRecord } from './types.js';

/**
 * Append-only record store. A completed week's record is written exactly once;
 * a second write for the same agent+week throws rather than overwriting.
 */
export interface AgentStore {
  getRecord(agentId: string, weekStart: string): AgentRecord | undefined;
  appendRecord(record: AgentRecord): void;
  allRecords(): AgentRecord[];
  getActive(): ActiveAgent | null;
  setActive(agent: ActiveAgent): void;
}

interface Data {
  records: AgentRecord[];
  active: ActiveAgent | null;
}

const clone = <T>(v: T): T => structuredClone(v);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export class MemoryAgentStore implements AgentStore {
  protected data: Data = { records: [], active: null };

  getRecord(agentId: string, weekStart: string): AgentRecord | undefined {
    return this.data.records.find((r) => r.agentId === agentId && r.weekStart === weekStart);
  }

  appendRecord(record: AgentRecord): void {
    if (this.getRecord(record.agentId, record.weekStart)) {
      throw new Error(`Record for ${record.agentId} week ${record.weekStart} already exists and is immutable.`);
    }
    this.data.records.push(deepFreeze(clone(record)));
    this.persist();
  }

  allRecords(): AgentRecord[] {
    return [...this.data.records];
  }

  getActive(): ActiveAgent | null {
    return this.data.active ? clone(this.data.active) : null;
  }

  setActive(agent: ActiveAgent): void {
    this.data.active = clone(agent);
    this.persist();
  }

  protected persist(): void {}
}

/** JSON file on disk, written atomically (tmp file + rename). */
export class JsonFileAgentStore extends MemoryAgentStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Data;
      this.data = { records: (parsed.records ?? []).map(deepFreeze), active: parsed.active ?? null };
    }
  }

  protected override persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
