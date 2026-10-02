import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  Divider,
  Field,
  NumberField,
  Row,
  SectionTitle,
  Segmented,
  Sheet,
} from '../components/ui';
import { confirmAction, notify } from '../confirm';
import { SymbolPicker } from '../components/SymbolPicker';
import { useApp } from '../store';
import { colors, font, radius, space } from '../theme';
import type {
  ComparisonOp,
  Condition,
  IndicatorSpec,
  IndicatorType,
  Operand,
  PriceSource,
  RiskConfig,
  RuleGroup,
  Strategy,
  Timeframe,
} from '../types';

type Tab = 'rules' | 'indicators' | 'risk';
type RuleSlot = 'entryLong' | 'entryShort' | 'exitLong' | 'exitShort';

const RULE_LABELS: Record<RuleSlot, string> = {
  entryLong: 'Buy when',
  entryShort: 'Sell when',
  exitLong: 'Close buys when',
  exitShort: 'Close sells when',
};

export function StrategyEditor({
  strategy: initial,
  onClose,
  onBacktest,
}: {
  strategy: Strategy;
  onClose: () => void;
  onBacktest: (s: Strategy) => void;
}) {
  const { api, catalog, refreshStrategies } = useApp();
  const [draft, setDraft] = useState<Strategy>(() => JSON.parse(JSON.stringify(initial)) as Strategy);
  const [tab, setTab] = useState<Tab>('rules');
  const [slot, setSlot] = useState<RuleSlot>('entryLong');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Condition editing target: null = closed, index -1 = adding a new condition.
  const [editing, setEditing] = useState<{ slot: RuleSlot; index: number } | null>(null);
  const [editingIndicator, setEditingIndicator] = useState<{ index: number } | null>(null);

  const update = (patch: Partial<Strategy>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const updateRisk = (patch: Partial<RiskConfig>) => {
    setDraft((d) => ({ ...d, risk: { ...d.risk, ...patch } }));
    setDirty(true);
  };

  const group = (s: RuleSlot): RuleGroup => draft[s] ?? { logic: 'AND', conditions: [] };

  const setGroup = (s: RuleSlot, g: RuleGroup) => {
    setDraft((d) => ({ ...d, [s]: g }));
    setDirty(true);
  };

  const save = async () => {
    if (!api) return;
    setSaving(true);
    try {
      await api.updateStrategy(draft.id, draft);
      await refreshStrategies();
      setDirty(false);
      notify('Saved', 'A running bot will pick up the change on its next bar.');
    } catch (err) {
      notify('Could not save', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const leave = () => {
    if (!dirty) return onClose();
    confirmAction('Discard changes?', 'You have unsaved edits.', 'Discard', onClose, { destructive: true });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header ---------------------------------------------------------- */}
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, width: '100%', maxWidth: 1100, alignSelf: 'center' as const, }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
          <Pressable
            onPress={leave}
            hitSlop={16}
            style={{ marginRight: space.sm, paddingVertical: space.sm, paddingRight: space.md, minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>‹ Back</Text>
          </Pressable>
          <Text style={[font.h3, { flex: 1 }]} numberOfLines={1}>
            {draft.name}
          </Text>
          {dirty ? <Badge label="UNSAVED" tone="warning" /> : null}
        </View>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'rules', label: 'Rules' },
            { value: 'indicators', label: 'Indicators' },
            { value: 'risk', label: 'Risk' },
          ]}
        />
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: 0, paddingBottom: 120, width: '100%', maxWidth: 1100, alignSelf: 'center' as const, }}>
        {tab === 'rules' && (
          <RulesTab
            draft={draft}
            slot={slot}
            setSlot={setSlot}
            group={group}
            setGroup={setGroup}
            onEditCondition={(s, i) => setEditing({ slot: s, index: i })}
            update={update}
          />
        )}

        {tab === 'indicators' && (
          <IndicatorsTab
            draft={draft}
            onEdit={(i) => setEditingIndicator({ index: i })}
            onRemove={(i) => {
              const ind = draft.indicators[i];
              const used = usesIndicator(draft, ind.id);
              if (used) {
                notify('In use', `"${ind.id}" is referenced by a rule. Remove that rule first.`);
                return;
              }
              update({ indicators: draft.indicators.filter((_, k) => k !== i) });
            }}
          />
        )}

        {tab === 'risk' && <RiskTab risk={draft.risk} indicators={draft.indicators} onChange={updateRisk} />}
      </ScrollView>

      {/* Footer ---------------------------------------------------------- */}
      <View style={st.footer}>
        <Button title="Backtest" variant="secondary" style={{ flex: 1 }} onPress={() => onBacktest(draft)} />
        <Button title="Save" style={{ flex: 1 }} loading={saving} disabled={!dirty} onPress={save} />
      </View>

      {/* Sheets ---------------------------------------------------------- */}
      {editing && (
        <ConditionSheet
          visible
          strategy={draft}
          slotLabel={RULE_LABELS[editing.slot]}
          condition={editing.index >= 0 ? group(editing.slot).conditions[editing.index] : null}
          onClose={() => setEditing(null)}
          onDelete={
            editing.index >= 0
              ? () => {
                  const g = group(editing.slot);
                  setGroup(editing.slot, {
                    ...g,
                    conditions: g.conditions.filter((_, i) => i !== editing.index),
                  });
                  setEditing(null);
                }
              : undefined
          }
          onSave={(c) => {
            const g = group(editing.slot);
            const conditions = [...g.conditions];
            if (editing.index >= 0) conditions[editing.index] = c;
            else conditions.push(c);
            setGroup(editing.slot, { ...g, conditions });
            setEditing(null);
          }}
        />
      )}

      {editingIndicator && (
        <IndicatorSheet
          visible
          existing={editingIndicator.index >= 0 ? draft.indicators[editingIndicator.index] : null}
          takenIds={draft.indicators.map((i) => i.id)}
          onClose={() => setEditingIndicator(null)}
          onSave={(spec) => {
            const list = [...draft.indicators];
            if (editingIndicator.index >= 0) list[editingIndicator.index] = spec;
            else list.push(spec);
            update({ indicators: list });
            setEditingIndicator(null);
          }}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function RulesTab({
  draft,
  slot,
  setSlot,
  group,
  setGroup,
  onEditCondition,
  update,
}: {
  draft: Strategy;
  slot: RuleSlot;
  setSlot: (s: RuleSlot) => void;
  group: (s: RuleSlot) => RuleGroup;
  setGroup: (s: RuleSlot, g: RuleGroup) => void;
  onEditCondition: (s: RuleSlot, i: number) => void;
  update: (p: Partial<Strategy>) => void;
}) {
  const { catalog } = useApp();
  const g = group(slot);

  return (
    <>
      <Card>
        <Field label="Name" value={draft.name} onChangeText={(v) => update({ name: v })} autoCapitalize="sentences" />
        <SymbolPicker value={draft.symbol} onChange={(v) => update({ symbol: v })} />
        <Text style={[font.label, { marginBottom: space.xs }]}>TIMEFRAME</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {(catalog?.timeframes ?? ['5m']).map((tf) => (
            <Chip
              key={tf}
              label={tf}
              active={draft.timeframe === tf}
              tone="accent"
              onPress={() => update({ timeframe: tf as Timeframe })}
            />
          ))}
        </View>
      </Card>

      <SectionTitle>Rule set</SectionTitle>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md }}>
        {(Object.keys(RULE_LABELS) as RuleSlot[]).map((s) => (
          <Chip
            key={s}
            label={`${RULE_LABELS[s]} (${group(s).conditions.length})`}
            active={slot === s}
            tone={s.startsWith('entry') ? 'accent' : 'neutral'}
            onPress={() => setSlot(s)}
          />
        ))}
      </View>

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
          <Text style={[font.h3, { flex: 1 }]}>{RULE_LABELS[slot]}…</Text>
          {g.conditions.length > 1 ? (
            <Pressable onPress={() => setGroup(slot, { ...g, logic: g.logic === 'AND' ? 'OR' : 'AND' })}>
              <Badge label={g.logic === 'AND' ? 'ALL MUST MATCH' : 'ANY MAY MATCH'} tone="accent" />
            </Pressable>
          ) : null}
        </View>

        {g.conditions.length === 0 ? (
          <Text style={[font.body, { marginBottom: space.md }]}>
            {slot.startsWith('entry')
              ? 'No conditions — this side will never trade.'
              : 'No conditions — positions close only on stop, target or the opposite signal.'}
          </Text>
        ) : (
          g.conditions.map((c, i) => (
            <View key={i}>
              {i > 0 ? (
                <View style={st.logicPill}>
                  <Text style={st.logicText}>{g.logic}</Text>
                </View>
              ) : null}
              <Pressable onPress={() => onEditCondition(slot, i)} style={st.conditionRow}>
                <Text style={st.conditionText}>{describeCondition(c, draft)}</Text>
                <Text style={{ color: colors.muted, fontSize: 18 }}>›</Text>
              </Pressable>
            </View>
          ))
        )}

        <Button
          title="Add condition"
          icon="+"
          variant="secondary"
          small
          style={{ marginTop: space.sm }}
          onPress={() => onEditCondition(slot, -1)}
        />
      </Card>

      <Banner tone="accent">
        Conditions are checked on the close of each completed bar. The bar still forming is ignored, which is
        what keeps live behaviour comparable to the backtest.
      </Banner>
    </>
  );
}

// ---------------------------------------------------------------------------
// Condition editor
// ---------------------------------------------------------------------------

const DEFAULT_CONDITION: Condition = {
  left: { kind: 'price', field: 'close' },
  op: 'gt',
  right: { kind: 'const', value: 0 },
};

function ConditionSheet({
  visible,
  strategy,
  slotLabel,
  condition,
  onClose,
  onSave,
  onDelete,
}: {
  visible: boolean;
  strategy: Strategy;
  slotLabel: string;
  condition: Condition | null;
  onClose: () => void;
  onSave: (c: Condition) => void;
  onDelete?: () => void;
}) {
  const { catalog } = useApp();
  const [draft, setDraft] = useState<Condition>(() =>
    condition ? (JSON.parse(JSON.stringify(condition)) as Condition) : DEFAULT_CONDITION,
  );
  const [picking, setPicking] = useState<'left' | 'right' | null>(null);

  const operators = catalog?.operators ?? [];
  const isCountOp = draft.op === 'risingFor' || draft.op === 'fallingFor';

  return (
    <>
      <Sheet
        visible={visible}
        onClose={onClose}
        title={condition ? 'Edit condition' : 'New condition'}
        footer={
          <>
            {onDelete ? <Button title="Delete" variant="danger" small style={{ flex: 1 }} onPress={onDelete} /> : null}
            <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={onClose} />
            <Button title="Done" style={{ flex: 2 }} onPress={() => onSave(draft)} />
          </>
        }
      >
        <Text style={[font.body, { marginBottom: space.lg }]}>
          {slotLabel}… <Text style={{ color: colors.text, fontWeight: '600' }}>{describeCondition(draft, strategy)}</Text>
        </Text>

        <Text style={[font.label, { marginBottom: space.xs }]}>LEFT SIDE</Text>
        <Pressable style={st.operandButton} onPress={() => setPicking('left')}>
          <Text style={st.operandText}>{operandLabel(draft.left, strategy)}</Text>
          <Text style={{ color: colors.muted }}>change</Text>
        </Pressable>

        <Text style={[font.label, { marginTop: space.lg, marginBottom: space.xs }]}>COMPARISON</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {operators.map((o) => (
            <Chip
              key={o.value}
              label={o.label}
              active={draft.op === o.value}
              tone="accent"
              onPress={() => {
                const next: Condition = { ...draft, op: o.value as ComparisonOp };
                // rising/falling compares a series against a bar count, not a level.
                if ((o.value === 'risingFor' || o.value === 'fallingFor') && next.right.kind !== 'const') {
                  next.right = { kind: 'const', value: 3 };
                }
                setDraft(next);
              }}
            />
          ))}
        </View>

        <Text style={[font.label, { marginTop: space.lg, marginBottom: space.xs }]}>
          {isCountOp ? 'NUMBER OF BARS' : 'RIGHT SIDE'}
        </Text>
        {isCountOp ? (
          <NumberField
            label=""
            value={draft.right.kind === 'const' ? draft.right.value : 3}
            onChange={(v) => setDraft({ ...draft, right: { kind: 'const', value: Math.max(1, Math.round(v)) } })}
          />
        ) : (
          <Pressable style={st.operandButton} onPress={() => setPicking('right')}>
            <Text style={st.operandText}>{operandLabel(draft.right, strategy)}</Text>
            <Text style={{ color: colors.muted }}>change</Text>
          </Pressable>
        )}
      </Sheet>

      {picking && (
        <OperandSheet
          visible
          strategy={strategy}
          operand={picking === 'left' ? draft.left : draft.right}
          onClose={() => setPicking(null)}
          onSave={(op) => {
            setDraft(picking === 'left' ? { ...draft, left: op } : { ...draft, right: op });
            setPicking(null);
          }}
        />
      )}
    </>
  );
}

type OperandKind = 'indicator' | 'price' | 'const' | 'spread' | 'hourUTC';

function OperandSheet({
  visible,
  strategy,
  operand,
  onClose,
  onSave,
}: {
  visible: boolean;
  strategy: Strategy;
  operand: Operand;
  onClose: () => void;
  onSave: (o: Operand) => void;
}) {
  const { catalog } = useApp();
  const [draft, setDraft] = useState<Operand>(() => JSON.parse(JSON.stringify(operand)) as Operand);
  const kind = draft.kind as OperandKind;

  const setKind = (k: OperandKind) => {
    if (k === draft.kind) return;
    if (k === 'indicator') {
      const first = strategy.indicators[0];
      if (!first) {
        notify('No indicators', 'Add an indicator on the Indicators tab first.');
        return;
      }
      setDraft({ kind: 'indicator', id: first.id, line: 'value', shift: 0 });
    } else if (k === 'price') setDraft({ kind: 'price', field: 'close', shift: 0 });
    else if (k === 'const') setDraft({ kind: 'const', value: 0 });
    else if (k === 'spread') setDraft({ kind: 'spread' });
    else setDraft({ kind: 'hourUTC' });
  };

  const linesFor = (id: string): readonly string[] => {
    const spec = strategy.indicators.find((i) => i.id === id);
    const entry = catalog?.indicators.find((c) => c.type === spec?.type);
    return entry?.lines ?? ['value'];
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Choose a value"
      footer={
        <>
          <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={onClose} />
          <Button title="Use this" style={{ flex: 2 }} onPress={() => onSave(draft)} />
        </>
      }
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.lg }}>
        {([
          ['indicator', 'Indicator'],
          ['price', 'Price'],
          ['const', 'Number'],
          ['spread', 'Spread'],
          ['hourUTC', 'Hour (UTC)'],
        ] as [OperandKind, string][]).map(([k, label]) => (
          <Chip key={k} label={label} active={kind === k} tone="accent" onPress={() => setKind(k)} />
        ))}
      </View>

      {draft.kind === 'indicator' && (
        <>
          <Text style={[font.label, { marginBottom: space.xs }]}>WHICH INDICATOR</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.lg }}>
            {strategy.indicators.map((i) => (
              <Chip
                key={i.id}
                label={`${i.id} (${i.type.toUpperCase()})`}
                active={draft.id === i.id}
                onPress={() => setDraft({ ...draft, id: i.id, line: linesFor(i.id)[0] })}
              />
            ))}
          </View>

          {linesFor(draft.id).length > 1 && (
            <>
              <Text style={[font.label, { marginBottom: space.xs }]}>WHICH LINE</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.lg }}>
                {linesFor(draft.id).map((l) => (
                  <Chip key={l} label={l} active={(draft.line ?? 'value') === l} onPress={() => setDraft({ ...draft, line: l })} />
                ))}
              </View>
            </>
          )}

          <NumberField
            label="Bars back"
            value={draft.shift ?? 0}
            onChange={(v) => setDraft({ ...draft, shift: Math.max(0, Math.round(v)) })}
            hint="0 = the bar that just closed, 1 = the one before it."
          />
        </>
      )}

      {draft.kind === 'price' && (
        <>
          <Text style={[font.label, { marginBottom: space.xs }]}>WHICH PRICE</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.lg }}>
            {(catalog?.priceFields ?? ['close']).map((f) => (
              <Chip key={f} label={f} active={draft.field === f} onPress={() => setDraft({ ...draft, field: f as PriceSource })} />
            ))}
          </View>
          <NumberField
            label="Bars back"
            value={draft.shift ?? 0}
            onChange={(v) => setDraft({ ...draft, shift: Math.max(0, Math.round(v)) })}
          />
        </>
      )}

      {draft.kind === 'const' && (
        <NumberField
          label="Value"
          value={draft.value}
          onChange={(v) => setDraft({ kind: 'const', value: v })}
          step={1}
          hint="For RSI-style indicators use 0–100. For price comparisons use an actual price."
        />
      )}

      {draft.kind === 'spread' && (
        <Text style={font.body}>The current spread in points. Useful for blocking entries when costs spike.</Text>
      )}

      {draft.kind === 'hourUTC' && (
        <Text style={font.body}>
          The hour of the bar in UTC, 0–23. Useful for restricting a rule to a session without changing the
          global session filter.
        </Text>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

function IndicatorsTab({
  draft,
  onEdit,
  onRemove,
}: {
  draft: Strategy;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  const { catalog } = useApp();
  return (
    <>
      <Banner tone="accent">
        Indicators are computed once per bar and referenced by id in your rules. Give them names you will
        recognise, like <Text style={{ color: colors.text }}>ema_fast</Text>.
      </Banner>

      {draft.indicators.map((i, idx) => {
        const meta = catalog?.indicators.find((c) => c.type === i.type);
        return (
          <Card key={i.id} style={{ marginBottom: space.sm }}>
            <Pressable onPress={() => onEdit(idx)}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={font.h3}>{i.id}</Text>
                  <Text style={font.small}>
                    {meta?.label ?? i.type.toUpperCase()}
                    {i.source ? ` · ${i.source}` : ''}
                  </Text>
                </View>
                <Text style={{ color: colors.muted, fontSize: 18 }}>›</Text>
              </View>
              <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.sm, flexWrap: 'wrap' }}>
                {Object.entries(i.params).map(([k, v]) => (
                  <Chip key={k} label={`${k} ${v}`} />
                ))}
              </View>
            </Pressable>
            <Button title="Remove" variant="ghost" small style={{ marginTop: space.md }} onPress={() => onRemove(idx)} />
          </Card>
        );
      })}

      <Button title="Add indicator" icon="+" variant="secondary" onPress={() => onEdit(-1)} />
    </>
  );
}

function IndicatorSheet({
  visible,
  existing,
  takenIds,
  onClose,
  onSave,
}: {
  visible: boolean;
  existing: IndicatorSpec | null;
  takenIds: string[];
  onClose: () => void;
  onSave: (s: IndicatorSpec) => void;
}) {
  const { catalog } = useApp();
  const [type, setType] = useState<IndicatorType>(existing?.type ?? 'ema');
  const [id, setId] = useState(existing?.id ?? '');
  const [source, setSource] = useState<PriceSource>(existing?.source ?? 'close');
  const [params, setParams] = useState<Record<string, number>>(existing?.params ?? {});

  const meta = catalog?.indicators.find((c) => c.type === type);

  // Reset params to the catalog defaults whenever the indicator type changes.
  const applyType = (t: IndicatorType) => {
    setType(t);
    const m = catalog?.indicators.find((c) => c.type === t);
    const defaults: Record<string, number> = {};
    for (const p of m?.params ?? []) defaults[p.key] = p.default;
    setParams(defaults);
    if (!existing && (!id || takenIds.includes(id))) setId(suggestId(t, takenIds));
  };

  const submit = () => {
    const cleanId = (id || suggestId(type, takenIds)).trim().replace(/\s+/g, '_');
    if (!existing && takenIds.includes(cleanId)) {
      notify('Name taken', `An indicator called "${cleanId}" already exists.`);
      return;
    }
    const spec: IndicatorSpec = { id: cleanId, type, params };
    if (meta?.usesSource) spec.source = source;
    onSave(spec);
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={existing ? 'Edit indicator' : 'Add indicator'}
      footer={
        <>
          <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={onClose} />
          <Button title="Save" style={{ flex: 2 }} onPress={submit} />
        </>
      }
    >
      <Text style={[font.label, { marginBottom: space.xs }]}>TYPE</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.lg }}>
        {(catalog?.indicators ?? []).map((c) => (
          <Chip key={c.type} label={c.label} active={type === c.type} tone="accent" onPress={() => applyType(c.type)} />
        ))}
      </View>

      <Field
        label="Reference name"
        value={id}
        onChangeText={setId}
        placeholder={suggestId(type, takenIds)}
        hint="How your rules refer to this indicator."
      />

      {meta?.usesSource && (
        <>
          <Text style={[font.label, { marginBottom: space.xs }]}>APPLIED TO</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.lg }}>
            {(catalog?.priceFields ?? ['close']).map((f) => (
              <Chip key={f} label={f} active={source === f} onPress={() => setSource(f)} />
            ))}
          </View>
        </>
      )}

      {(meta?.params ?? []).map((p) => (
        <NumberField
          key={p.key}
          label={p.label}
          value={params[p.key] ?? p.default}
          onChange={(v) => setParams({ ...params, [p.key]: clamp(v, p.min, p.max) })}
          step={p.key === 'mult' ? 0.1 : 1}
        />
      ))}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

function RiskTab({
  risk,
  indicators,
  onChange,
}: {
  risk: RiskConfig;
  indicators: IndicatorSpec[];
  onChange: (p: Partial<RiskConfig>) => void;
}) {
  const atrIndicators = indicators.filter((i) => i.type === 'atr');
  const needsAtr = risk.slMode === 'atr' || risk.tpMode === 'atr';

  return (
    <>
      <SectionTitle>Position size</SectionTitle>
      <Card>
        <Segmented
          value={risk.lotMode}
          onChange={(v) => onChange({ lotMode: v })}
          options={[
            { value: 'fixed', label: 'Fixed lots' },
            { value: 'percentRisk', label: '% of balance' },
          ]}
        />
        {risk.lotMode === 'fixed' ? (
          <NumberField label="Lots per trade" value={risk.fixedLot} onChange={(v) => onChange({ fixedLot: v })} step={0.01} />
        ) : (
          <NumberField
            label="Risk per trade (%)"
            value={risk.riskPercent}
            onChange={(v) => onChange({ riskPercent: v })}
            step={0.1}
            hint="Lot size is solved so that hitting the stop loses this much of your balance. Needs a stop loss."
          />
        )}
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <NumberField label="Min lot" value={risk.minLot} onChange={(v) => onChange({ minLot: v })} step={0.01} />
          </View>
          <View style={{ flex: 1 }}>
            <NumberField label="Max lot" value={risk.maxLot} onChange={(v) => onChange({ maxLot: v })} step={0.1} />
          </View>
        </View>
      </Card>

      <SectionTitle>Stop loss</SectionTitle>
      <Card>
        <Segmented
          value={risk.slMode}
          onChange={(v) => onChange({ slMode: v })}
          options={[
            { value: 'points', label: 'Points' },
            { value: 'atr', label: 'ATR' },
            { value: 'none', label: 'None' },
          ]}
        />
        {risk.slMode === 'points' && (
          <NumberField label="Stop distance (points)" value={risk.slPoints} onChange={(v) => onChange({ slPoints: v })} step={10} />
        )}
        {risk.slMode === 'atr' && (
          <NumberField label="ATR multiple" value={risk.slAtrMult} onChange={(v) => onChange({ slAtrMult: v })} step={0.1} />
        )}
        {risk.slMode === 'none' && (
          <Banner tone="critical">
            No stop loss means unbounded downside on every trade, and percent-risk sizing cannot work. Only do
            this if an exit rule reliably closes the position.
          </Banner>
        )}
      </Card>

      <SectionTitle>Take profit</SectionTitle>
      <Card>
        <Segmented
          value={risk.tpMode}
          onChange={(v) => onChange({ tpMode: v })}
          options={[
            { value: 'points', label: 'Points' },
            { value: 'atr', label: 'ATR' },
            { value: 'rr', label: 'R:R' },
            { value: 'none', label: 'None' },
          ]}
        />
        {risk.tpMode === 'points' && (
          <NumberField label="Target distance (points)" value={risk.tpPoints} onChange={(v) => onChange({ tpPoints: v })} step={10} />
        )}
        {risk.tpMode === 'atr' && (
          <NumberField label="ATR multiple" value={risk.tpAtrMult} onChange={(v) => onChange({ tpAtrMult: v })} step={0.1} />
        )}
        {risk.tpMode === 'rr' && (
          <NumberField
            label="Reward : risk"
            value={risk.tpRR}
            onChange={(v) => onChange({ tpRR: v })}
            step={0.1}
            hint="1.5 means the target sits 1.5× the stop distance away."
          />
        )}
      </Card>

      {needsAtr && (
        <>
          <SectionTitle>ATR source</SectionTitle>
          <Card>
            {atrIndicators.length === 0 ? (
              <Banner tone="warning">
                ATR-based stops need an ATR indicator. Add one on the Indicators tab, then pick it here.
              </Banner>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                {atrIndicators.map((i) => (
                  <Chip
                    key={i.id}
                    label={`${i.id} (period ${i.params.period ?? 14})`}
                    active={risk.atrIndicatorId === i.id}
                    tone="accent"
                    onPress={() => onChange({ atrIndicatorId: i.id })}
                  />
                ))}
              </View>
            )}
          </Card>
        </>
      )}

      <SectionTitle>Protecting profit</SectionTitle>
      <Card>
        <Row label="Trailing stop" value={risk.trailingEnabled ? 'on' : 'off'} />
        <View style={{ flexDirection: 'row', gap: space.xs, marginBottom: space.md }}>
          <Chip label="Off" active={!risk.trailingEnabled} onPress={() => onChange({ trailingEnabled: false })} />
          <Chip label="On" active={risk.trailingEnabled} tone="good" onPress={() => onChange({ trailingEnabled: true })} />
        </View>
        {risk.trailingEnabled && (
          <>
            <NumberField
              label="Start trailing after (points)"
              value={risk.trailingStartPoints}
              onChange={(v) => onChange({ trailingStartPoints: v })}
              step={10}
            />
            <NumberField
              label="Trail distance (points)"
              value={risk.trailingStepPoints}
              onChange={(v) => onChange({ trailingStepPoints: v })}
              step={10}
            />
          </>
        )}
        <NumberField
          label="Move stop to entry after (points)"
          value={risk.breakEvenPoints}
          onChange={(v) => onChange({ breakEvenPoints: Math.max(0, v) })}
          step={10}
          hint="0 turns break-even off."
        />
      </Card>

      <SectionTitle>Daily guard rails</SectionTitle>
      <Card>
        <NumberField
          label="Max daily loss (%)"
          value={risk.maxDailyLossPercent}
          onChange={(v) => onChange({ maxDailyLossPercent: Math.max(0, v) })}
          step={0.5}
          hint="Trading stops for the rest of the UTC day once equity is down this much. 0 disables it."
        />
        <NumberField
          label="Max trades per day"
          value={risk.maxDailyTrades}
          onChange={(v) => onChange({ maxDailyTrades: Math.max(0, Math.round(v)) })}
          hint="0 means unlimited."
        />
        <NumberField
          label="Max open positions"
          value={risk.maxOpenPositions}
          onChange={(v) => onChange({ maxOpenPositions: Math.max(1, Math.round(v)) })}
        />
        <NumberField
          label="Bars between entries"
          value={risk.cooldownBars}
          onChange={(v) => onChange({ cooldownBars: Math.max(0, Math.round(v)) })}
        />
        <NumberField
          label="Max spread (points)"
          value={risk.maxSpreadPoints}
          onChange={(v) => onChange({ maxSpreadPoints: Math.max(0, v) })}
          step={5}
          hint="Entries are skipped when the spread is wider than this. Critical for scalping."
        />
      </Card>

      <SectionTitle>Trading hours (UTC)</SectionTitle>
      <Card>
        {risk.sessions.length === 0 ? (
          <Text style={[font.body, { marginBottom: space.md }]}>Trading around the clock.</Text>
        ) : (
          risk.sessions.map((sess, i) => (
            <View key={i} style={{ marginBottom: space.md }}>
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <View style={{ flex: 1 }}>
                  <NumberField
                    label="From"
                    value={sess.startHour}
                    onChange={(v) => {
                      const next = [...risk.sessions];
                      next[i] = { ...sess, startHour: clamp(Math.round(v), 0, 23) };
                      onChange({ sessions: next });
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <NumberField
                    label="To"
                    value={sess.endHour}
                    onChange={(v) => {
                      const next = [...risk.sessions];
                      next[i] = { ...sess, endHour: clamp(Math.round(v), 0, 24) };
                      onChange({ sessions: next });
                    }}
                  />
                </View>
              </View>
              <Button
                title="Remove window"
                variant="ghost"
                small
                onPress={() => onChange({ sessions: risk.sessions.filter((_, k) => k !== i) })}
              />
            </View>
          ))
        )}
        <Button
          title="Add trading window"
          icon="+"
          variant="secondary"
          small
          onPress={() => onChange({ sessions: [...risk.sessions, { startHour: 7, endHour: 16 }] })}
        />

        <Divider />
        <Text style={[font.label, { marginBottom: space.xs }]}>TRADING DAYS</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => {
            const on = risk.tradingDays.length === 0 || risk.tradingDays.includes(i);
            return (
              <Chip
                key={d}
                label={d}
                active={on}
                tone="accent"
                onPress={() => {
                  const base = risk.tradingDays.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : risk.tradingDays;
                  const next = base.includes(i) ? base.filter((x) => x !== i) : [...base, i].sort();
                  onChange({ tradingDays: next.length === 7 ? [] : next });
                }}
              />
            );
          })}
        </View>
      </Card>

      <SectionTitle>Behaviour</SectionTitle>
      <Card>
        <Row label="Close on opposite signal" value={risk.closeOnOppositeSignal ? 'yes' : 'no'} />
        <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.sm }}>
          <Chip label="No" active={!risk.closeOnOppositeSignal} onPress={() => onChange({ closeOnOppositeSignal: false })} />
          <Chip label="Yes" active={risk.closeOnOppositeSignal} tone="accent" onPress={() => onChange({ closeOnOppositeSignal: true })} />
        </View>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OP_TEXT: Record<ComparisonOp, string> = {
  gt: 'is above',
  lt: 'is below',
  gte: 'is at or above',
  lte: 'is at or below',
  crossesAbove: 'crosses above',
  crossesBelow: 'crosses below',
  risingFor: 'has risen for',
  fallingFor: 'has fallen for',
};

export function operandLabel(op: Operand, strategy: Strategy): string {
  switch (op.kind) {
    case 'const':
      return String(op.value);
    case 'spread':
      return 'spread';
    case 'hourUTC':
      return 'hour (UTC)';
    case 'price':
      return `${op.field}${op.shift ? ` ${op.shift} bars ago` : ''}`;
    case 'indicator': {
      const line = op.line && op.line !== 'value' ? `.${op.line}` : '';
      return `${op.id}${line}${op.shift ? ` ${op.shift} bars ago` : ''}`;
    }
    default:
      return '?';
  }
}

export function describeCondition(c: Condition, strategy: Strategy): string {
  const suffix = c.op === 'risingFor' || c.op === 'fallingFor' ? ' bars' : '';
  return `${operandLabel(c.left, strategy)} ${OP_TEXT[c.op] ?? c.op} ${operandLabel(c.right, strategy)}${suffix}`;
}

function usesIndicator(s: Strategy, id: string): boolean {
  const groups: (RuleGroup | undefined)[] = [s.entryLong, s.entryShort, s.exitLong, s.exitShort];
  for (const g of groups) {
    for (const c of g?.conditions ?? []) {
      for (const side of [c.left, c.right]) {
        if (side.kind === 'indicator' && side.id === id) return true;
      }
    }
  }
  return s.risk.atrIndicatorId === id;
}

function suggestId(type: IndicatorType, taken: string[]): string {
  let n = 1;
  let candidate: string = type;
  while (taken.includes(candidate)) {
    n += 1;
    candidate = `${type}${n}`;
  }
  return candidate;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

const st = {
  footer: {
    flexDirection: 'row' as const,
    gap: space.sm,
    padding: space.lg,
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  conditionRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
  },
  conditionText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
  logicPill: {
    alignSelf: 'center' as const,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    marginVertical: space.xs,
  },
  logicText: { color: colors.muted, fontSize: 11, fontWeight: '700' as const, letterSpacing: 1 },
  operandButton: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    padding: space.md,
  },
  operandText: { color: colors.text, fontSize: 15, fontWeight: '600' as const },
};
