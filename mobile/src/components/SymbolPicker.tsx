import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Badge, Banner, Button, Row, Sheet } from './ui';
import { useApp } from '../store';
import { colors, font, radius, space } from '../theme';
import type { SymbolSpec } from '../types';

/**
 * Symbol chooser bound to the broker's own instrument list.
 *
 * Typing a symbol by hand is the single easiest way to break a strategy:
 * brokers name the same instrument differently (EURUSD, EURUSD.m, EURUSD_i,
 * GOLD vs XAUUSD), and a name that doesn't exist fails later with a confusing
 * "0 candles" error rather than at the point of the mistake. Picking from the
 * live list makes an invalid symbol unrepresentable.
 *
 * On selection it also shows the contract detail — digits, point, spread, value
 * per point — because those differ per instrument and silently change what a
 * "100 point stop" actually costs you.
 */
export function SymbolPicker({
  value,
  onChange,
  label = 'Symbol',
}: {
  value: string;
  onChange: (symbol: string) => void;
  label?: string;
}) {
  const { api } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [spec, setSpec] = useState<SymbolSpec | null>(null);
  const [specLoading, setSpecLoading] = useState(false);

  // Debounce so a fast typist doesn't fire a request per keystroke.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    async (q: string) => {
      if (!api) return;
      setLoading(true);
      setError(null);
      try {
        const r = await api.searchSymbols(q, 60);
        setResults(r.symbols);
        setTotal(r.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void search(query), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, open, search]);

  // Load the contract detail for whatever is currently chosen.
  const loadSpec = useCallback(
    async (symbol: string) => {
      if (!api || !symbol) return;
      setSpecLoading(true);
      try {
        setSpec(await api.symbolSpec(symbol));
      } catch {
        setSpec(null);
      } finally {
        setSpecLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void loadSpec(value);
  }, [value, loadSpec]);

  const choose = (symbol: string) => {
    onChange(symbol);
    setOpen(false);
    setQuery('');
  };

  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[font.label, { marginBottom: space.xs }]}>{label.toUpperCase()}</Text>

      <Pressable style={s.field} onPress={() => setOpen(true)}>
        <View style={{ flex: 1 }}>
          <Text style={s.fieldValue}>{value || 'Tap to choose a symbol'}</Text>
          {spec?.description ? <Text style={font.small}>{spec.description}</Text> : null}
        </View>
        <Text style={{ color: colors.muted, fontSize: 18 }}>›</Text>
      </Pressable>

      {/* Contract detail — these differ per instrument and change what a
          "100 point stop" actually costs. */}
      {specLoading ? (
        <Text style={[font.small, { marginTop: space.xs }]}>Loading contract details…</Text>
      ) : spec ? (
        <View style={s.specBox}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            <SpecChip label="Digits" value={String(spec.digits)} />
            <SpecChip label="1 point" value={String(spec.point)} />
            <SpecChip label="Spread" value={`${spec.spreadPoints} pts`} />
            <SpecChip label="Per point / lot" value={spec.pointValuePerLot.toFixed(2)} />
          </View>
          {spec.quote ? (
            <Text style={[font.small, { marginTop: space.xs }]}>
              Bid {spec.quote.bid} · Ask {spec.quote.ask}
            </Text>
          ) : null}
          {spec.pointValueEstimated ? (
            <View style={{ marginTop: space.sm }}>
              <Banner tone="warning">
                Your broker didn&apos;t report this symbol&apos;s contract size or tick value, so the value per
                point is assumed to be {spec.pointValuePerLot.toFixed(2)}. That is right for USD-quoted
                instruments, but check position sizes against MetaTrader before trading anything else.
              </Banner>
            </View>
          ) : null}
        </View>
      ) : null}

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Choose a symbol"
        footer={<Button title="Close" variant="ghost" style={{ flex: 1 }} onPress={() => setOpen(false)} />}
      >
        <TextInput
          style={s.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Type to search — e.g. eur, xau, gold"
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
        />

        {error ? <Banner tone="critical">{error}</Banner> : null}

        {loading ? (
          <View style={{ paddingVertical: space.lg, alignItems: 'center' }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : results.length === 0 ? (
          <Text style={[font.body, { paddingVertical: space.lg, textAlign: 'center' }]}>
            {query ? `Nothing matches "${query}" at your broker.` : 'No symbols returned.'}
          </Text>
        ) : (
          <>
            <Text style={[font.small, { marginBottom: space.sm }]}>
              {total} match{total === 1 ? '' : 'es'}
              {total > results.length ? ` · showing first ${results.length}` : ''}
            </Text>
            {results.map((sym) => (
              <Pressable
                key={sym}
                onPress={() => choose(sym)}
                style={({ pressed }) => [s.result, pressed && { backgroundColor: colors.surfaceAlt }]}
              >
                <Text style={s.resultText}>{sym}</Text>
                {sym === value ? <Badge label="CURRENT" tone="accent" /> : null}
              </Pressable>
            ))}
          </>
        )}
      </Sheet>
    </View>
  );
}

function SpecChip({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={font.label}>{label.toUpperCase()}</Text>
      <Text style={s.specValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: 44,
  },
  fieldValue: { color: colors.text, fontSize: 15, fontWeight: '600' },
  specBox: {
    marginTop: space.sm,
    padding: space.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  specValue: { color: colors.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  search: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space.md,
    height: 46,
    fontSize: 16,
    marginBottom: space.md,
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  resultText: { color: colors.text, fontSize: 15, fontWeight: '500' },
});
