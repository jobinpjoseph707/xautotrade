import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { Banner, Button, Card, Chip, Field, SectionTitle, Sheet } from '../components/ui';
import { SymbolPicker } from '../components/SymbolPicker';
import { notify } from '../confirm';
import { agentOutcome, canAskStrategist, canPropose, gateLine, resultHeadline, truncatedNote, YOUTUBE_TIMEFRAMES } from '../logic/youtube';
import { useApp } from '../store';
import { colors, font, space } from '../theme';
import type { YoutubeAgentResult, YoutubeResult } from '../types';

/**
 * Strategies > From YouTube. Paste a video link: the server reads its captions, builds a strategy only
 * from rules the speaker states exactly, backtests it on real MT5 history, and shows what it found and
 * what it could not. Nothing is saved or started here; "Send to Inbox" creates a proposal that waits for Approve.
 */
export function YoutubeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { api, refresh } = useApp();
  const [url, setUrl] = useState('');
  const [symbol, setSymbol] = useState('XAUUSD');
  const [timeframe, setTimeframe] = useState<(typeof YOUTUBE_TIMEFRAMES)[number]>('auto');
  const [result, setResult] = useState<YoutubeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentResult, setAgentResult] = useState<YoutubeAgentResult | null>(null);
  const [busy, setBusy] = useState<'analyse' | 'send' | 'agent' | null>(null);

  const close = () => {
    setResult(null);
    setAgentResult(null);
    setError(null);
    onClose();
  };

  const analyse = async () => {
    if (!api) return;
    setBusy('analyse');
    setError(null);
    setResult(null);
    setAgentResult(null);
    try {
      setResult(await api.youtubeExtract({ url: url.trim(), symbol, timeframe: timeframe === 'auto' ? undefined : timeframe }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const askStrategist = async () => {
    if (!api) return;
    setBusy('agent');
    setError(null);
    try {
      const r = await api.youtubeStrategist({ url: url.trim(), symbol, timeframe: timeframe === 'auto' ? undefined : timeframe });
      setAgentResult(r);
      if (r.proposals.length) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!api || !result?.candidateId) return;
    setBusy('send');
    try {
      await api.youtubePropose(result.candidateId);
      await refresh();
      close();
      notify('Sent to your Inbox', 'Open the Inbox tab to read it and press Approve. Nothing is saved or started until you do.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const head = result ? resultHeadline(result) : null;

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="Strategy from YouTube"
      footer={
        <>
          <Button title="Close" variant="ghost" style={{ flex: 1 }} onPress={close} />
          {canPropose(result) ? (
            <Button title="Send to Inbox" style={{ flex: 2 }} loading={busy === 'send'} onPress={send} />
          ) : (
            <Button title="Analyse video" style={{ flex: 2 }} loading={busy === 'analyse'} disabled={!url.trim()} onPress={analyse} />
          )}
        </>
      }
    >
      <Banner tone="accent">
        Reads the video's captions and keeps only rules stated with exact numbers. It is tested on your broker's real MT5 candles. Vague advice such as "when it looks strong" is refused, not guessed.
      </Banner>

      <Field label="YouTube link" value={url} onChangeText={setUrl} placeholder="https://www.youtube.com/watch?v=…" keyboardType="url" />
      <SymbolPicker value={symbol} onChange={setSymbol} />
      <Text style={[font.label, { marginBottom: space.xs }]}>CHART TIMEFRAME</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md }}>
        {YOUTUBE_TIMEFRAMES.map((t) => (
          <Chip key={t} label={t === 'auto' ? 'From the video' : t} active={timeframe === t} onPress={() => setTimeframe(t)} />
        ))}
      </View>

      {busy === 'analyse' ? <Banner tone="accent">Reading captions and testing on MT5 history. This can take up to a minute.</Banner> : null}
      {busy === 'agent' ? <Banner tone="accent">The Strategist is reading the whole transcript. This can take a minute or two.</Banner> : null}
      {error ? <Banner tone="critical">{error}</Banner> : null}

      {result && head ? (
        <>
          <Banner tone={head.tone}>{`${head.title}. ${head.detail}`}</Banner>
          {result.gate ? <Text style={[font.body, { marginBottom: space.md }]}>{gateLine(result.gate)}</Text> : null}

          {canAskStrategist(result) ? (
            <View style={{ marginBottom: space.md }}>
              <Text style={[font.small, { marginBottom: space.sm }]}>
                Videos often state a rule across several sentences, which the quick reader can't join up. The Strategist reads the whole transcript instead, quotes what the speaker said, and lists what it had to assume. Its strategy still goes to the Inbox and waits for your Approve.
              </Text>
              <Button title="Let the Strategist read the video" variant="secondary" loading={busy === 'agent'} onPress={askStrategist} />
            </View>
          ) : null}

          {result.strategy ? (
            <Card style={{ marginBottom: space.md }}>
              <Text style={font.h3}>{result.strategy.name}</Text>
              <Text style={[font.small, { marginTop: 2 }]}>
                {result.strategy.symbol} · {result.strategy.timeframe} · {result.strategy.indicators.length} indicator{result.strategy.indicators.length === 1 ? '' : 's'}
              </Text>
            </Card>
          ) : null}

          {result.gaps.length ? (
            <>
              <SectionTitle>What the video did not say</SectionTitle>
              {result.gaps.map((g, i) => (
                <Text key={`${g.code}-${i}`} style={[font.body, { marginBottom: space.sm, color: g.severity === 'blocking' ? colors.critical : colors.textSecondary }]}>
                  {g.severity === 'blocking' ? 'Missing: ' : 'Assumed: '}
                  {g.message}
                  {g.evidence ? `  ("${g.evidence}")` : ''}
                </Text>
              ))}
            </>
          ) : null}
          {result.notes.length ? (
            <>
              <SectionTitle>What was converted</SectionTitle>
              {result.notes.map((n, i) => (
                <Text key={i} style={[font.small, { marginBottom: space.xs }]}>{n}</Text>
              ))}
            </>
          ) : null}
        </>
      ) : null}

      {agentResult ? (
        <>
          <Banner tone={agentOutcome(agentResult).tone}>{agentOutcome(agentResult).title}</Banner>
          {truncatedNote(agentResult) ? <Text style={[font.small, { marginBottom: space.sm }]}>{truncatedNote(agentResult)}</Text> : null}
          <SectionTitle>What the Strategist says</SectionTitle>
          <Card style={{ marginBottom: space.md }}>
            <Text style={font.body}>{agentResult.reply}</Text>
          </Card>
        </>
      ) : null}
    </Sheet>
  );
}
