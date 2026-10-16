import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Inbox } from '../inbox/inbox.js';
import { utcDayKey } from '../live/daily.js';

/** Anything that turns a prompt into text. The default runs the Claude Code CLI. */
export interface CompleteOptions {
  /** Model id for this call (e.g. "sonnet", "opus"). Omit for the backend's default. */
  model?: string;
  /** Free-form label for usage accounting (e.g. an agent id, "critic", "evolve"). Purely informational. */
  tag?: string;
  /** True when nobody asked for this call (auto-evolve, the weekly digest). Counts toward the daily cap. */
  unattended?: boolean;
}

export interface ChatBackend {
  readonly name: string;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
}

/** Token/cost usage for one `complete()` call, when the backend can report it. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  tag?: string;
}

/** Label stored on every outcome record, so results can be compared per model. */
export function modelLabel(backend: ChatBackend, model?: string): string {
  return `${backend.name}/${model || 'default'}`;
}

export class ChatBackendError extends Error {}
/** Claude Code is signed out on the laptop. Fixed only by logging in again there. */
export class ChatAuthError extends ChatBackendError {}
/** An unattended call was refused: the daily cap is used up, or Claude is signed out today. */
export class CallCapError extends ChatBackendError {}

/**
 * Matches CLI error text that means "you need to (re-)log in", however the
 * CLI happens to phrase it -- e.g. "OAuth session expired and could not be
 * refreshed" from an expired login, or "not logged in" from a fresh install.
 * Both come straight out of the `claude` process, not from this app, so the
 * fix is always the same: re-authenticate that CLI on the machine running
 * the server.
 */
const AUTH_ISSUE = /oauth|not (logged|signed) in|please (log ?in)|session expired|authenticat/i;

function authMessage(detail: string): string {
  return `Claude Code's sign-in on the laptop has expired or is missing (${detail.trim()}). Open a terminal there and run \`claude\` once to log in again.`;
}

/**
 * Runs `claude -p` on this computer using the user's existing Claude Code
 * login. The prompt goes in on stdin (no quoting problems, no length limit),
 * and the working directory is an empty temp folder so the model has no project
 * files to read; write/shell tools are additionally disallowed.
 */
export class ClaudeCliBackend implements ChatBackend {
  readonly name = 'claude-cli';

  constructor(
    private readonly command = process.env.CHAT_CLAUDE_COMMAND ?? 'claude',
    private readonly timeoutMs = Number(process.env.CHAT_TIMEOUT_MS ?? 180_000),
    /** Fired (best-effort) after a successful call, if the CLI reported usage. */
    private readonly onUsage?: (u: UsageInfo) => void,
  ) {}

  complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const cwd = join(tmpdir(), 'xautotrade-agent');
    mkdirSync(cwd, { recursive: true });

    return new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'json', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch'];
      // Model names come from server env only (never from chat text); still, allow only a safe charset.
      if (opts.model && /^[\w.:-]+$/.test(opts.model)) args.push('--model', opts.model);
      const child = spawn(
        this.command,
        args,
        { cwd, shell: process.platform === 'win32', windowsHide: true },
      );
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new ChatBackendError(`The agent took longer than ${Math.round(this.timeoutMs / 1000)}s and was stopped.`));
      }, this.timeoutMs);

      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new ChatBackendError(
            e.code === 'ENOENT'
              ? 'Claude Code CLI not found on the laptop. Install it (npm i -g @anthropic-ai/claude-code), run `claude` once to sign in, then retry.'
              : `Could not start Claude Code: ${e.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let text: string | null;
        try {
          text = parseCliOutput(out);
        } catch (e) {
          return reject(e);
        }
        if (text != null) {
          if (this.onUsage) {
            const usage = parseCliUsage(out);
            if (usage) {
              try {
                this.onUsage({ ...usage, model: opts.model, tag: opts.tag });
              } catch {
                /* usage reporting is best-effort and must never break the chat */
              }
            }
          }
          return resolve(text);
        }
        const detail = (err || out).trim().split('\n').slice(-3).join(' ');
        if (AUTH_ISSUE.test(detail)) {
          return reject(new ChatAuthError(authMessage(detail)));
        }
        reject(new ChatBackendError(`Claude Code exited with code ${code}. ${detail}`.trim()));
      });

      child.stdin.on('error', () => {
        /* the process died early; 'close' reports why */
      });
      child.stdin.end(prompt);
    });
  }
}

/** `--output-format json` prints {result, is_error, ...}. Returns null if unusable. */
export function parseCliOutput(stdout: string): string | null {
  const t = stdout.trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      if (j.is_error) {
        const detail = String(j.result ?? 'Claude Code reported an error.');
        throw AUTH_ISSUE.test(detail) ? new ChatAuthError(authMessage(detail)) : new ChatBackendError(detail);
      }
      return typeof j.result === 'string' ? j.result : null;
    }
    if (Array.isArray(j)) {
      const last = [...j].reverse().find((m) => m && m.type === 'result');
      if (last) {
        if (last.is_error) {
          const detail = String(last.result ?? 'Claude Code reported an error.');
          throw AUTH_ISSUE.test(detail) ? new ChatAuthError(authMessage(detail)) : new ChatBackendError(detail);
        }
        return typeof last.result === 'string' ? last.result : null;
      }
    }
  } catch (e) {
    if (e instanceof ChatBackendError) throw e;
    return null;
  }
  return null;
}

/**
 * `--output-format json` also reports token counts and an estimated cost
 * alongside `result` (as `usage: {input_tokens, output_tokens, ...}` and
 * `total_cost_usd`). Pulled out separately from `parseCliOutput` so a CLI
 * version that omits or renames these fields still returns the reply text
 * fine — usage is purely a bonus for the "keep an eye on token usage" panel,
 * never something the chat itself depends on.
 */
export function parseCliUsage(stdout: string): UsageInfo | null {
  const t = stdout.trim();
  if (!t) return null;
  let obj: any;
  try {
    const j = JSON.parse(t);
    obj = Array.isArray(j) ? [...j].reverse().find((m) => m && m.type === 'result') : j;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const u = obj.usage;
  if (!u || typeof u !== 'object') return null;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  if (inputTokens == null && outputTokens == null) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    costUsd: num(obj.total_cost_usd) ?? num(obj.cost_usd),
    durationMs: num(obj.duration_ms),
  };
}

// --- Daily cap on unattended calls, and the sign-in stop ---------------------------------------------

/** How many Claude calls the app may make by itself (nobody asking) in one UTC day. */
export const UNATTENDED_DAILY_CAP = 40;

/** The small key-value store this needs (the app's `settings`; a Map in tests). */
export interface CapStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface CappedBackendDeps {
  store: CapStore;
  inbox: Pick<Inbox, 'raise' | 'resolveKey'>;
  clock?: () => number;
  cap?: number;
}

interface DayCount {
  day: string;
  count: number;
}

/**
 * Wraps the real backend with two protections for calls nobody asked for:
 *  - at most `cap` per UTC day (calls count when they are tried, so a failing loop cannot run on);
 *  - if Claude is signed out, one Inbox card and no more unattended calls until the next UTC day,
 *    or until one of YOUR messages gets an answer (which proves you signed in again).
 * Your own chat messages are never counted and never refused.
 */
export class CappedBackend implements ChatBackend {
  private readonly clock: () => number;
  private readonly cap: number;

  constructor(
    private readonly inner: ChatBackend,
    private readonly deps: CappedBackendDeps,
  ) {
    this.clock = deps.clock ?? Date.now;
    this.cap = deps.cap ?? UNATTENDED_DAILY_CAP;
  }

  get name(): string {
    return this.inner.name;
  }

  /** Today's use, for the Settings panel. */
  status(): { day: string; used: number; cap: number; signedOut: boolean } {
    const day = utcDayKey(this.clock());
    const saved = this.deps.store.get<DayCount | null>('claude:unattended', null);
    return {
      day,
      used: saved && saved.day === day ? saved.count : 0,
      cap: this.cap,
      signedOut: this.deps.store.get<string | null>('claude:signedOutDay', null) === day,
    };
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const now = this.clock();
    const day = utcDayKey(now);
    if (opts.unattended) {
      const st = this.status();
      if (st.signedOut) throw new CallCapError('Automatic Claude calls are paused today because Claude is not signed in on the laptop.');
      if (st.used >= this.cap) {
        this.deps.inbox.raise({
          kind: 'claude_unavailable',
          severity: 'info',
          dedupeKey: `claude-cap:${day}`,
          title: `Automatic Claude calls stopped for today (${this.cap} used)`,
          body: `The app makes at most ${this.cap} Claude calls a day on its own. It starts again at 00:00 UTC. Your own chat messages are not limited.`,
        });
        throw new CallCapError(`The daily limit of ${this.cap} automatic Claude calls is used up. It resets at 00:00 UTC.`);
      }
      this.deps.store.set('claude:unattended', { day, count: st.used + 1 } satisfies DayCount);
    }
    try {
      const out = await this.inner.complete(prompt, opts);
      if (!opts.unattended && this.deps.store.get<string | null>('claude:signedOutDay', null)) {
        // One of your own messages was answered, so Claude is signed in again.
        this.deps.store.set('claude:signedOutDay', null);
        this.deps.inbox.resolveKey('claude_unavailable', 'Claude answered again.');
      }
      return out;
    } catch (err) {
      if (err instanceof ChatAuthError) {
        this.deps.store.set('claude:signedOutDay', day);
        this.deps.inbox.raise({
          kind: 'claude_unavailable',
          severity: 'warn',
          dedupeKey: 'claude_unavailable',
          title: 'The AI agents cannot answer: Claude is not signed in on the laptop',
          body: err.message,
        });
      }
      throw err;
    }
  }
}
