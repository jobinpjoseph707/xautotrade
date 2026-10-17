/** Groups saved chats by IST day and builds the labels the Previous chats list shows. */
import type { ChatSessionSummary } from '../types';
import { istDate, istTime } from './time';

/** IST calendar day number (days since 1970) — so "today" follows India's clock, not the computer's. */
const IST_OFFSET_MS = 5.5 * 3600_000;
export const istDay = (ts: number): number => Math.floor((ts + IST_OFFSET_MS) / 86_400_000);

export type SessionGroup = { label: string; sessions: ChatSessionSummary[] };

/** Group chats under Today / Yesterday / Earlier, newest first inside each group. */
export function groupSessions(list: ChatSessionSummary[], now: number): SessionGroup[] {
  const today = istDay(now);
  const buckets: Record<'Today' | 'Yesterday' | 'Earlier', ChatSessionSummary[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const s of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const d = istDay(s.updatedAt);
    buckets[d >= today ? 'Today' : d === today - 1 ? 'Yesterday' : 'Earlier'].push(s);
  }
  return (['Today', 'Yesterday', 'Earlier'] as const).filter((k) => buckets[k].length).map((k) => ({ label: k, sessions: buckets[k] }));
}

/** "14:05" for today's chats, "9 Oct" for older ones. */
export function sessionWhen(ts: number, now: number): string {
  return istDay(ts) >= istDay(now) ? istTime(ts) : istDate(ts);
}

export const messageCountLabel = (n: number): string => (n === 1 ? '1 message' : `${n} messages`);

/** A chat with no messages yet is not worth listing. */
export const isEmptySession = (s: Pick<ChatSessionSummary, 'messageCount'>): boolean => s.messageCount === 0;
