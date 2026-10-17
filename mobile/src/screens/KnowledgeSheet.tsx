import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { Badge, Banner, Button, Card, Field, SectionTitle, Sheet } from '../components/ui';
import { notify } from '../confirm';
import { BOOK_NOTE, bookProblem, COMPETITION_NOTE, competitionProblem, SOURCE_LABEL, STATUS_NOTE, statusTone } from '../logic/knowledge';
import { useApp } from '../store';
import { font, space } from '../theme';
import type { KnowledgeList } from '../types';

/** Strategies > Ideas: what the agents may read as context. Ideas show how they actually did; books are notes only. */
export function KnowledgeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { api } = useApp();
  const [list, setList] = useState<KnowledgeList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'book' | 'competition' | null>(null);
  const [book, setBook] = useState({ book: '', page: '', pasted: '' });
  const [comp, setComp] = useState({ competition: '', name: '', symbol: '', entry: '' });
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setList(await api.knowledge());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const sendBook = async () => {
    const problem = bookProblem(book);
    if (problem || !api) return notify('Not yet', problem ?? 'Not connected.');
    setBusy('book');
    setResult(null);
    try {
      const r = await api.addBookNotes({ book: book.book.trim(), page: Number(book.page), pasted: book.pasted });
      setResult(`Kept ${r.kept.length} note${r.kept.length === 1 ? '' : 's'}.${r.dropped.length ? ` Left out ${r.dropped.length} (copied text or too many).` : ''}`);
      setBook({ ...book, pasted: '' });
      await load();
    } catch (err) {
      notify('Could not add notes', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const sendCompetition = async () => {
    const problem = competitionProblem(comp);
    if (problem || !api) return notify('Not yet', problem ?? 'Not connected.');
    setBusy('competition');
    setResult(null);
    try {
      await api.addCompetitionMethod({ competition: comp.competition.trim(), name: comp.name.trim(), symbol: comp.symbol.trim() || undefined, entry: comp.entry.trim() });
      setResult('Saved the entry idea.');
      setComp({ competition: comp.competition, name: '', symbol: '', entry: '' });
      await load();
    } catch (err) {
      notify('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Ideas and books">
      <Text style={font.body}>{STATUS_NOTE}</Text>
      {error ? <Banner tone="critical">{error}</Banner> : null}
      {result ? <Banner tone="good">{result}</Banner> : null}

      <SectionTitle>Ideas</SectionTitle>
      {list && list.ideas.length === 0 ? <Text style={font.small}>None yet. Ideas appear when you send a video strategy to the Inbox or add a competition method below.</Text> : null}
      <View style={{ gap: space.sm }}>
        {(list?.ideas ?? []).map((i) => (
          <Card key={i.id}>
            <View style={{ gap: space.xs }}>
              <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', alignItems: 'center' }}>
                <Badge label={SOURCE_LABEL[i.source]} />
                <Badge label={i.status} tone={statusTone(i.status)} />
                {i.symbol ? <Text style={font.small}>{i.symbol}</Text> : null}
              </View>
              <Text style={font.h3}>{i.title}</Text>
              <Text style={font.small}>{i.entry}</Text>
            </View>
          </Card>
        ))}
      </View>

      <SectionTitle>Book notes</SectionTitle>
      {(list?.concepts ?? []).map((c) => (
        <Text key={c.id} style={font.small}>
          {c.concept} ({c.book}, p. {c.page})
        </Text>
      ))}
      <Text style={[font.small, { marginTop: space.sm }]}>{BOOK_NOTE}</Text>
      <Field label="Book" value={book.book} onChangeText={(v) => setBook({ ...book, book: v })} autoCapitalize="words" />
      <Field label="Page the chapter starts on" value={book.page} onChangeText={(v) => setBook({ ...book, page: v })} keyboardType="numeric" />
      <Field label="Chapter text (a chapter you own)" value={book.pasted} onChangeText={(v) => setBook({ ...book, pasted: v })} multiline autoCapitalize="sentences" />
      <Button title="Make notes" loading={busy === 'book'} disabled={busy !== null} onPress={() => void sendBook()} />

      <SectionTitle>Competition method</SectionTitle>
      <Text style={font.small}>{COMPETITION_NOTE}</Text>
      <Field label="Competition" value={comp.competition} onChangeText={(v) => setComp({ ...comp, competition: v })} autoCapitalize="words" />
      <Field label="Method name" value={comp.name} onChangeText={(v) => setComp({ ...comp, name: v })} autoCapitalize="words" />
      <Field label="Symbol (optional)" value={comp.symbol} onChangeText={(v) => setComp({ ...comp, symbol: v })} />
      <Field label="Entry idea" value={comp.entry} onChangeText={(v) => setComp({ ...comp, entry: v })} multiline autoCapitalize="sentences" />
      <Button title="Save entry idea" variant="secondary" loading={busy === 'competition'} disabled={busy !== null} onPress={() => void sendCompetition()} />
    </Sheet>
  );
}
