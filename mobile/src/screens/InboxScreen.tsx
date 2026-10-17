import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Badge, Button, Card, Empty, Loading, Page, PageHeader } from '../components/ui';
import { notify } from '../confirm';
import { checklistRows, hasWhy, lessonsLine } from '../logic/agentRuns';
import { ACTION_LABEL, actionVariant, EMPTY_BODY, EMPTY_TITLE, INBOX_SUBTITLE, KIND_LABEL, repeatNote, sortItems, usableActions } from '../logic/inbox';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { InboxAction, InboxItem, WhyProposal } from '../types';

const TONE = { critical: 'critical', warn: 'warning', info: 'accent' } as const;

export function InboxScreen({ onOpenHelp, onChanged }: { onOpenHelp?: (item: InboxItem) => void; onChanged?: () => void }) {
  const { api, strategies } = useApp();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState<Record<string, WhyProposal | 'none' | 'loading'>>({});
  const names = new Map(strategies.map((s) => [s.id, s.name]));

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setItems(sortItems(await api.inbox('open')));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const toggleWhy = async (item: InboxItem) => {
    if (!api || !item.ref) return;
    if (why[item.id]) {
      setWhy(({ [item.id]: _gone, ...rest }) => rest);
      return;
    }
    setWhy((w) => ({ ...w, [item.id]: 'loading' }));
    try {
      const w = await api.proposalWhy(item.ref);
      setWhy((x) => ({ ...x, [item.id]: w }));
    } catch {
      setWhy((x) => ({ ...x, [item.id]: 'none' }));
    }
  };

  const act = async (item: InboxItem, action: InboxAction) => {
    if (!api) return;
    setBusy(`${item.id}:${action}`);
    try {
      await api.inboxAct(item.id, action);
    } catch (err) {
      notify('Could not do that', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await load();
      onChanged?.();
    }
  };

  return (
    <Page>
      <PageHeader title="Inbox" subtitle={INBOX_SUBTITLE} />
      {error ? <Text style={[font.body, { color: colors.criticalText }]}>Could not load the inbox: {error}</Text> : null}
      {items === null && !error ? <Loading label="Loading inbox" /> : null}
      {items && items.length === 0 ? <Empty title={EMPTY_TITLE} body={EMPTY_BODY} /> : null}
      <View style={{ gap: space.md }}>
        {(items ?? []).map((item) => (
          <Card key={item.id}>
            <View style={{ gap: space.sm }}>
              <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge label={KIND_LABEL[item.kind]} tone={TONE[item.severity]} />
                {item.strategyId && names.get(item.strategyId) ? <Text style={font.small}>{names.get(item.strategyId)}</Text> : null}
                {repeatNote(item) ? <Text style={font.small}>{repeatNote(item)}</Text> : null}
              </View>
              <Text style={font.h3}>{item.title}</Text>
              {item.body ? <Text style={font.body}>{item.body}</Text> : null}
              <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', alignItems: 'center' }}>
                {usableActions(item).map((a) => (
                  <Button
                    key={a}
                    small
                    title={ACTION_LABEL[a]}
                    variant={actionVariant(a)}
                    loading={busy === `${item.id}:${a}`}
                    disabled={busy !== null}
                    onPress={() => void act(item, a)}
                  />
                ))}
                {onOpenHelp ? (
                  <Pressable onPress={() => onOpenHelp(item)} accessibilityRole="link" accessibilityLabel="What do I do?">
                    <Text style={{ color: colors.accent, fontSize: 13 }}>What do I do?</Text>
                  </Pressable>
                ) : null}
              </View>
              {hasWhy(item) ? (
                <View style={{ gap: space.xs }}>
                  <Pressable onPress={() => void toggleWhy(item)} accessibilityRole="link" accessibilityLabel="Why was this proposed?">
                    <Text style={{ color: colors.accent, fontSize: 13 }}>{why[item.id] ? 'Hide the reasoning' : 'Why was this proposed?'}</Text>
                  </Pressable>
                  <WhyBlock value={why[item.id]} />
                </View>
              ) : null}
            </View>
          </Card>
        ))}
      </View>
    </Page>
  );
}

function WhyBlock({ value }: { value: WhyProposal | 'none' | 'loading' | undefined }) {
  if (!value) return null;
  if (value === 'loading') return <Text style={font.small}>Loading…</Text>;
  if (value === 'none') return <Text style={font.small}>No reasoning was saved. This one came from a chat, not from the agent team.</Text>;
  return (
    <View style={{ gap: space.xs }}>
      <Text style={font.body}>{value.rationale.claim}</Text>
      {checklistRows(value).map((r) => (
        <Text key={r.label} style={font.small}>
          <Text style={{ fontWeight: '600' }}>{r.label}: </Text>
          {r.value}
        </Text>
      ))}
      <Text style={font.small}>
        <Text style={{ fontWeight: '600' }}>Test: </Text>
        {value.rationale.disproof}
      </Text>
      <Text style={font.small}>{lessonsLine(value)}</Text>
    </View>
  );
}
