/**
 * A small graph of ideas in two ordinary SQLite tables (no graph database).
 *
 * Nodes are ideas (from a video, a competition), concept notes (from a book) and strategies. Links
 * say how two nodes relate and carry "valid from / valid until". A link that turns out wrong is
 * CLOSED (valid until = now, with the reason), never deleted, so the history stays readable.
 */
import type { Database } from 'better-sqlite3';

export type NodeKind = 'idea' | 'concept' | 'strategy';
export type Source = 'youtube' | 'book' | 'competition' | 'agent' | 'owner';

export interface KgNode {
  id: string;
  kind: NodeKind;
  title: string;
  source: Source;
  /** Short facts about the node. Never full text from a book. */
  data: Record<string, unknown>;
  createdAt: number;
}

export interface KgEdge {
  id: number;
  from: string;
  to: string;
  rel: string;
  validFrom: number;
  /** Null while the link still holds. */
  validUntil: number | null;
  note: string;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kg_nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  source     TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kg_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  rel         TEXT NOT NULL,
  valid_from  INTEGER NOT NULL,
  valid_until INTEGER,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_to ON kg_edges(to_id);
`;

interface NodeRow { id: string; kind: NodeKind; title: string; source: Source; data: string; created_at: number }
interface EdgeRow { id: number; from_id: string; to_id: string; rel: string; valid_from: number; valid_until: number | null; note: string }

const toNode = (r: NodeRow): KgNode => ({ id: r.id, kind: r.kind, title: r.title, source: r.source, data: JSON.parse(r.data) as Record<string, unknown>, createdAt: r.created_at });
const toEdge = (r: EdgeRow): KgEdge => ({ id: r.id, from: r.from_id, to: r.to_id, rel: r.rel, validFrom: r.valid_from, validUntil: r.valid_until, note: r.note });

export class KnowledgeGraph {
  constructor(private readonly db: Database, private readonly clock: () => number = Date.now) {
    db.exec(SCHEMA);
  }

  addNode(n: { id: string; kind: NodeKind; title: string; source: Source; data?: Record<string, unknown> }): KgNode {
    this.db
      .prepare(`INSERT INTO kg_nodes (id, kind, title, source, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET title = excluded.title, data = excluded.data`)
      .run(n.id, n.kind, n.title, n.source, JSON.stringify(n.data ?? {}), this.clock());
    return this.node(n.id)!;
  }

  node(id: string): KgNode | null {
    const r = this.db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return r ? toNode(r) : null;
  }

  nodes(kind?: NodeKind): KgNode[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM kg_nodes WHERE kind = ? ORDER BY created_at DESC, id').all(kind)
      : this.db.prepare('SELECT * FROM kg_nodes ORDER BY created_at DESC, id').all()) as NodeRow[];
    return rows.map(toNode);
  }

  /** Adds a link. The same open link between the same two nodes is not added twice. */
  link(from: string, to: string, rel: string, note = ''): KgEdge {
    if (!this.node(from) || !this.node(to)) throw new Error('Both ends of a link must exist.');
    const open = this.db.prepare('SELECT * FROM kg_edges WHERE from_id = ? AND to_id = ? AND rel = ? AND valid_until IS NULL').get(from, to, rel) as EdgeRow | undefined;
    if (open) return toEdge(open);
    const info = this.db.prepare('INSERT INTO kg_edges (from_id, to_id, rel, valid_from, note) VALUES (?, ?, ?, ?, ?)').run(from, to, rel, this.clock(), note);
    return this.edge(Number(info.lastInsertRowid))!;
  }

  edge(id: number): KgEdge | null {
    const r = this.db.prepare('SELECT * FROM kg_edges WHERE id = ?').get(id) as EdgeRow | undefined;
    return r ? toEdge(r) : null;
  }

  /** The link was contradicted. It stops holding from now on, and stays in the history with the reason. */
  contradict(edgeId: number, why: string): KgEdge {
    const e = this.edge(edgeId);
    if (!e) throw new Error('No such link.');
    if (e.validUntil !== null) return e;
    this.db.prepare('UPDATE kg_edges SET valid_until = ?, note = ? WHERE id = ?').run(this.clock(), [e.note, `Closed: ${why}`].filter(Boolean).join(' '), edgeId);
    return this.edge(edgeId)!;
  }

  /** Every link touching a node, closed ones included (the history). */
  history(id: string): KgEdge[] {
    const rows = this.db.prepare('SELECT * FROM kg_edges WHERE from_id = ? OR to_id = ? ORDER BY id').all(id, id) as EdgeRow[];
    return rows.map(toEdge);
  }

  /** Links that hold at a moment (default: now), in either direction. */
  private holding(id: string, at: number): { edge: KgEdge; other: string }[] {
    return this.history(id)
      .filter((e) => e.validFrom <= at && (e.validUntil === null || at < e.validUntil))
      .map((edge) => ({ edge, other: edge.from === id ? edge.to : edge.from }));
  }

  /** Nodes one step away through links that hold. */
  neighbours(id: string, opts: { rel?: string; at?: number } = {}): KgNode[] {
    const at = opts.at ?? this.clock();
    const seen = new Set<string>();
    const out: KgNode[] = [];
    for (const { edge, other } of this.holding(id, at)) {
      if (opts.rel && edge.rel !== opts.rel) continue;
      if (seen.has(other)) continue;
      seen.add(other);
      const n = this.node(other);
      if (n) out.push(n);
    }
    return out;
  }

  /** Paths of at most `maxHops` links between two nodes, through links that hold. Shortest first. */
  paths(from: string, to: string, opts: { maxHops?: number; at?: number } = {}): string[][] {
    const maxHops = opts.maxHops ?? 2;
    const at = opts.at ?? this.clock();
    const found: string[][] = [];
    const walk = (path: string[]) => {
      const last = path[path.length - 1];
      if (last === to && path.length > 1) {
        found.push(path);
        return;
      }
      if (path.length - 1 >= maxHops) return;
      for (const { other } of this.holding(last, at)) if (!path.includes(other)) walk([...path, other]);
    };
    walk([from]);
    return found.sort((a, b) => a.length - b.length);
  }
}
