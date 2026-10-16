/** Pure token-usage presentation rules (no React Native imports) so they can be unit-tested. */
import type { ChatUsage, UsageGroup } from '../types';

export const USAGE_TITLE = 'Claude use';
export const USAGE_NOTE = 'Your own chat messages are never limited. Only calls the app makes by itself (auto-evolve, the weekly summary) count toward the daily limit.';
export const USAGE_PERIODS: { id: ChatUsage['period']; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

/** 950 -> "950", 12_400 -> "12.4k", 2_300_000 -> "2.3M". */
export function tokensLabel(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export const costLabel = (usd: number): string => `$${usd.toFixed(2)}`;

export const groupLine = (g: UsageGroup): string => `${g.calls} ${g.calls === 1 ? 'call' : 'calls'} · ${tokensLabel(g.totalTokens)} tokens · ${costLabel(g.costUsd)}`;

/** "7 of 40 automatic calls used today", or a warning when stopped. */
export function capLine(u: ChatUsage['unattended']): string {
  if (u.signedOut) return 'Automatic calls are paused today: Claude is not signed in on the laptop.';
  if (u.used >= u.cap) return `All ${u.cap} automatic calls are used for today. They start again at 00:00 UTC.`;
  return `${u.used} of ${u.cap} automatic calls used today`;
}

export const capTone = (u: ChatUsage['unattended']): 'critical' | 'warning' | 'neutral' =>
  u.signedOut || u.used >= u.cap ? 'critical' : u.used >= u.cap * 0.8 ? 'warning' : 'neutral';

/** Display names for the labels the server stores. */
const AGENT_NAMES: Record<string, string> = { router: 'Chat router', evolve: 'Auto-evolve', critic: 'Critic', digest: 'Weekly summary', other: 'Other' };
export const agentLabel = (tag: string): string => AGENT_NAMES[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1);

/** "2026-10-07" -> "7 Oct". */
export function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
}
