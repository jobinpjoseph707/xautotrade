/**
 * Two keys. The owner's key opens everything. The agent service has its own key that opens exactly
 * five routes and nothing else, so a bug or a leak in the service cannot start a bot, approve a
 * proposal or edit a strategy.
 */
import { timingSafeEqual } from 'node:crypto';

/** method + path (under /api), nothing else. */
export const AGENT_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/agent\/dossier\/[^/]+$/ },
  { method: 'POST', pattern: /^\/agent\/backtest$/ },
  { method: 'POST', pattern: /^\/agent\/llm$/ },
  { method: 'POST', pattern: /^\/agent\/notes$/ },
  { method: 'POST', pattern: /^\/agent\/proposals$/ },
];

export const agentRouteAllowed = (method: string, path: string): boolean =>
  AGENT_ROUTES.some((r) => r.method === method.toUpperCase() && r.pattern.test(path));

export function sameKey(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Caller = 'owner' | 'agent' | 'none';

export function caller(headers: { apiKey?: string; agentKey?: string }, keys: { owner: string; agent: string }): Caller {
  if (sameKey(headers.apiKey, keys.owner)) return 'owner';
  if (sameKey(headers.agentKey, keys.agent)) return 'agent';
  return 'none';
}
