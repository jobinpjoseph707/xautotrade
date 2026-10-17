/** "Previous chats": saved conversations grouped by day, open one, delete one, or start a new chat. */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Banner, Button, Sheet } from '../components/ui';
import { confirmAction } from '../confirm';
import { groupSessions, isEmptySession, messageCountLabel, sessionWhen } from '../logic/chatSessions';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { ChatSessionSummary } from '../types';

/** "Previous chats": every saved conversation for this screen, newest first, grouped by day. */
export function ChatHistorySheet({
  visible,
  strategyId,
  activeId,
  onClose,
  onOpen,
  onNew,
  onDeleted,
}: {
  visible: boolean;
  strategyId: string | null;
  activeId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
}) {
  const { api } = useApp();
  const [list, setList] = useState<ChatSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !api) return;
    setList(null);
    setError(null);
    api
      .chatSessions(strategyId)
      .then((l) => setList(l.filter((s) => !isEmptySession(s))))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [visible, api, strategyId]);

  const remove = (s: ChatSessionSummary) =>
    confirmAction('Delete this chat?', `"${s.title}" and its ${messageCountLabel(s.messageCount)} will be removed. Changes you already approved stay.`, 'Delete', async () => {
      try {
        await api!.deleteChatSession(s.id);
        setList((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
        onDeleted(s.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, { destructive: true });

  const now = Date.now();
  const groups = list ? groupSessions(list, now) : [];

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Previous chats"
      footer={<Button title="＋ New chat" onPress={() => { onNew(); onClose(); }} style={{ flex: 1 }} />}
    >
      {error ? <Banner tone="critical">{error}</Banner> : null}
      {list === null && !error ? <Text style={font.small}>Loading your chats…</Text> : null}
      {list && list.length === 0 ? <Text style={font.body}>No saved chats yet. Whatever you ask is saved here so you can come back to it.</Text> : null}
      {groups.map((g) => (
        <View key={g.label} style={{ marginBottom: space.md }}>
          <Text style={[font.label, { marginBottom: space.xs }]}>{g.label.toUpperCase()}</Text>
          {g.sessions.map((s) => {
            const isActive = s.id === activeId;
            return (
              <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderColor: colors.border }}>
                <Pressable
                  onPress={() => { onOpen(s.id); onClose(); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Open chat ${s.title}`}
                  style={{ flex: 1 }}
                >
                  <Text style={{ color: isActive ? colors.accent : colors.text, fontSize: 14, fontWeight: isActive ? '600' : '500' }} numberOfLines={1}>
                    {s.title}
                  </Text>
                  {s.preview ? (
                    <Text style={font.small} numberOfLines={2}>{s.preview}</Text>
                  ) : null}
                  <Text style={font.small}>{sessionWhen(s.updatedAt, now)} · {messageCountLabel(s.messageCount)}{isActive ? ' · open now' : ''}</Text>
                </Pressable>
                <Button title="Delete" small variant="ghost" accessibilityLabel={`Delete chat ${s.title}`} onPress={() => remove(s)} />
              </View>
            );
          })}
        </View>
      ))}
    </Sheet>
  );
}
