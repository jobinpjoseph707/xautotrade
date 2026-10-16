/**
 * Competition methods: typed in by hand. The ENTRY idea is kept; how the winner sized positions is
 * thrown away, because sizing belongs to your own risk rules.
 */
import { KnowledgeGraph, type KgNode } from './graph.js';
import { addIdea } from './ideas.js';

export function addCompetitionMethod(graph: KnowledgeGraph, input: { competition: string; name: string; symbol?: string; entry: string; sizing?: string }): KgNode {
  if (!input.competition.trim() || !input.name.trim() || !input.entry.trim()) throw new Error('Give the competition, a name for the method and its entry idea.');
  // input.sizing is deliberately never read.
  return addIdea(graph, { title: input.name, source: 'competition', origin: input.competition, symbol: input.symbol, entry: input.entry });
}
