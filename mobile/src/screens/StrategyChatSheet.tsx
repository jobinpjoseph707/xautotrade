import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { Badge, Button, Card, Field, Sheet } from '../components/ui';
import { CHAT_BUTTONS, isWeakEvidence, whatIfError, whatIfRows } from '../logic/strategyChat';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { ChatButton, ChatProposal, Strategy } from '../types';

interface Turn {
  id: number;
  role: 'user' | 'agent';
  text: string;
  agentName?: string;
  proposals?: ChatProposal[];
  rejected?: string[];
}

// Conversations live on the server per strategy; this keeps what was shown so reopening the sheet is not blank.
const shown = new Map<string, Turn[]>();
let nextId = 1;

/** A chat tied to one strategy: four buttons for the common questions, free text for the rest. */
export function StrategyChatSheet({ strategy, onClose }: { strategy: Strategy | null; onClose: () => void }) {
  const { api, refreshStrategies, refresh } = useApp();
  const [, bump] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!strategy) return null;
  const turns = shown.get(strategy.id) ?? [];
  const push = (t: Omit<Turn, 'id'>) => {
    shown.set(strategy.id, [...(shown.get(strategy.id) ?? []), { ...t, id: nextId++ }]);
    bump((n) => n + 1);
  };

  const send = async (button?: ChatButton) => {
    if (!api || busy) return;
    const message = text.trim();
    if (!button && !message) return;
    setBusy(true);
    setError(null);
    push({ role: 'user', text: button ? CHAT_BUTTONS.find((b) => b.button === button)!.label : message });
    setText('');
    try {
      const r = await api.chat({ strategyId: strategy.id, button, message: button ? undefined : message });
      push({ role: 'agent', text: r.reply, agentName: r.agentName, proposals: r.proposals, rejected: r.rejected });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (p: ChatProposal, approve: boolean) => {
    if (!api) return;
    setActing(p.id);
    try {
      const updated = approve ? await api.approveProposal(p.id) : await api.rejectProposal(p.id);
      for (const [key, list] of shown) {
        shown.set(key, list.map((t) => ({ ...t, proposals: t.proposals?.map((x) => (x.id === p.id ? { ...x, ...updated } : x)) })));
      }
      bump((n) => n + 1);
      if (approve) {
        await refreshStrategies();
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  return (
    <Sheet
      visible
      onClose={onClose}
      title={`Chat: ${strategy.name}`}
      footer={
        <View style={{ gap: space.sm }}>
          <Field label="Ask about this strategy" value={text} onChangeText={setText} placeholder="Or type your own question" autoCapitalize="sentences" />
          <Button title="Send" loading={busy} disabled={!text.trim()} onPress={() => void send()} />
        </View>
      }
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md }}>
        {CHAT_BUTTONS.map((b) => (
          <Button key={b.button} title={b.label} accessibilityLabel={`${b.label}: ${b.hint}`} small variant="secondary" disabled={busy} onPress={() => void send(b.button)} />
        ))}
      </View>
      {turns.length === 0 ? <Text style={font.body}>Tap a button, or type a question. Nothing changes until you tap Approve.</Text> : null}
      <View style={{ gap: space.md }}>
        {turns.map((t) => (
          <View key={t.id} style={{ alignItems: t.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <Text style={font.small}>{t.role === 'user' ? 'You' : (t.agentName ?? 'Agent')}</Text>
            <Text style={[font.body, { color: colors.text }]}>{t.text}</Text>
            {t.rejected?.map((r, i) => (
              <Text key={i} style={[font.small, { color: colors.warning }]}>Not done: {r}</Text>
            ))}
            {t.proposals?.map((p) => (
              <ProposalBlock key={p.id} p={p} acting={acting === p.id} onDecide={(a) => void decide(p, a)} />
            ))}
          </View>
        ))}
      </View>
      {busy ? <Text style={[font.small, { marginTop: space.md }]}>Thinking… a test backtest can take a minute.</Text> : null}
      {error ? <Text style={[font.body, { color: colors.criticalText, marginTop: space.md }]}>{error}</Text> : null}
    </Sheet>
  );
}

function ProposalBlock({ p, acting, onDecide }: { p: ChatProposal; acting: boolean; onDecide: (approve: boolean) => void }) {
  const rows = whatIfRows(p);
  const err = whatIfError(p);
  return (
    <Card style={{ marginTop: space.sm, alignSelf: 'stretch' }}>
      <View style={{ gap: space.xs }}>
        <Text style={font.h3}>{p.summary}</Text>
        {p.reason ? <Text style={font.body}>{p.reason}</Text> : null}
        {rows.length ? (
          <View style={{ marginTop: space.xs }}>
            <View style={{ flexDirection: 'row' }}>
              <Text style={[font.label, { flex: 1.4 }]}> </Text>
              <Text style={[font.label, { flex: 1 }]}>NOW</Text>
              <Text style={[font.label, { flex: 1 }]}>WITH CHANGE</Text>
            </View>
            {rows.map((r) => (
              <View key={r.label} style={{ flexDirection: 'row' }}>
                <Text style={[font.small, { flex: 1.4 }]}>{r.label}</Text>
                <Text style={[font.mono, { flex: 1 }]}>{r.before}</Text>
                <Text style={[font.mono, { flex: 1 }]}>{r.after}</Text>
              </View>
            ))}
            {isWeakEvidence(p) ? <Text style={[font.small, { color: colors.warning }]}>Fewer than 30 trades: weak evidence. Past results do not predict future ones.</Text> : null}
          </View>
        ) : null}
        {err ? <Text style={[font.small, { color: colors.warning }]}>{err}</Text> : null}
        {p.warnings.map((w, i) => (
          <Text key={i} style={[font.small, { color: colors.warning }]}>{w}</Text>
        ))}
        {p.status === 'pending' ? (
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xs }}>
            <Button title="Approve" small variant="success" loading={acting} onPress={() => onDecide(true)} />
            <Button title="Reject" small variant="ghost" disabled={acting} onPress={() => onDecide(false)} />
          </View>
        ) : (
          <Badge label={p.status === 'approved' ? 'Approved' : p.status === 'rejected' ? 'Rejected' : 'Failed'} tone={p.status === 'approved' ? 'good' : p.status === 'failed' ? 'critical' : 'neutral'} />
        )}
        {p.resultMessage ? <Text style={font.small}>{p.resultMessage}</Text> : null}
      </View>
    </Card>
  );
}
