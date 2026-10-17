/** One saved chat per screen: loads the latest, creates on first send, new chat, open, delete. */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Api } from '../api';
import type { ChatProposal, StoredChatMessage } from '../types';

export type ChatMsg = StoredChatMessage;

/** Which chat list a conversation belongs to: one strategy's, or '' for the Agents tab. */
const scopeKey = (strategyId: string | null) => strategyId ?? '';

// The chat each screen was last in, so switching tabs and coming back lands on the same chat.
const active = new Map<string, string>();
let localId = 1;
export const newLocalId = () => `local-${localId++}`;

/** Swap a proposal's fields after it was approved or rejected. Pure, so it can be tested. */
export function patchProposal(messages: ChatMsg[], proposalId: string, patch: Partial<ChatProposal>): ChatMsg[] {
  return messages.map((m) => (m.proposals?.some((p) => p.id === proposalId) ? { ...m, proposals: m.proposals.map((p) => (p.id === proposalId ? { ...p, ...patch } : p)) } : m));
}

/**
 * One saved conversation at a time. Chats are kept by the server, so they survive a reload
 * and show up in "Previous chats". A new chat is only created once the first message is sent,
 * so opening the screen never leaves empty chats behind.
 */
export function useChatSession(api: Api | null, strategyId: string | null) {
  const key = scopeKey(strategyId);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A response that arrives after the user switched chats must not land in the wrong one.
  const current = useRef<string | null>(null);
  current.current = sessionId;

  const open = useCallback(
    async (id: string) => {
      if (!api) return;
      setLoading(true);
      setLoadError(null);
      try {
        const s = await api.chatSession(id);
        active.set(key, s.id);
        setSessionId(s.id);
        setMessages(s.messages);
      } catch (err) {
        active.delete(key);
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [api, key],
  );

  // On first show: go back to the chat this screen was in, else the most recent one.
  useEffect(() => {
    setSessionId(null);
    setMessages([]);
    if (!api) return;
    let gone = false;
    (async () => {
      const remembered = active.get(key);
      if (remembered) return void (await open(remembered));
      try {
        const list = await api.chatSessions(strategyId);
        const latest = list.find((s) => s.messageCount > 0);
        if (latest && !gone) await open(latest.id);
      } catch {
        // an empty chat is fine if the list can't be read
      }
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  /** The chat to send into — made on the first message. */
  const ensure = useCallback(async (): Promise<string> => {
    if (current.current) return current.current;
    const s = await api!.createChatSession(strategyId);
    active.set(key, s.id);
    current.current = s.id;
    setSessionId(s.id);
    return s.id;
  }, [api, key, strategyId]);

  const add = useCallback((m: Omit<ChatMsg, 'id' | 'at'>) => setMessages((prev) => [...prev, { ...m, id: newLocalId(), at: Date.now() }]), []);

  const newChat = useCallback(() => {
    active.delete(key);
    current.current = null;
    setSessionId(null);
    setMessages([]);
    setLoadError(null);
  }, [key]);

  /** Called after a chat was deleted from the list. */
  const removed = useCallback(
    (id: string) => {
      if (current.current === id) newChat();
    },
    [newChat],
  );

  const patch = useCallback((proposalId: string, p: Partial<ChatProposal>) => setMessages((prev) => patchProposal(prev, proposalId, p)), []);

  /** False once the user has moved to another chat — a late answer must then be dropped from the screen (it is still saved). */
  const isCurrent = useCallback((id: string) => current.current === id, []);

  return { sessionId, messages, isCurrent, loading, loadError, ensure, add, open, newChat, removed, patch };
}
