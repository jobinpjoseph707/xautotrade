/**
 * Design tokens.
 *
 * Chart colours come from the validated reference palette. The status pair
 * (good / critical) is used for P&L, and green-vs-red is never the only signal:
 * every P&L figure ships with an explicit sign and an arrow glyph, and the
 * equity chart only ever shows one of the two colours at a time. That is the
 * documented mitigation for the red/green CVD collision.
 */

export const colors = {
  // Surfaces — neutral near-black planes from the reference chart chrome
  // (page plane → card surface → raised/hover), separated by hairlines, no shadows.
  bg: '#111110',
  surface: '#1A1A19',
  surfaceAlt: '#222221',
  surfaceHover: '#2A2A28',
  border: '#2C2C2A',
  borderStrong: '#383835',

  // Ink
  text: '#FFFFFF',
  textSecondary: '#C3C2B7',
  muted: '#9C9A93', // 6.2:1 on surface — small text stays AA

  // Status (fixed palette — never themed, never reused as a series colour;
  // always shipped with an icon/sign + label, never colour alone)
  good: '#0CA30C',
  goodDim: 'rgba(12,163,12,0.16)',
  critical: '#D03B3B',
  criticalDim: 'rgba(208,59,59,0.16)',
  /** Negative numbers/labels as TEXT: the fill red is only 3.6:1 on dark, this is 5.9:1. */
  criticalText: '#EB7070',
  /** Solid button fills that carry white text at ≥ 4.5:1. */
  accentStrong: '#256ABF',
  goodStrong: '#0A7F0A',
  criticalStrong: '#B83232',
  warning: '#FAB219',
  warningDim: 'rgba(250,178,25,0.14)',
  serious: '#EC835A',

  // Categorical slot 1 (dark step) — the single accent for neutral/informational marks
  accent: '#3987E5',
  accentDim: 'rgba(57,135,229,0.16)',

  // Chart chrome
  grid: '#2C2C2A',
  axis: '#383835',
} as const;

/** Responsive layout. Wide = desktop web: sidebar shell + tables; narrow = phone: bottom tabs + cards. */
export const layout = {
  wide: 1024,
  medium: 720,
  sidebar: 232,
  sidebarCollapsed: 64,
  maxContent: 1320,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  pill: 999,
} as const;

export const font = {
  /** Exactly one per view: the number the page leads with (system sans, proportional figures). */
  hero: { fontSize: 40, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.5 },
  h1: { fontSize: 24, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.2 },
  h2: { fontSize: 18, fontWeight: '700' as const, color: colors.text },
  h3: { fontSize: 15, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 14, fontWeight: '400' as const, color: colors.textSecondary },
  small: { fontSize: 12, fontWeight: '400' as const, color: colors.muted },
  label: { fontSize: 11, fontWeight: '600' as const, color: colors.muted, letterSpacing: 0.6 },
  mono: { fontSize: 13, fontVariant: ['tabular-nums' as const], color: colors.text },
};

/** Colour for a signed number: status pair, always paired with a sign glyph. */
export function pnlColor(v: number): string {
  if (v > 0) return colors.good;
  if (v < 0) return colors.criticalText;
  return colors.textSecondary;
}

export function signGlyph(v: number): string {
  if (v > 0) return '▲';
  if (v < 0) return '▼';
  return '•';
}

export function money(v: number, currency = ''): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${abs}${currency ? ` ${currency}` : ''}`;
}

export function pct(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}
