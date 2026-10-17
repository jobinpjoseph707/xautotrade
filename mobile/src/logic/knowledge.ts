/** Pure rules for the Ideas sheet (no React Native imports) so they can be unit-tested. */
import type { KnowledgeIdea } from '../types';

export const BOOK_NOTE = 'The server keeps a few short notes and the page number. The text you paste is used once and not saved.';
export const COMPETITION_NOTE = 'Only the entry idea is kept. How the winner sized positions is thrown away: size comes from your own risk settings.';
export const STATUS_NOTE = 'Status comes only from how strategies built from the idea actually did. A book note is context, never evidence.';

export const SOURCE_LABEL: Record<KnowledgeIdea['source'], string> = { youtube: 'YouTube', competition: 'Competition', book: 'Book', agent: 'Agent', owner: 'You' };

export type BookForm = { book: string; page: string; pasted: string };
/** What is missing from the book form, in plain words. Null when it can be sent. */
export function bookProblem(f: BookForm): string | null {
  if (!f.book.trim()) return 'Say which book it is from.';
  const page = Number(f.page);
  if (!Number.isInteger(page) || page < 1) return 'Give the page the chapter starts on.';
  if (!f.pasted.trim()) return 'Paste the chapter text.';
  return null;
}

export type CompetitionForm = { competition: string; name: string; symbol: string; entry: string };
export function competitionProblem(f: CompetitionForm): string | null {
  if (!f.competition.trim()) return 'Say which competition it came from.';
  if (!f.name.trim()) return 'Give the method a short name.';
  if (!f.entry.trim()) return 'Describe the entry idea.';
  return null;
}

export const statusTone = (status: string): 'good' | 'critical' | 'neutral' => (status.startsWith('supported') ? 'good' : status.startsWith('contradicted') ? 'critical' : 'neutral');
