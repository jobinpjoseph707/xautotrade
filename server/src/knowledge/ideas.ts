/**
 * Ideas from outside (a video, a competition) and how they are described in prompts.
 *
 * An idea's STATUS comes only from measured outcomes of strategies built from it, never from who said
 * it or how often: "untested", "supported by N outcomes" or "contradicted by N outcomes".
 * Book notes are context. They carry no status and nothing here lets them touch a lesson's score.
 */
import { KnowledgeGraph, type KgNode, type Source } from './graph.js';

/** The part of a scored change this module reads. */
export interface OutcomeLike {
  strategyId: string | null;
  status: string;
  score: string;
}

export type IdeaStatus = { kind: 'untested' } | { kind: 'supported'; n: number } | { kind: 'contradicted'; n: number };

export const CONTRADICTED_AFTER = 2;

/** Measured outcomes only. Mixed or inconclusive results leave an idea untested. */
export function ideaStatus(outcomes: OutcomeLike[], strategyIds: Set<string>): IdeaStatus {
  let helped = 0;
  let hurt = 0;
  for (const o of outcomes) {
    if (!o.strategyId || !strategyIds.has(o.strategyId) || o.status !== 'approved') continue;
    if (o.score === 'helped') helped++;
    else if (o.score === 'hurt') hurt++;
  }
  if (hurt >= CONTRADICTED_AFTER && hurt > helped) return { kind: 'contradicted', n: hurt };
  if (helped >= 1 && helped > hurt) return { kind: 'supported', n: helped };
  return { kind: 'untested' };
}

export const statusText = (s: IdeaStatus): string =>
  s.kind === 'untested' ? 'untested' : s.kind === 'supported' ? `supported by ${s.n} outcome${s.n === 1 ? '' : 's'}` : `contradicted by ${s.n} outcome${s.n === 1 ? '' : 's'}`;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export interface IdeaInput {
  title: string;
  source: Extract<Source, 'youtube' | 'competition' | 'owner'>;
  /** Where it came from: a video id, a competition name. */
  origin: string;
  symbol?: string;
  /** One or two sentences: the entry idea. Sizing never goes in. */
  entry: string;
}

export function ideaId(source: string, origin: string, title: string): string {
  const slug = `${origin}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `idea_${source}_${slug}`;
}

export function addIdea(graph: KnowledgeGraph, input: IdeaInput): KgNode {
  return graph.addNode({
    id: ideaId(input.source, input.origin, input.title),
    kind: 'idea',
    title: clip(oneLine(input.title), 120),
    source: input.source,
    data: { origin: clip(oneLine(input.origin), 120), symbol: input.symbol?.toUpperCase(), entry: clip(oneLine(input.entry), 300) },
  });
}

/** Strategies built from an idea, through links that still hold. */
export const strategiesOf = (graph: KnowledgeGraph, ideaNodeId: string): Set<string> =>
  new Set(graph.neighbours(ideaNodeId, { rel: 'built_as' }).map((n) => n.id));

export function statusOfIdea(graph: KnowledgeGraph, idea: KgNode, outcomes: OutcomeLike[]): IdeaStatus {
  return ideaStatus(outcomes, strategiesOf(graph, idea.id));
}

/** Most knowledge lines any prompt gets. */
export const MAX_PROMPT_ITEMS = 5;
const MAX_LINE = 260;

/**
 * Lines for a prompt about one strategy: ideas on the same market first (with their measured status),
 * then book concepts. At most five in total, each one short, all labelled as data.
 */
export function knowledgeForPrompt(graph: KnowledgeGraph, outcomes: OutcomeLike[], about: { symbols: string[] }): string[] {
  const symbols = new Set(about.symbols.map((x) => x.toUpperCase()));
  const ideas = graph.nodes('idea').filter((n) => {
    const s = n.data.symbol;
    return s === undefined || symbols.has(String(s));
  });
  const lines: string[] = ideas.map((n) => clip(`idea from ${n.source}: "${n.title}". Entry: ${String(n.data.entry ?? '')} Status: ${statusText(statusOfIdea(graph, n, outcomes))}.`, MAX_LINE));
  const concepts = graph.nodes('concept').map((n) => clip(`book note, not evidence: "${n.title}" (${String(n.data.book ?? 'book')}, p. ${String(n.data.page ?? '?')}).`, MAX_LINE));
  return [...lines, ...concepts].slice(0, MAX_PROMPT_ITEMS);
}

/** A video strategy was sent to the Inbox: remember the idea and which strategy was built from it. */
export function recordVideoIdea(graph: KnowledgeGraph, strategy: { id: string; name: string; symbol: string; timeframe: string; indicators: { type?: string }[] }, videoId: string): KgNode {
  const kinds = [...new Set(strategy.indicators.map((i) => String(i.type ?? '').toUpperCase()).filter(Boolean))].join(', ') || 'rules from the video';
  const idea = addIdea(graph, {
    title: `YouTube ${videoId}`, source: 'youtube', origin: videoId, symbol: strategy.symbol,
    entry: `${strategy.symbol} ${strategy.timeframe} using ${kinds}.`,
  });
  graph.addNode({ id: strategy.id, kind: 'strategy', title: strategy.name, source: 'youtube', data: { symbol: strategy.symbol } });
  graph.link(idea.id, strategy.id, 'built_as', `Built from video ${videoId}`);
  return idea;
}
