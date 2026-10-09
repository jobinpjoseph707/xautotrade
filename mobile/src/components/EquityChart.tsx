import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';

import { colors, font, space } from '../theme';
import { istDate, istDateTime } from '../logic/time';
import type { EquityPoint } from '../types';

/**
 * Equity curve — a single series over time, so there is no legend: the title
 * names it. Colour is the status pair (good / critical) keyed to whether the
 * run finished up or down, and only ever one of the two is on screen at once,
 * so red-green confusion has nothing to confuse. The headline figure carries an
 * explicit sign and arrow, so colour is never the only signal.
 *
 * Marks follow the spec: 2px line, recessive hairline grid, muted axis ink,
 * a single direct label on the last point instead of a number on every point,
 * and a drag-to-scrub crosshair standing in for hover.
 */

interface Props {
  data: EquityPoint[];
  initialBalance: number;
  height?: number;
  title?: string;
  currency?: string;
}

const PAD = { top: 16, right: 12, bottom: 22, left: 46 };

export function EquityChart({ data, initialBalance, height = 190, title, currency = '' }: Props) {
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const widthRef = useRef(0);
  const countRef = useRef(0);
  countRef.current = data.length;

  const model = useMemo(() => {
    if (data.length < 2 || width === 0) return null;

    const values = data.map((d) => d.equity);
    let min = Math.min(...values, initialBalance);
    let max = Math.max(...values, initialBalance);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    // 6% headroom so the line never touches the frame.
    const span = max - min;
    min -= span * 0.06;
    max += span * 0.06;

    const plotW = Math.max(width - PAD.left - PAD.right, 1);
    const plotH = Math.max(height - PAD.top - PAD.bottom, 1);
    const x = (i: number) => PAD.left + (i / (data.length - 1)) * plotW;
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * plotH;

    let line = '';
    for (let i = 0; i < data.length; i++) {
      line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(data[i].equity).toFixed(2)}`;
    }
    const area = `${line}L${x(data.length - 1).toFixed(2)},${(PAD.top + plotH).toFixed(2)}L${x(0).toFixed(2)},${(PAD.top + plotH).toFixed(2)}Z`;

    // Four gridlines, labelled at the extremes and the baseline only.
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = max - f * (max - min);
      return { v, y: PAD.top + f * plotH };
    });

    return { x, y, line, area, min, max, plotW, plotH, ticks };
  }, [data, width, height, initialBalance]);

  const final = data.length ? data[data.length - 1].equity : initialBalance;
  const net = final - initialBalance;
  const up = net >= 0;
  const stroke = up ? colors.good : colors.critical;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => setScrub(indexFor(e.nativeEvent.locationX)),
        onPanResponderMove: (e) => setScrub(indexFor(e.nativeEvent.locationX)),
        onPanResponderRelease: () => setScrub(null),
        onPanResponderTerminate: () => setScrub(null),
      }),
    [],
  );

  function indexFor(locationX: number): number {
    const w = widthRef.current;
    const n = countRef.current;
    if (w === 0 || n < 2) return 0;
    const plotW = Math.max(w - PAD.left - PAD.right, 1);
    const f = (locationX - PAD.left) / plotW;
    return Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  }

  const point = scrub != null && data[scrub] ? data[scrub] : null;

  return (
    <View
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
      }}
    >
      {title ? (
        <View style={st.header}>
          <View style={{ flex: 1 }}>
            <Text style={font.h3}>{title}</Text>
            <Text style={font.small}>
              {data.length ? `${fmtDate(data[0].time)} — ${fmtDate(data[data.length - 1].time)}` : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[st.headline, { color: stroke }]}>
              {up ? '▲' : '▼'} {up ? '+' : '−'}
              {Math.abs(net).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Text>
            <Text style={font.small}>{currency || 'account currency'}</Text>
          </View>
        </View>
      ) : null}

      <View {...pan.panHandlers}>
        {model ? (
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={stroke} stopOpacity="0.28" />
                <Stop offset="1" stopColor={stroke} stopOpacity="0.02" />
              </LinearGradient>
            </Defs>

            {/* Recessive grid */}
            {model.ticks.map((t, i) => (
              <G key={i}>
                <Line
                  x1={PAD.left}
                  y1={t.y}
                  x2={width - PAD.right}
                  y2={t.y}
                  stroke={colors.grid}
                  strokeWidth={1}
                />
                {i === 0 || i === model.ticks.length - 1 ? (
                  <SvgText x={PAD.left - 6} y={t.y + 4} fontSize="10" fill={colors.muted} textAnchor="end">
                    {compact(t.v)}
                  </SvgText>
                ) : null}
              </G>
            ))}

            {/* Starting balance reference — the line that says "break-even" */}
            <Line
              x1={PAD.left}
              y1={model.y(initialBalance)}
              x2={width - PAD.right}
              y2={model.y(initialBalance)}
              stroke={colors.axis}
              strokeWidth={1}
              strokeDasharray="3 4"
            />

            <Path d={model.area} fill="url(#eqFill)" />
            <Path d={model.line} stroke={stroke} strokeWidth={2} fill="none" strokeLinejoin="round" />

            {/* One direct label, on the last point — never a number per point */}
            <Circle
              cx={model.x(data.length - 1)}
              cy={model.y(final)}
              r={4}
              fill={stroke}
              stroke={colors.surface}
              strokeWidth={2}
            />

            {/* Scrub crosshair */}
            {point && scrub != null ? (
              <G>
                <Line
                  x1={model.x(scrub)}
                  y1={PAD.top}
                  x2={model.x(scrub)}
                  y2={PAD.top + model.plotH}
                  stroke={colors.borderStrong}
                  strokeWidth={1}
                />
                <Circle
                  cx={model.x(scrub)}
                  cy={model.y(point.equity)}
                  r={5}
                  fill={stroke}
                  stroke={colors.surface}
                  strokeWidth={2}
                />
              </G>
            ) : null}
          </Svg>
        ) : (
          <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={font.small}>Not enough data to plot.</Text>
          </View>
        )}
      </View>

      {point ? (
        <View style={st.tooltip}>
          <Text style={st.tooltipLabel}>{fmtDateTime(point.time)}</Text>
          <View style={{ flexDirection: 'row', gap: space.lg }}>
            <TooltipStat label="Equity" value={point.equity.toFixed(2)} />
            <TooltipStat label="Balance" value={point.balance.toFixed(2)} />
            <TooltipStat
              label="Drawdown"
              value={`${point.drawdownPct.toFixed(2)}%`}
              color={point.drawdownPct > 0 ? colors.criticalText : colors.textSecondary}
            />
          </View>
        </View>
      ) : (
        <Text style={[font.small, { textAlign: 'center', marginTop: space.xs }]}>
          Drag across the chart to inspect any point
        </Text>
      )}
    </View>
  );
}

function TooltipStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View>
      <Text style={font.label}>{label.toUpperCase()}</Text>
      <Text style={[st.tooltipValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function compact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(0);
}

function fmtDate(ms: number): string {
  return istDate(ms);
}

function fmtDateTime(ms: number): string {
  return istDateTime(ms);
}

const st = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: space.sm,
    gap: space.md,
  },
  headline: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tooltip: {
    marginTop: space.sm,
    padding: space.md,
    backgroundColor: colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tooltipLabel: { fontSize: 11, color: colors.muted, marginBottom: space.xs },
  tooltipValue: { fontSize: 14, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
});
