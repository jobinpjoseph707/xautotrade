import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';

import { fmtMetrics } from '../components/ProposalChecks';
import { Badge, Banner, Button, Card, Chip } from '../components/ui';
import { confirmAction } from '../confirm';
import { useApp } from '../store';
import { colors, font, radius, space } from '../theme';
import type { ChangeRecord, EvolveCandidate, EvolveSettings, Notebook, Scoreboard, Score } from '../types';

const SCORE_TONE: Record<Score, 'good' | 'critical' | 'neutral' | 'warning' | 'accent'> = {
  helped: 'good', hurt: 'critical', inconclusive: 'neutral', pending: 'accent', 'n/a': 'neutral',
};
const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : '');

/** Scoreboard, notebooks, outcome history and auto-evolve controls. */
export function LearningPanel() {
  const { api, strategies, refreshStrategies } = useApp();
  const [board, setBoard] = useState<Scoreboard | null>(null);
  const [books, setBooks] = useState<Notebook[]>([]);
  const [changes, setChanges] = useState<ChangeRecord[]>([]);
  const [evo, setEvo] = useState<{ settings: EvolveSettings; candidates: EvolveCandidate[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'critical' | 'accent'; text: string } | null>(null);
  const [noteAgent, setNoteAgent] = useState('optimizer');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const [b, n, c, e] = await Promise.all([api.scoreboard(), api.notebooks(), api.changes(40), api.evolve()]);
      setBoard(b); setBooks(n); setChanges(c); setEvo(e);
    } catch (err) {
      setMsg({ tone: 'critical', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ tone: 'good', text });
      await load();
    } catch (err) {
      setMsg({ tone: 'critical', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  if (!api) return null;
  const s = evo?.settings;

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.accent} />}>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      {/* Scoreboard */}
      <Card>
        <Text style={[font.h3, { marginBottom: space.xs }]}>Scoreboard</Text>
        <Text style={[font.small, { marginBottom: space.sm }]}>
          Approved changes are re-tested on bars that formed after you approved them, then scored. Hit rate = helped ÷ (helped + hurt).
        </Text>
        {board && board.byAgent.length ? (
          <>
            {board.byAgent.map((r) => (
              <View key={r.key} style={{ paddingVertical: space.xs, borderBottomWidth: 1, borderColor: colors.border }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={font.h3}>{r.agent}</Text>
                  <Text style={[font.mono, { color: r.hitRate == null ? colors.muted : r.hitRate >= 0.5 ? colors.good : colors.criticalText }]}>{pct(r.hitRate)}</Text>
                </View>
                <Text style={font.small}>
                  {r.proposed} proposed · {r.heldBack} held back · {r.approved} approved · ▲{r.helped} ▼{r.hurt} ~{r.inconclusive} · {r.pending} waiting
                </Text>
              </View>
            ))}
            {board.byModel.some((r) => r.model) && new Set(board.byModel.map((r) => r.model)).size > 1 ? (
              <Text style={[font.small, { marginTop: space.sm }]}>
                By model: {board.byModel.map((r) => `${r.agent} on ${r.model} ${pct(r.hitRate)}`).join(' · ')}
              </Text>
            ) : null}
            <Text style={[font.small, { marginTop: space.sm }]}>
              Critic: opposed → hurt {board.critic.opposedThenHurt}, opposed → helped {board.critic.opposedThenHelped}; supported → helped {board.critic.supportedThenHelped}, supported → hurt {board.critic.supportedThenHurt}.
            </Text>
            <Text style={[font.small, { marginTop: 2 }]}>
              Helped-rate last 30 days {pct(board.trend.recent)} vs previous 30 days {pct(board.trend.previous)}.
            </Text>
          </>
        ) : (
          <Text style={font.body}>Nothing scored yet. Approve a few agent changes; they're scored after about 3 days of new data.</Text>
        )}
        <Button title="Score now" small variant="secondary" loading={busy === 'score'} style={{ marginTop: space.sm }}
          onPress={() => void act('score', async () => {
            const r = await api.runLearning(true);
            return `Scored ${r.scored}, ${r.waiting} still need more trades.${r.errors.length ? ` Errors: ${r.errors.join('; ')}` : ''}`;
          })} />
      </Card>

      {/* Auto-evolve */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={font.h3}>Auto-evolve</Text>
          <Switch value={!!s?.enabled} onValueChange={(v) => void act('toggle', async () => { await api.setEvolve({ enabled: v }); })} />
        </View>
        <Text style={[font.small, { marginVertical: space.sm }]}>
          Off by default. When on, every {s ? Math.round(s.intervalHours / 24) : 7} days the Optimizer proposes one variant of each strategy you tick below. Variants must pass the unseen-data check and can never loosen risk, then are shadow-tested for {s?.testDays ?? 7} days (nothing trades). You promote winners.
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {strategies.map((st) => {
            const on = !!s?.strategyIds.includes(st.id);
            return (
              <Chip key={st.id} label={st.name} active={on} tone="accent"
                onPress={() => void act('pick', async () => {
                  const ids = on ? s!.strategyIds.filter((x) => x !== st.id) : [...(s?.strategyIds ?? []), st.id];
                  await api.setEvolve({ strategyIds: ids });
                })} />
            );
          })}
        </View>
        <Button title="Make variants now" small variant="secondary" loading={busy === 'evolve'} style={{ marginTop: space.sm }}
          disabled={!s?.strategyIds.length}
          onPress={() => void act('evolve', async () => {
            const r = await api.runEvolve();
            return `${r.evolved.created.length} variant(s) now testing.${r.evolved.skipped.length ? ` ${r.evolved.skipped.join(' ')}` : ''}`;
          })} />
        {(evo?.candidates ?? []).filter((c) => c.status !== 'dismissed').slice(0, 10).map((c) => (
          <View key={c.id} style={{ marginTop: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, gap: 2 }}>
            <View style={{ flexDirection: 'row', gap: space.xs, alignItems: 'center' }}>
              <Badge label={c.status.toUpperCase()} tone={c.status === 'winner' ? 'good' : c.status === 'loser' ? 'critical' : c.status === 'testing' ? 'accent' : 'neutral'} />
              <Text style={font.small}>since {day(c.createdAt)}</Text>
            </View>
            <Text style={{ color: colors.text, fontSize: 13 }}>{c.summary}</Text>
            {c.forward ? (
              <>
                <Text style={font.small}>Original: {fmtMetrics(c.forward.before)}</Text>
                <Text style={font.small}>Variant:  {fmtMetrics(c.forward.after)}</Text>
              </>
            ) : null}
            {c.verdictReasons.slice(-1).map((r, i) => <Text key={i} style={font.small}>{r}</Text>)}
            {(c.status === 'winner' || c.status === 'inconclusive') && (
              <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xs }}>
                <Button title="Promote" small variant="success" style={{ flex: 1 }} loading={busy === c.id}
                  onPress={() => confirmAction('Promote variant?', `Apply "${c.summary}" to ${c.parentName}? A running bot picks it up on its next bar.`, 'Promote', () =>
                    void act(c.id, async () => { await api.promoteCandidate(c.id); await refreshStrategies(); return 'Promoted. It will be scored like any other change.'; }))} />
                <Button title="Dismiss" small variant="ghost" style={{ flex: 1 }} onPress={() => void act(c.id, async () => { await api.dismissCandidate(c.id); })} />
              </View>
            )}
          </View>
        ))}
      </Card>

      {/* Notebooks */}
      <Card>
        <Text style={[font.h3, { marginBottom: space.xs }]}>Agent notebooks</Text>
        <Text style={[font.small, { marginBottom: space.sm }]}>
          Read by each agent at the start of every chat. Lessons appear only after the same kind of change turned out the same way at least 3 times.
        </Text>
        {books.map((b) => (
          <View key={b.agent} style={{ marginBottom: space.sm }}>
            <Text style={font.label}>{b.name.toUpperCase()}</Text>
            {b.lessons.length + b.shared.length + b.notes.length === 0 ? <Text style={font.small}>No proven lessons yet.</Text> : null}
            {b.lessons.map((l) => <Text key={l.key} style={{ color: l.direction === 'hurt' ? colors.serious : colors.good, fontSize: 13 }}>• {l.text}</Text>)}
            {b.shared.map((l) => <Text key={l.key} style={font.small}>• (from {l.agent}) {l.text}</Text>)}
            {b.notes.map((n, i) => (
              <Pressable key={i} onLongPress={() => void act('note', async () => { await api.removeNote(b.agent, i); })}>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>• (your note) {n}</Text>
              </Pressable>
            ))}
          </View>
        ))}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.xs }}>
          {books.map((b) => <Chip key={b.agent} label={b.name} active={noteAgent === b.agent} tone="accent" onPress={() => setNoteAgent(b.agent)} />)}
        </View>
        <TextInput value={note} onChangeText={setNote} placeholder="Add a note for this agent (long-press a note to remove)" placeholderTextColor={colors.muted}
          style={{ color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space.sm, fontSize: 13 }} />
        <Button title="Add note" small variant="secondary" style={{ marginTop: space.xs }} disabled={!note.trim()} loading={busy === 'addnote'}
          onPress={() => void act('addnote', async () => { await api.addNote(noteAgent, note); setNote(''); })} />
      </Card>

      {/* Outcome memory */}
      <Card>
        <Text style={[font.h3, { marginBottom: space.sm }]}>Change history</Text>
        {changes.length === 0 ? <Text style={font.body}>No agent proposals recorded yet.</Text> : null}
        {changes.map((c) => (
          <View key={c.id} style={{ paddingVertical: space.xs, borderBottomWidth: 1, borderColor: colors.border, gap: 2 }}>
            <View style={{ flexDirection: 'row', gap: space.xs, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge label={c.status.toUpperCase()} tone={c.status === 'approved' ? 'accent' : c.status === 'blocked' ? 'warning' : 'neutral'} />
              {c.status === 'approved' ? <Badge label={c.score.toUpperCase()} tone={SCORE_TONE[c.score]} /> : null}
              <Text style={font.small}>{day(c.decidedAt ?? c.createdAt)} · {c.agent} · {c.model}</Text>
            </View>
            <Text style={{ color: colors.text, fontSize: 13 }}>{c.summary}</Text>
            {c.scoreReasons.slice(-1).map((r, i) => <Text key={i} style={font.small}>{r}</Text>)}
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}
