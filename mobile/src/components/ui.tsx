import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLayout } from '../layout';
import { colors, font, layout, money, pnlColor, radius, signGlyph, space } from '../theme';

// ---------------------------------------------------------------------------

export function Card({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  return <View style={[s.card, padded && { padding: space.lg }, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={s.sectionTitle}>
      <Text style={font.label}>{String(children).toUpperCase()}</Text>
      {right}
    </View>
  );
}

export function Divider() {
  return <View style={s.divider} />;
}

/**
 * Pins its content to the top of the nearest scrolling ancestor (CSS
 * `position: sticky`, which react-native-web passes straight through). Use it
 * for a filter/toolbar strip that should stay put while a long list scrolls
 * beneath it. Native builds simply ignore an unrecognized position value and
 * render in normal flow — a harmless no-op there.
 */
export function Sticky({
  children,
  style,
  top = 0,
  zIndex = 5,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  top?: number;
  zIndex?: number;
}) {
  return <View style={[{ position: 'sticky' as any, top, zIndex, backgroundColor: colors.bg }, style]}>{children}</View>;
}

// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  small,
  style,
  icon,
  accessibilityLabel,
}: {
  title: string;
  accessibilityLabel?: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: string;
}) {
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.accentStrong, fg: '#FFFFFF', border: colors.accentStrong },
    success: { bg: colors.goodStrong, fg: '#FFFFFF', border: colors.goodStrong },
    danger: { bg: colors.criticalStrong, fg: '#FFFFFF', border: colors.criticalStrong },
    secondary: { bg: colors.surfaceAlt, fg: colors.text, border: colors.borderStrong },
    ghost: { bg: 'transparent', fg: colors.textSecondary, border: colors.border },
  };
  const p = palette[variant];
  const isOff = disabled || loading;

  return (
    <Pressable
      onPress={isOff ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!isOff, busy: !!loading }}
      style={(state) => [
        s.btn,
        small && s.btnSmall,
        { backgroundColor: p.bg, borderColor: p.border },
        (state as { hovered?: boolean }).hovered && !isOff && { opacity: 0.88 },
        state.pressed && !isOff && { opacity: 0.75 },
        isOff && { opacity: 0.4 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={p.fg} size="small" />
      ) : (
        <Text style={[s.btnText, small && { fontSize: 13 }, { color: p.fg }]}>
          {icon ? `${icon}  ` : ''}
          {title}
        </Text>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  hint,
  autoCapitalize = 'none',
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad' | 'url';
  hint?: string;
  autoCapitalize?: 'none' | 'sentences' | 'words';
  multiline?: boolean;
}) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[font.label, { marginBottom: space.xs }]}>{label.toUpperCase()}</Text>
      <TextInput
        style={[s.input, multiline && { height: 88, textAlignVertical: 'top' }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        multiline={multiline}
      />
      {hint ? <Text style={[font.small, { marginTop: space.xs }]}>{hint}</Text> : null}
    </View>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  hint,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  step?: number;
}) {
  // Keep the raw text so a half-typed "0." or "-" is not clobbered mid-edit.
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (t: string) => {
    setText(t);
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) onChange(n);
  };

  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[font.label, { marginBottom: space.xs }]}>{label.toUpperCase()}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable style={s.stepper} onPress={() => onChange(Number((value - step).toFixed(6)))}>
          <Text style={s.stepperText}>−</Text>
        </Pressable>
        <TextInput
          style={[s.input, { flex: 1, textAlign: 'center' }]}
          value={text}
          onChangeText={commit}
          keyboardType="decimal-pad"
          placeholderTextColor={colors.muted}
        />
        <Pressable style={s.stepper} onPress={() => onChange(Number((value + step).toFixed(6)))}>
          <Text style={s.stepperText}>+</Text>
        </Pressable>
      </View>
      {hint ? <Text style={[font.small, { marginTop: space.xs }]}>{hint}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <View style={{ marginBottom: space.md }}>
      {label ? <Text style={[font.label, { marginBottom: space.xs }]}>{label.toUpperCase()}</Text> : null}
      <View style={s.segmented}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              style={[s.segment, active && s.segmentActive]}
            >
              <Text style={[s.segmentText, active && { color: colors.text, fontWeight: '600' }]}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
  tone = 'neutral',
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  tone?: 'neutral' | 'good' | 'critical' | 'warning' | 'accent';
}) {
  const toneColor =
    tone === 'good' ? colors.good
    : tone === 'critical' ? colors.criticalText
    : tone === 'warning' ? colors.warning
    : tone === 'accent' ? colors.accent
    : colors.borderStrong;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.chip,
        { borderColor: active ? toneColor : colors.border, backgroundColor: active ? `${toneColor}22` : 'transparent' },
        pressed && onPress ? { opacity: 0.7 } : null,
      ]}
    >
      <Text style={[s.chipText, active && { color: tone === 'neutral' ? colors.text : toneColor }]}>{label}</Text>
    </Pressable>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A small trailing detail — a count, a code, etc. — shown muted at the row's end. */
  hint?: string;
}

/**
 * A labeled dropdown: a compact trigger (label above, current value + caret
 * below — the same shape as `Field`) that opens a bottom sheet listing every
 * option as a full-width row with a radio mark and optional hint. Use this
 * instead of a chip row once there are more than a handful of choices, or the
 * choices are long/cryptic (a dozen bot names) — a wall of wrapping chips is
 * hard to scan, one dropdown that shows what's picked is not.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  emphasizeChange = true,
  compact = false,
}: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  /** Highlight the trigger (accent border/text) when the value isn't the first option. Off for pure ordering controls like "Sort". */
  emphasizeChange?: boolean;
  /**
   * A single 32px pill (micro-label + value inline) instead of the two-line
   * label-above / control-below form. For a dense toolbar where several of
   * these sit in a row and vertical space is the scarce resource — e.g. a
   * filter strip pinned above a long list.
   */
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  const changed = emphasizeChange && options.length > 0 && value !== options[0].value;
  const a11yLabel = `${label}: ${current?.label ?? placeholder}. Opens a list to choose.`;

  return (
    <View style={compact ? undefined : { marginBottom: space.md }}>
      {compact ? (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          style={({ pressed }) => [s.selectCompact, changed && s.selectCompactActive, pressed && { opacity: 0.8 }]}
        >
          <Text style={s.selectCompactLabel} numberOfLines={1}>
            {label.toUpperCase()}
          </Text>
          <Text style={[s.selectCompactValue, changed && { color: colors.accent, fontWeight: '700' }]} numberOfLines={1}>
            {current?.label ?? placeholder}
          </Text>
          <Text style={s.selectCaret}>⌄</Text>
        </Pressable>
      ) : (
        <>
          <Text style={[font.label, { marginBottom: space.xs }]}>{label.toUpperCase()}</Text>
          <Pressable
            onPress={() => setOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={a11yLabel}
            style={({ pressed }) => [s.selectTrigger, changed && s.selectTriggerActive, pressed && { opacity: 0.8 }]}
          >
            <Text style={[s.selectValue, !current && s.selectPlaceholder, changed && { color: colors.accent, fontWeight: '600' }]} numberOfLines={1}>
              {current?.label ?? placeholder}
            </Text>
            <Text style={s.selectCaret}>⌄</Text>
          </Pressable>
        </>
      )}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={o.label}
              style={({ pressed }) => [s.selectOption, pressed && { backgroundColor: colors.surfaceHover }]}
            >
              <View style={[s.selectRadio, active && s.selectRadioActive]}>{active ? <View style={s.selectRadioDot} /> : null}</View>
              <Text style={[s.selectOptionLabel, active && { color: colors.accent, fontWeight: '600' }]} numberOfLines={1}>
                {o.label}
              </Text>
              {o.hint ? (
                <Text style={s.selectOptionHint} numberOfLines={1}>
                  {o.hint}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </Sheet>
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'critical' | 'warning' | 'accent' }) {
  const c =
    tone === 'good' ? colors.good
    : tone === 'critical' ? colors.criticalText
    : tone === 'warning' ? colors.warning
    : tone === 'accent' ? colors.accent
    : colors.muted;
  return (
    <View style={[s.badge, { borderColor: `${c}66`, backgroundColor: `${c}1F` }]}>
      <Text style={[s.badgeText, { color: c }]}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------

export function Stat({
  label,
  value,
  sub,
  valueColor,
  width,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
  width?: number | string;
}) {
  return (
    <View style={[s.stat, width ? { width: width as any } : { flex: 1 }]}>
      <Text style={font.label}>{label.toUpperCase()}</Text>
      <Text style={[s.statValue, valueColor ? { color: valueColor } : null]} numberOfLines={1}>
        {value}
      </Text>
      {sub ? <Text style={font.small} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

export function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={s.row}>
      <Text style={[font.body, { flex: 1 }]}>{label}</Text>
      <Text style={[s.rowValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------

export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  // A bottom sheet sits right where Android's gesture bar lives, so its footer
  // buttons need that inset or they become unpressable.
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={s.sheetBackdrop}>
        <View style={[s.sheet, { paddingBottom: space.lg + insets.bottom }]}>
          <View style={s.sheetHeader}>
            <Text style={font.h2}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={16} style={s.sheetClose}>
              <Text style={{ color: colors.muted, fontSize: 22, lineHeight: 24 }}>×</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? <View style={s.sheetFooter}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <View style={s.empty}>
      <Text style={[font.h3, { marginBottom: space.sm, textAlign: 'center' }]}>{title}</Text>
      <Text style={[font.body, { textAlign: 'center', marginBottom: space.lg }]}>{body}</Text>
      {action}
    </View>
  );
}

export function Banner({ tone, children }: { tone: 'warning' | 'critical' | 'accent' | 'good'; children: React.ReactNode }) {
  const c =
    tone === 'critical' ? colors.critical
    : tone === 'warning' ? colors.warning
    : tone === 'good' ? colors.good
    : colors.accent;
  const icon = tone === 'critical' ? '✕' : tone === 'warning' ? '!' : tone === 'good' ? '✓' : 'i';
  return (
    <View style={[s.banner, { borderColor: `${c}55`, backgroundColor: `${c}14` }]}>
      <View style={[s.bannerIcon, { backgroundColor: c }]}>
        <Text style={{ color: '#0D1117', fontSize: 11, fontWeight: '800' }}>{icon}</Text>
      </View>
      <Text style={[font.body, { flex: 1, color: colors.textSecondary }]}>{children}</Text>
    </View>
  );
}

/**
 * Collapsible plain-English help.
 *
 * Trading tools tend to assume you already know what "profit factor" or
 * "ATR multiple" means. Rather than a separate manual nobody opens, the
 * explanation lives next to the thing it explains — collapsed by default so it
 * doesn't clutter the screen for someone who already knows.
 */
export function Explain({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View style={s.explain}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={8} style={s.explainHeader}>
        <View style={s.explainIcon}>
          <Text style={{ color: colors.accent, fontSize: 11, fontWeight: '800' }}>?</Text>
        </View>
        <Text style={s.explainTitle}>{title}</Text>
        <Text style={{ color: colors.muted, fontSize: 12 }}>{open ? 'hide' : 'explain'}</Text>
      </Pressable>
      {open ? <Text style={s.explainBody}>{children}</Text> : null}
    </View>
  );
}

/** A metric with its plain-English meaning one tap away. */
export function ExplainedStat({
  label,
  value,
  sub,
  valueColor,
  help,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
  help: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <View style={{ flex: 1 }}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={font.label}>{label.toUpperCase()}</Text>
          <Text style={{ color: colors.accent, fontSize: 10, fontWeight: '800' }}>?</Text>
        </View>
        <Text style={[s.statValue, valueColor ? { color: valueColor } : null]} numberOfLines={1}>
          {value}
        </Text>
        {sub ? <Text style={font.small} numberOfLines={1}>{sub}</Text> : null}
      </Pressable>
      {open ? <Text style={[s.explainBody, { marginTop: space.xs }]}>{help}</Text> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={{ padding: space.xl, alignItems: 'center', gap: space.md }}>
      <ActivityIndicator color={colors.accent} />
      {label ? <Text style={font.small}>{label}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
    marginTop: space.lg,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: space.md },
  btn: {
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  btnSmall: { height: 32, paddingHorizontal: space.md, borderRadius: radius.sm },
  btnText: { fontSize: 14, fontWeight: '600' },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space.md,
    height: 44,
    fontSize: 15,
  },
  stepper: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: { color: colors.text, fontSize: 20, lineHeight: 22 },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
  },
  segment: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.surfaceAlt },
  segmentText: { color: colors.muted, fontSize: 13 },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: { color: colors.textSecondary, fontSize: 13 },
  selectTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: space.md,
  },
  selectTriggerActive: { borderColor: colors.accent, backgroundColor: `${colors.accent}14` },
  selectValue: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '500' },
  selectPlaceholder: { color: colors.muted, fontWeight: '400' },
  selectCaret: { color: colors.muted, fontSize: 11 },
  selectCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: space.sm,
  },
  selectCompactActive: { borderColor: colors.accent, backgroundColor: `${colors.accent}14` },
  selectCompactLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  selectCompactValue: { color: colors.text, fontSize: 12, fontWeight: '600', maxWidth: 140 },
  selectOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  selectRadio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectRadioActive: { borderColor: colors.accent },
  selectRadioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
  selectOptionLabel: { flex: 1, fontSize: 15, color: colors.text },
  selectOptionHint: { fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'] },
  badge: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  stat: { gap: 3 },
  statValue: { fontSize: 19, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
  },
  rowValue: { fontSize: 14, color: colors.text, fontVariant: ['tabular-nums'], fontWeight: '500' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    // A bottom sheet with no height of its own is sized purely by its
    // content -- fine on native (Yoga resolves the ScrollView's percentage
    // height against it regardless), but on the web build this is real CSS,
    // and a percentage height on a child of an auto-height parent is
    // "indefinite" per spec and gets ignored. The ScrollView then grew
    // without any cap, the sheet could end up taller than the viewport, and
    // the modal's focus trap would scroll the page down to the footer --
    // showing the Close button with everything above (header, stats, the
    // list itself) scrolled out of view. maxHeight here plus flex:1 on the
    // ScrollView (see Sheet, below) is the CSS-quirk-proof version of the
    // same layout, and behaves identically on native.
    maxHeight: '90%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  sheetClose: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  sheetFooter: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  empty: { padding: space.xl, alignItems: 'center' },
  explain: {
    marginTop: space.sm,
    marginBottom: space.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  explainHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 },
  explainIcon: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  explainTitle: { flex: 1, color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  explainBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: space.sm },
  banner: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'flex-start',
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: space.md,
  },
  bannerIcon: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.md,
    marginBottom: space.lg,
  },
  pageHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  backBtn: { paddingVertical: space.sm, paddingRight: space.sm, minHeight: 40, justifyContent: 'center' },
  pill: {
    flexDirection: 'row',
    flexShrink: 0,
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3, flexShrink: 0 },
  tile: {
    flexBasis: 0,
    gap: 4,
    padding: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tileLabel: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  tileValue: { fontSize: 22, fontWeight: '700', color: colors.text },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginBottom: space.lg },
  table: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    paddingVertical: 10,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  tableHeadText: { fontSize: 11, fontWeight: '600', color: colors.muted, letterSpacing: 0.5, textTransform: 'uppercase' },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    minHeight: 52,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  tableCell: { fontSize: 14, color: colors.text },
});

// ---------------------------------------------------------------------------
// Layout & data-display patterns (desktop + phone)
// ---------------------------------------------------------------------------

/**
 * The scrolling page every tab renders into: responsive gutter, content capped
 * at layout.maxContent and centred on wide screens so tables never stretch to
 * unreadable line lengths.
 */
export function Page({
  children,
  refreshControl,
  contentStyle,
}: {
  children: React.ReactNode;
  refreshControl?: React.ReactElement<any>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { gutter } = useLayout();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: gutter, paddingBottom: space.xxl * 2 }}
      refreshControl={refreshControl}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[{ width: '100%', maxWidth: layout.maxContent, alignSelf: 'center' }, contentStyle]}>{children}</View>
    </ScrollView>
  );
}

/** Title row for a page: title + optional subtitle, back link and right-aligned actions. */
export function PageHeader({
  title,
  subtitle,
  right,
  onBack,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  onBack?: () => void;
}) {
  return (
    <View style={s.pageHeader}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={s.backBtn}>
          <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>‹ Back</Text>
        </Pressable>
      ) : null}
      <View style={{ flex: 1, minWidth: 180 }}>
        <Text style={font.h1} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (typeof subtitle === 'string' ? <Text style={[font.small, { marginTop: 2 }]}>{subtitle}</Text> : subtitle) : null}
      </View>
      {right ? <View style={s.pageHeaderRight}>{right}</View> : null}
    </View>
  );
}

const STATUS_STYLE: Record<string, { color: string; label: string; glyph: string }> = {
  running: { color: colors.good, label: 'Running', glyph: '●' },
  starting: { color: colors.warning, label: 'Starting', glyph: '◐' },
  error: { color: colors.criticalText, label: 'Error', glyph: '✕' },
  stopped: { color: colors.muted, label: 'Stopped', glyph: '○' },
  blocked: { color: colors.warning, label: 'Paused', glyph: '❚❚' },
  // Market states
  open: { color: colors.good, label: 'Open', glyph: '●' },
  closed: { color: colors.muted, label: 'Closed', glyph: '◌' },
  unavailable: { color: colors.criticalText, label: 'Not offered', glyph: '✕' },
  close_only: { color: colors.warning, label: 'Close only', glyph: '!' },
  unknown: { color: colors.muted, label: 'Checking', glyph: '…' },
};

/** The market pill state for a symbol's status (see MarketStatus on the server). */
export function marketState(m: { available: boolean; tradeMode: string | null; open: boolean | null } | undefined): string {
  if (!m) return 'unknown';
  if (!m.available || m.tradeMode === 'disabled') return 'unavailable';
  if (m.tradeMode === 'close_only') return 'close_only';
  if (m.open === false) return 'closed';
  if (m.open === true) return 'open';
  return 'unknown';
}

/** A market that can never trade on this account (not listed, disabled or close-only). */
export function marketBlocked(m: { available: boolean; tradeMode: string | null } | undefined): boolean {
  return !!m && (!m.available || m.tradeMode === 'disabled' || m.tradeMode === 'close_only');
}

/** Bot/connection state: glyph + label + colour, so it never relies on colour alone. */
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const st = STATUS_STYLE[status] ?? STATUS_STYLE.stopped;
  return (
    <View style={[s.pill, { borderColor: `${st.color}55`, backgroundColor: `${st.color}14` }]} accessibilityLabel={`Status: ${label ?? st.label}`}>
      <Text style={{ color: st.color, fontSize: 9 }}>{st.glyph}</Text>
      <Text style={[s.pillText, { color: st.color }]} numberOfLines={1}>
        {label ?? st.label}
      </Text>
    </View>
  );
}

/** A signed money value: sign glyph + sign + colour (never colour alone). */
export function Pnl({ value, size = 14, weight = '600', showGlyph = true, muted = false }: { value: number; size?: number; weight?: TextStyle['fontWeight']; showGlyph?: boolean; muted?: boolean }) {
  const c = muted && value === 0 ? colors.muted : pnlColor(value);
  return (
    <Text style={{ color: c, fontSize: size, fontWeight: weight, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
      {showGlyph && value !== 0 ? `${signGlyph(value)} ` : ''}
      {money(value)}
    </Text>
  );
}

/**
 * Stat tile (the figure contract): label · value · optional signed delta vs a
 * named period · optional sub-line. Proportional figures at display size.
 */
export function StatTile({
  label,
  value,
  valueColor,
  delta,
  deltaLabel,
  sub,
  hero,
  minWidth = 150,
}: {
  label: string;
  value: string;
  valueColor?: string;
  delta?: number | null;
  deltaLabel?: string;
  sub?: string;
  hero?: boolean;
  minWidth?: number;
}) {
  return (
    <View style={[s.tile, { minWidth, flexGrow: hero ? 2 : 1 }]}>
      <Text style={s.tileLabel}>{label}</Text>
      <Text style={[hero ? font.hero : s.tileValue, valueColor ? { color: valueColor } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {delta != null ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <Pnl value={delta} size={13} />
          {deltaLabel ? <Text style={font.small}>{deltaLabel}</Text> : null}
        </View>
      ) : null}
      {sub ? (
        <Text style={font.small} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/** A responsive row of stat tiles: wraps on phones, one line on desktop. */
export function KpiRow({ children }: { children: React.ReactNode }) {
  return <View style={s.kpiRow}>{children}</View>;
}

export interface Column<T> {
  key: string;
  title: string;
  /** Flex share (default 1). Use `width` for fixed columns such as actions. */
  flex?: number;
  width?: number;
  align?: 'left' | 'right' | 'center';
  /** True when the cell holds its own buttons. They then sit above the row's click area instead of inside it. */
  interactive?: boolean;
  render: (row: T) => React.ReactNode;
}

/**
 * Dense data table for desktop: sticky-looking header, hairline rows, hover
 * highlight, optional row press. Numbers should be right-aligned (align: 'right').
 */
export function DataTable<T>({
  columns,
  rows,
  keyOf,
  onRowPress,
  empty,
  rowLabel,
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  onRowPress?: (row: T) => void;
  empty?: React.ReactNode;
  rowLabel?: (row: T) => string;
}) {
  const cell = (c: Column<T>): ViewStyle => ({
    flex: c.width ? undefined : c.flex ?? 1,
    width: c.width,
    alignItems: c.align === 'right' ? 'flex-end' : c.align === 'center' ? 'center' : 'stretch',
    paddingHorizontal: space.sm,
    // Let long text ellipsize inside its column instead of spilling into the next one.
    minWidth: 0,
    overflow: 'hidden',
  });
  return (
    <View style={s.table} accessibilityRole={'table' as any}>
      <View style={s.tableHead}>
        {columns.map((c) => (
          <View key={c.key} style={cell(c)}>
            <Text style={s.tableHeadText} numberOfLines={1}>
              {c.title}
            </Text>
          </View>
        ))}
      </View>
      {rows.length === 0 ? (
        <View style={{ padding: space.lg }}>{empty ?? <Text style={font.body}>Nothing to show.</Text>}</View>
      ) : (
        rows.map((r, i) => (
          // The row's click area is its own layer *behind* the cells. Buttons inside a cell are siblings of that
          // layer, never children of it, so a button is never nested inside another button (invalid HTML on the web).
          <View key={keyOf(r)} style={[s.tableRow, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
            {onRowPress ? (
              <Pressable
                onPress={() => onRowPress(r)}
                accessibilityRole="button"
                accessibilityLabel={rowLabel ? rowLabel(r) : undefined}
                style={(state) => [StyleSheet.absoluteFill, (state as { hovered?: boolean }).hovered ? { backgroundColor: colors.surfaceHover } : null]}
              />
            ) : null}
            {columns.map((c) => (
              // Plain cells let clicks fall through to the row; cells with buttons keep their own.
              <View key={c.key} style={[cell(c), { pointerEvents: onRowPress && !c.interactive ? 'none' : 'auto' }]}>
                {(() => {
                  const v = c.render(r);
                  return typeof v === 'string' || typeof v === 'number' ? (
                    <Text style={[s.tableCell, c.align === 'right' && { fontVariant: ['tabular-nums'] }]} numberOfLines={1}>
                      {v}
                    </Text>
                  ) : (
                    v
                  );
                })()}
              </View>
            ))}
          </View>
        ))
      )}
    </View>
  );
}

