import { randomUUID } from 'node:crypto';

import { ACTIONS_BY_KIND, type InboxAction, type InboxItem, type InboxStatus, type NewInboxItem } from './types.js';

export interface InboxStore {
  put(item: InboxItem): void;
  get(id: string): InboxItem | null;
  /** Newest first. */
  list(status?: InboxStatus, limit?: number): InboxItem[];
  findOpenByKey(key: string): InboxItem | null;
}

export class MemoryInboxStore implements InboxStore {
  private items = new Map<string, InboxItem>();
  put(item: InboxItem): void {
    this.items.set(item.id, structuredClone(item));
  }
  get(id: string): InboxItem | null {
    const i = this.items.get(id);
    return i ? structuredClone(i) : null;
  }
  list(status?: InboxStatus, limit = 200): InboxItem[] {
    return [...this.items.values()]
      .filter((i) => !status || i.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((i) => structuredClone(i));
  }
  findOpenByKey(key: string): InboxItem | null {
    return this.list('open').find((i) => i.dedupeKey === key) ?? null;
  }
}

/** What a card's buttons actually do. Injected so the inbox itself never touches trading code. */
export interface InboxHandlers {
  approveProposal(proposalId: string): Promise<{ status: string; resultMessage?: string }>;
  rejectProposal(proposalId: string): { status: string } | unknown;
  restartBot(strategyId: string): Promise<unknown>;
}

export class InboxError extends Error {}

export class Inbox {
  constructor(
    private readonly store: InboxStore,
    private handlers: Partial<InboxHandlers> = {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Wired after construction because the handlers need the chat service, which needs this inbox. */
  setHandlers(h: Partial<InboxHandlers>): void {
    this.handlers = { ...this.handlers, ...h };
  }

  /** Add a card. If the same problem is already open, count it instead of adding a second one. */
  raise(input: NewInboxItem): { item: InboxItem; created: boolean } {
    const t = this.now();
    if (input.dedupeKey) {
      const existing = this.store.findOpenByKey(input.dedupeKey);
      if (existing) {
        const bumped: InboxItem = { ...existing, count: existing.count + 1, updatedAt: t, body: input.body ?? existing.body, data: input.data ?? existing.data };
        this.store.put(bumped);
        return { item: bumped, created: false };
      }
    }
    const item: InboxItem = {
      id: randomUUID(),
      kind: input.kind,
      status: 'open',
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body ?? '',
      strategyId: input.strategyId ?? null,
      ref: input.ref ?? null,
      dedupeKey: input.dedupeKey ?? null,
      count: 1,
      createdAt: t,
      updatedAt: t,
      resolvedAt: null,
      outcome: null,
      actions: [...ACTIONS_BY_KIND[input.kind]],
      data: input.data,
    };
    this.store.put(item);
    return { item, created: true };
  }

  list(status: InboxStatus | undefined = 'open'): InboxItem[] {
    return this.store.list(status);
  }

  get(id: string): InboxItem | null {
    return this.store.get(id);
  }

  openCount(): number {
    return this.store.list('open').length;
  }

  /** Close a card without anyone pressing a button (e.g. the problem went away). */
  resolveKey(key: string, outcome: string): InboxItem | null {
    const item = this.store.findOpenByKey(key);
    return item ? this.close(item, 'done', outcome) : null;
  }

  /** Close the card that points at this thing (e.g. a proposal decided elsewhere in the app). */
  resolveRef(ref: string, outcome: string): InboxItem | null {
    const item = this.store.list('open').find((i) => i.ref === ref);
    return item ? this.close(item, 'done', outcome) : null;
  }

  private close(item: InboxItem, status: InboxStatus, outcome: string): InboxItem {
    const closed: InboxItem = { ...item, status, outcome, resolvedAt: this.now(), updatedAt: this.now() };
    this.store.put(closed);
    return closed;
  }

  /** Press a button on a card. Each card can be acted on once. */
  async act(id: string, action: InboxAction): Promise<InboxItem> {
    const item = this.store.get(id);
    if (!item) throw new InboxError('That inbox item no longer exists.');
    if (item.status !== 'open') throw new InboxError(`This item was already ${item.status}.`);
    if (!item.actions.includes(action)) throw new InboxError(`"${action}" is not available on this card.`);

    switch (action) {
      case 'approve': {
        const h = this.need(this.handlers.approveProposal, 'approving');
        const p = await h(item.ref ?? '');
        const failed = p.status === 'failed';
        return this.close(item, 'done', failed ? `Could not apply it: ${p.resultMessage ?? 'unknown error'}` : (p.resultMessage ?? 'Approved and applied.'));
      }
      case 'reject': {
        const h = this.need(this.handlers.rejectProposal, 'rejecting');
        await h(item.ref ?? '');
        return this.close(item, 'done', 'Rejected. Nothing was changed.');
      }
      case 'restart': {
        const h = this.need(this.handlers.restartBot, 'restarting');
        if (!item.strategyId) throw new InboxError('This card is not about a bot, so there is nothing to restart.');
        await h(item.strategyId);
        return this.close(item, 'done', 'Bot restarted.');
      }
      case 'dismiss':
        return this.close(item, 'dismissed', 'Dismissed.');
      case 'ok':
        return this.close(item, 'done', 'Acknowledged.');
      default:
        // undo / stage / keep arrive with the tasks that produce those cards.
        throw new InboxError(`"${action}" is not available yet.`);
    }
  }

  private need<T>(fn: T | undefined, what: string): T {
    if (!fn) throw new InboxError(`Inbox cannot do ${what} right now.`);
    return fn;
  }
}
