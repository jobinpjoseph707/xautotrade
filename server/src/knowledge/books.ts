/**
 * Book notes. You paste a chapter you own; the server keeps a few SHORT concept notes with the page
 * number, never the text. The pasted text is used once and dropped: it is not written anywhere.
 */
import { KnowledgeGraph, type KgNode } from './graph.js';

export const MAX_CONCEPT_CHARS = 160;
export const MAX_CONCEPTS_PER_PASTE = 5;
/** A concept that repeats this many characters in a row from the paste is a copy, not a note. */
export const MAX_VERBATIM_RUN = 40;
export const MAX_PASTE_CHARS = 60_000;

/** Turns a pasted chapter into short concept lines (a model call in the app, a fake in tests). */
export type Summarize = (pasted: string) => Promise<string[]>;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** True when `concept` shares a run of MAX_VERBATIM_RUN characters or more with the pasted text. */
export function copiesText(concept: string, pasted: string): boolean {
  const c = norm(concept);
  const p = norm(pasted);
  if (c.length < MAX_VERBATIM_RUN) return false;
  for (let i = 0; i + MAX_VERBATIM_RUN <= c.length; i++) if (p.includes(c.slice(i, i + MAX_VERBATIM_RUN))) return true;
  return false;
}

export interface BookResult {
  kept: KgNode[];
  dropped: string[];
}

export async function ingestBookPaste(
  graph: KnowledgeGraph,
  input: { book: string; page: number; pasted: string },
  summarize: Summarize,
): Promise<BookResult> {
  const book = input.book.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!book) throw new Error('Say which book this is from.');
  if (!Number.isInteger(input.page) || input.page < 1) throw new Error('Give the page number the chapter starts on.');
  if (!input.pasted.trim()) throw new Error('Paste the chapter text first.');
  if (input.pasted.length > MAX_PASTE_CHARS) throw new Error(`That is too long (${input.pasted.length} characters). Paste one chapter at a time, up to ${MAX_PASTE_CHARS}.`);

  const lines = await summarize(input.pasted);
  const kept: KgNode[] = [];
  const dropped: string[] = [];
  for (const raw of lines.slice(0, MAX_CONCEPTS_PER_PASTE + 5)) {
    const concept = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_CONCEPT_CHARS);
    if (!concept) continue;
    if (kept.length >= MAX_CONCEPTS_PER_PASTE) {
      dropped.push(`${concept} (more than ${MAX_CONCEPTS_PER_PASTE} notes for one paste)`);
      continue;
    }
    if (copiesText(concept, input.pasted)) {
      dropped.push(`${concept} (copies the book's own words)`);
      continue;
    }
    const id = `concept_${book.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}_${input.page}_${kept.length + 1}`;
    kept.push(graph.addNode({ id, kind: 'concept', title: concept, source: 'book', data: { book, page: input.page } }));
  }
  // `input.pasted` goes out of scope here. Nothing above stored it.
  return { kept, dropped };
}
