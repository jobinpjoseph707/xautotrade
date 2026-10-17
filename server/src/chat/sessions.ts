/**
 * Saved chats. Every conversation with the agents (the Agents tab, or the chat on one strategy) is a
 * session kept in the app's SQLite file, so it survives a restart and shows on every device.
 *
 * A session belongs to ONE place: the Agents tab (no strategy) or one strategy. A strategy's chat never
 * sees another strategy's messages, and the Agents tab never sees a strategy's chat.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import type { Proposal } from './actions.js';
import type { ChatTurn } from './prompt.js';

export interface StoredMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  at: number;
  agentName?: string;
  /** The proposals as they were when the message was written. Their current status is read live. */
  proposals?: Proposal[];
  rejected?: string[];
}

export interface ChatSession {
  id: string;
  title: string;
  /** Null = the Agents tab. */
  strategyId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  strategyId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** The last thing said, shortened, for the list. */
  preview: string;
}

export const TITLE_MAX = 60;
export const MAX_SESSIONS = 200;
/** Most messages kept in one session. The oldest go first. */
export const MAX_MESSAGES = 200;
/** Most earlier turns an agent is shown. */
export const HISTORY_TURNS = 20;
export const NEW_TITLE = 'New chat';

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** A title from the first thing the owner said. */
export const titleFrom = (message: string): string => clip(oneLine(message), TITLE_MAX) || NEW_TITLE;

interface Row { id: string; title: string; strategy_id: string | null; created_at: number; updated_at: number; json: string }

export class ChatSessions {
  constructor(private readonly db: Database, private readonly clock: () => number = Date.now) {
    db.exec(`
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  strategy_id TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_scope ON chat_sessions(strategy_id, updated_at DESC);
`);
  }

  private read(r: Row): ChatSession {
    return { id: r.id, title: r.title, strategyId: r.strategy_id, createdAt: r.created_at, updatedAt: r.updated_at, messages: JSON.parse(r.json) as StoredMessage[] };
  }

  create(strategyId: string | null = null, title = NEW_TITLE): ChatSession {
    const now = this.clock();
    const s: ChatSession = { id: randomUUID(), title: clip(oneLine(title), TITLE_MAX) || NEW_TITLE, strategyId, createdAt: now, updatedAt: now, messages: [] };
    this.db.prepare('INSERT INTO chat_sessions (id, title, strategy_id, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)').run(s.id, s.title, s.strategyId, s.createdAt, s.updatedAt, '[]');
    this.prune();
    return s;
  }

  get(id: string): ChatSession | null {
    const r = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? this.read(r) : null;
  }

  /** Newest first. `strategyId` undefined = every chat; null = the Agents tab only; a string = that strategy only. */
  list(strategyId?: string | null): SessionSummary[] {
    const rows = (strategyId === undefined
      ? this.db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC, created_at DESC')
      : strategyId === null
        ? this.db.prepare('SELECT * FROM chat_sessions WHERE strategy_id IS NULL ORDER BY updated_at DESC, created_at DESC')
        : this.db.prepare('SELECT * FROM chat_sessions WHERE strategy_id = ? ORDER BY updated_at DESC, created_at DESC')
    ).all(...(typeof strategyId === 'string' ? [strategyId] : [])) as Row[];
    return rows.map((r) => {
      const s = this.read(r);
      const last = s.messages[s.messages.length - 1];
      return { id: s.id, title: s.title, strategyId: s.strategyId, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length, preview: last ? clip(oneLine(last.text), 100) : '' };
    });
  }

  /** Adds messages. The first thing the owner says names an unnamed session. */
  append(id: string, messages: Omit<StoredMessage, 'id' | 'at'>[]): ChatSession {
    const s = this.get(id);
    if (!s) throw new Error('That chat no longer exists.');
    const now = this.clock();
    const added: StoredMessage[] = messages.map((m) => ({ ...m, id: randomUUID(), at: now }));
    s.messages = [...s.messages, ...added].slice(-MAX_MESSAGES);
    if (s.title === NEW_TITLE) {
      const first = s.messages.find((m) => m.role === 'user');
      if (first) s.title = titleFrom(first.text);
    }
    s.updatedAt = now;
    this.db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ?, json = ? WHERE id = ?').run(s.title, s.updatedAt, JSON.stringify(s.messages), id);
    return s;
  }

  rename(id: string, title: string): ChatSession {
    const s = this.get(id);
    if (!s) throw new Error('That chat no longer exists.');
    const t = clip(oneLine(title), TITLE_MAX);
    if (!t) throw new Error('Give the chat a name.');
    this.db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(t, id);
    return { ...s, title: t };
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id).changes > 0;
  }

  /** What an agent is shown of an earlier conversation: the last few turns, text only. */
  history(id: string): ChatTurn[] {
    const s = this.get(id);
    return (s?.messages ?? []).slice(-HISTORY_TURNS).map((m) => ({ role: m.role, text: m.text }));
  }

  /** Keeps the newest MAX_SESSIONS chats. */
  private prune(): void {
    this.db.prepare(
      'DELETE FROM chat_sessions WHERE id IN (SELECT id FROM chat_sessions ORDER BY updated_at DESC LIMIT -1 OFFSET ?)',
    ).run(MAX_SESSIONS);
  }
}

/** Brings the proposals in a session up to date: what was decided since the message was written. */
export function withLiveProposals(s: ChatSession, current: (id: string) => Proposal | null | undefined): ChatSession {
  return {
    ...s,
    messages: s.messages.map((m) =>
      m.proposals ? { ...m, proposals: m.proposals.map((p) => { const live = current(p.id); return live ? { ...p, status: live.status, resultMessage: live.resultMessage } : p; }) } : m,
    ),
  };
}

export class SessionError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

/** The parts of a chat reply a session keeps. */
export interface ReplyLike {
  reply: string;
  agentName: string;
  proposals: Proposal[];
  rejected: string[];
}

/**
 * One message in a saved chat. The agent is shown that chat's own earlier turns (never anything the client
 * sends), a chat can only be used where it belongs, and both sides are saved only after the agent answered:
 * a failed call leaves the chat as it was.
 */
export async function chatInSession<R extends ReplyLike>(
  sessions: ChatSessions,
  body: { sessionId: string; strategyId?: unknown; message?: unknown; button?: unknown; agent?: unknown },
  ask: (input: { agent?: string; message?: string; strategyId?: string; button?: string; history: ChatTurn[] }) => Promise<R>,
): Promise<R> {
  const session = sessions.get(body.sessionId);
  if (!session) throw new SessionError('That chat no longer exists. Start a new one.', 404);
  const strategyId = typeof body.strategyId === 'string' && body.strategyId ? body.strategyId : null;
  if (session.strategyId !== strategyId) throw new SessionError('That chat belongs somewhere else.', 400);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const button = typeof body.button === 'string' ? body.button : undefined;
  const result = await ask({
    agent: typeof body.agent === 'string' ? body.agent : undefined,
    message: message || undefined,
    strategyId: strategyId ?? undefined,
    button,
    history: sessions.history(session.id),
  });
  sessions.append(session.id, [
    { role: 'user', text: message || (button ? `(${button})` : '') },
    { role: 'agent', text: result.reply, agentName: result.agentName, proposals: result.proposals, rejected: result.rejected },
  ]);
  return result;
}
