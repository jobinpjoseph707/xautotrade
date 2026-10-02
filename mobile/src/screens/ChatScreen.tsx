import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { ProposalChecks } from '../components/ProposalChecks';
import { Badge, Banner, Button, Card, Chip, PageHeader, Segmented, Sheet } from '../components/ui';
import { LearningPanel } from './LearningPanel';
import { useApp } from '../store';
import { colors, font, radius, space } from '../theme';
import type { ChatAgent, ChatProposal } from '../types';
import { isIrish, useVoiceInput, useVoiceOutput } from '../voice';

/** "Microsoft Orla Online (Natural) - Irish (Ireland)" → "Microsoft Orla Online", for the chip. */
function shortVoiceName(name?: string): string {
  if (!name) return 'default';
  const cleaned = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+-\s+.*$/, '').trim();
  return cleaned.length > 22 ? `${cleaned.slice(0, 21)}…` : cleaned;
}

interface Msg {
  id: number;
  role: 'user' | 'agent';
  text: string;
  agentName?: string;
  proposals?: ChatProposal[];
  rejected?: string[];
}

// Kept at module level so the conversation survives switching tabs.
let saved: Msg[] = [];
let nextId = 1;

const FALLBACK_AGENTS: ChatAgent[] = [
  { id: 'strategist', name: 'Strategist', tagline: 'Creates new strategies' },
  { id: 'optimizer', name: 'Optimizer', tagline: 'Tunes existing strategies' },
  { id: 'doctor', name: 'Strategy Doctor', tagline: 'Diagnoses; can stop or remove' },
  { id: 'guard', name: 'Risk Guard', tagline: 'Only makes risk safer' },
  { id: 'critic', name: 'Critic', tagline: 'Argues against proposals' },
];

const SUGGESTIONS = [
  'Create a fast scalping strategy for BTCUSD on the 1 minute chart',
  "Why isn't my bot trading?",
  'Make all my strategies safer',
  'Remove any strategy that looks broken',
];

export function ChatScreen() {
  const { api, refreshStrategies, refresh } = useApp();
  const [messages, setMessages] = useState<Msg[]>(saved);
  const [agents, setAgents] = useState<ChatAgent[]>(FALLBACK_AGENTS);
  const [agent, setAgent] = useState<string>('auto');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'learning'>('chat');
  const [voiceReply, setVoiceReply] = useState(false);
  const [pickingVoice, setPickingVoice] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const voiceOut = useVoiceOutput();
  const currentVoiceName = voiceOut.voices.find((v) => v.voiceURI === voiceOut.voiceURI)?.name;

  useEffect(() => {
    saved = messages;
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [messages]);

  useEffect(() => {
    if (!api) return;
    api.chatAgents().then(setAgents).catch(() => undefined);
  }, [api]);

  const send = async (override?: string) => {
    const content = (override ?? text).trim();
    if (!content || !api || busy) return;
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', text: content }]);
    setText('');
    setError(null);
    setBusy(true);
    try {
      const r = await api.chat({ agent, message: content, history });
      setMessages((prev) => [
        ...prev,
        { id: nextId++, role: 'agent', text: r.reply, agentName: r.agentName, proposals: r.proposals, rejected: r.rejected },
      ]);
      if (voiceReply) voiceOut.speak(r.reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Mic → transcript → send, so a voice question is a single tap-and-talk.
  const voiceIn = useVoiceInput((heard) => void send(heard));
  useEffect(() => {
    if (voiceIn.listening) setText(voiceIn.interim);
  }, [voiceIn.interim, voiceIn.listening]);

  const decide = async (msgId: number, p: ChatProposal, approve: boolean) => {
    if (!api) return;
    setActing(p.id);
    try {
      const updated = approve ? await api.approveProposal(p.id) : await api.rejectProposal(p.id);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, proposals: m.proposals?.map((x) => (x.id === p.id ? { ...x, ...updated } : x)) } : m,
        ),
      );
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
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, width: '100%', maxWidth: 1100, alignSelf: 'center' }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.xl }}>
        <PageHeader title="Agents" subtitle="AI agents propose changes — nothing happens until you approve" />
        <Segmented
          options={[{ value: 'chat', label: 'Chat' }, { value: 'learning', label: 'Learning' }]}
          value={view}
          onChange={setView}
        />
      </View>
      {view === 'learning' ? (
        <LearningPanel />
      ) : (
      <>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs, paddingBottom: space.sm }}>
          <Chip label="Auto" active={agent === 'auto'} tone="accent" onPress={() => setAgent('auto')} />
          {agents.map((a) => (
            <Chip key={a.id} label={a.name} active={agent === a.id} tone="accent" onPress={() => setAgent(a.id)} />
          ))}
          {voiceOut.supported ? (
            <Chip
              label={voiceOut.speaking ? '⏹ Stop reading' : '🔊 Read replies aloud'}
              active={voiceReply}
              tone={voiceOut.speaking ? 'accent' : 'neutral'}
              onPress={() => {
                if (voiceOut.speaking) voiceOut.stop();
                else setVoiceReply((v) => !v);
              }}
            />
          ) : null}
          {voiceOut.supported ? (
            <Chip label={`🗣 ${shortVoiceName(currentVoiceName)}`} onPress={() => setPickingVoice(true)} />
          ) : null}
        </ScrollView>
        <Text style={[font.small, { marginBottom: space.sm }]}>
          {agent === 'auto'
            ? 'Auto picks the right agent from your message.'
            : `${agents.find((a) => a.id === agent)?.tagline ?? ''}.`}{' '}
          Nothing changes until you tap Approve.
        </Text>
      </View>

      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: space.md }}>
        {messages.length === 0 && (
          <Card>
            <Text style={[font.h3, { marginBottom: space.sm }]}>Talk to your strategy agents</Text>
            <Text style={[font.body, { marginBottom: space.md }]}>
              Ask for a new strategy, a change to an existing one, or a check on what is going wrong. Try:
            </Text>
            <View style={{ gap: space.xs }}>
              {SUGGESTIONS.map((sug) => (
                <Pressable key={sug} onPress={() => void send(sug)} style={{ paddingVertical: space.sm }}>
                  <Text style={{ color: colors.accent, fontSize: 14 }}>› {sug}</Text>
                </Pressable>
              ))}
            </View>
          </Card>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <View key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: colors.accentDim, borderRadius: radius.lg, padding: space.md }}>
              <Text style={{ color: colors.text, fontSize: 14 }}>{m.text}</Text>
            </View>
          ) : (
            <View key={m.id} style={{ alignSelf: 'flex-start', maxWidth: '95%', gap: space.sm }}>
              <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: space.md }}>
                <Text style={[font.label, { marginBottom: space.xs }]}>{(m.agentName ?? 'AGENT').toUpperCase()}</Text>
                <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{m.text}</Text>
              </View>
              {m.rejected?.map((r, i) => (
                <Banner key={i} tone="warning">
                  Could not propose: {r}
                </Banner>
              ))}
              {m.proposals?.map((p) => (
                <Card key={p.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.xs }}>
                    <Badge
                      label={p.status.toUpperCase()}
                      tone={p.status === 'approved' ? 'good' : p.status === 'failed' ? 'critical' : p.status === 'rejected' ? 'neutral' : 'accent'}
                    />
                  </View>
                  <Text style={[font.h3, { marginBottom: space.xs }]}>{p.summary}</Text>
                  {p.reason ? <Text style={[font.body, { marginBottom: space.xs }]}>{p.reason}</Text> : null}
                  {p.warnings.map((w, i) => (
                    <Text key={i} style={{ color: colors.warning, fontSize: 12, marginBottom: 2 }}>
                      ⚠ {w}
                    </Text>
                  ))}
                  <ProposalChecks validation={p.validation} critic={p.critic} />
                  {p.resultMessage ? <Text style={[font.small, { marginTop: space.xs }]}>{p.resultMessage}</Text> : null}
                  {p.status === 'pending' && (
                    <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
                      <Button title="Approve" variant="success" small loading={acting === p.id} onPress={() => void decide(m.id, p, true)} style={{ flex: 1 }} />
                      <Button title="Reject" variant="ghost" small disabled={acting === p.id} onPress={() => void decide(m.id, p, false)} style={{ flex: 1 }} />
                    </View>
                  )}
                </Card>
              ))}
            </View>
          ),
        )}

        {busy && (
          <Text style={[font.small, { alignSelf: 'flex-start' }]}>Thinking… the agent, the unseen-data check and the critic can take a minute or two.</Text>
        )}
        {error ? <Banner tone="critical">{error}</Banner> : null}
        {voiceIn.error ? <Banner tone="critical">{voiceIn.error}</Banner> : null}
      </ScrollView>

      {voiceIn.listening ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.md, paddingTop: space.xs }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.criticalStrong }} />
          <Text style={font.small}>Listening… pauses are fine, it sends a few seconds after you stop talking — or tap the mic again to send right away.</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, padding: space.md, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
        {voiceIn.supported ? (
          <Pressable
            onPress={() => (voiceIn.listening ? voiceIn.stop() : voiceIn.start())}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={voiceIn.listening ? 'Stop listening' : 'Ask by voice'}
            style={({ pressed }) => [
              {
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: voiceIn.listening ? colors.criticalStrong : colors.surfaceAlt,
                borderWidth: 1,
                borderColor: voiceIn.listening ? colors.criticalStrong : colors.borderStrong,
                opacity: busy ? 0.4 : pressed ? 0.75 : 1,
              },
            ]}
          >
            <Text style={{ fontSize: 18 }}>{voiceIn.listening ? '⏺' : '🎙'}</Text>
          </Pressable>
        ) : null}
        <TextInput
          style={{ flex: 1, maxHeight: 120, minHeight: 44, color: colors.text, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 14 }}
          value={text}
          onChangeText={setText}
          placeholder={voiceIn.listening ? 'Listening…' : 'Ask an agent, or tap the mic…'}
          placeholderTextColor={colors.muted}
          multiline
          editable={!busy && !voiceIn.listening}
        />
        <Button title="Send" onPress={() => void send()} loading={busy} disabled={!text.trim() || voiceIn.listening} />
      </View>
      </>
      )}
      </View>

      <Sheet
        visible={pickingVoice}
        onClose={() => setPickingVoice(false)}
        title="Reading voice"
        footer={<Button title="Done" onPress={() => setPickingVoice(false)} style={{ flex: 1 }} />}
      >
        {!voiceOut.hasIrish ? (
          <Banner tone="accent">
            No Irish voice is installed on this device yet, so replies default to the closest match.
            On Windows: Settings → Time &amp; language → Language &amp; region → Add a language →
            English (Ireland), then install its speech pack (the natural voice is named "Orla") and
            reload this page. On a Mac or iPhone, "Moira" (Irish English) is usually already available
            below.
          </Banner>
        ) : null}
        {voiceOut.voices.length === 0 ? (
          <Text style={[font.small, { marginTop: space.sm }]}>Loading the voices installed on this device…</Text>
        ) : (
          voiceOut.voices.map((v) => {
            const active = v.voiceURI === voiceOut.voiceURI;
            return (
              <View key={v.voiceURI} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderColor: colors.border }}>
                <Pressable
                  onPress={() => voiceOut.setVoice(v.voiceURI)}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={{ color: active ? colors.accent : colors.muted, fontSize: 16 }}>{active ? '●' : '○'}</Text>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ color: colors.text, fontSize: 14, fontWeight: active ? '600' : '500', flexShrink: 1 }} numberOfLines={1}>
                        {v.name}
                      </Text>
                      {isIrish(v) ? <Badge label="IRISH" tone="good" /> : null}
                    </View>
                    <Text style={font.small}>{v.lang}</Text>
                  </View>
                </Pressable>
                <Button title="▶" small variant="ghost" accessibilityLabel={`Preview ${v.name}`} onPress={() => voiceOut.preview(v.voiceURI)} />
              </View>
            );
          })
        )}
      </Sheet>
    </KeyboardAvoidingView>
  );
}
