import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Text, View } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { colors, font, radius, space } from '../theme';

/**
 * Price with a strategy's price-scale indicators on top — the same lines the
 * XATLevels EA draws on the MT5 chart, in the same colours, so the app preview
 * and the terminal read alike.
 *
 * Marks: price is the de-emphasis ink (1.5px), each indicator its fixed
 * categorical slot (2px); one y-axis; recessive hairline grid; legend always
 * present with the latest value next to each swatch (direct labels, text in
 * ink tokens, never the series colour). Drag / hover shows a crosshair with
 * every value at that bar.
 */
export interface OverlayChartSeries {
  id: string;
  label: string;
  color: string;
  points: (number | null)[];
}

const PAD = { top: 12, right: 12, bottom: 22, left: 64 };

export function OverlayChart({
  times,
  closes,
  series,
  digits = 2,
  height = 260,
}: {
  times: number[];
  closes: number[];
  series: OverlayChartSeries[];
  digits?: number;
  height?: number;
}) {
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const geo = useRef({ w: 0, n: 0 });
  geo.current = { w: width, n: closes.length };

  const model = useMemo(() => {
    const n = closes.length;
    if (n < 2 || width === 0) return null;
    const all = [...closes, ...series.flatMap((s) => s.points.filter((v): v is number => v != null))];
    let min = Math.min(...all);
    let max = Math.max(...all);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.06;
    min -= pad;
    max += pad;
    const pw = Math.max(width - PAD.left - PAD.right, 1);
    const ph = Math.max(height - PAD.top - PAD.bottom, 1);
    const x = (k: number) => PAD.left + (k / (n - 1)) * pw;
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * ph;
    const path = (vals: (number | null)[]) => {
      let d = '';
      let pen = false;
      vals.forEach((v, k) => {
        if (v == null) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const ticks = [0, 0.5, 1].map((f) => min + (max - min) * (0.06 / 1.12 + f * (1 - 0.12 / 1.12)));
    return { x, y, pw, ph, price: path(closes), lines: series.map((s) => ({ ...s, d: path(s.points) })), ticks };
  }, [closes, series, width, height]);

  const pickIndex = (px: number) => {
    const { w, n } = geo.current;
    const pw = Math.max(w - PAD.left - PAD.right, 1);
    return Math.max(0, Math.min(n - 1, Math.round(((px - PAD.left) / pw) * (n - 1))));
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => setCursor(pickIndex(e.nativeEvent.locationX)),
        onPanResponderMove: (e) => setCursor(pickIndex(e.nativeEvent.locationX)),
        onPanResponderRelease: () => setCursor(null),
        onPanResponderTerminate: () => setCursor(null),
      }),
    [],
  );

  // Hover (web): same crosshair as drag.
  const webHover =
    Platform.OS === 'web'
      ? ({
          onMouseMove: (e: { nativeEvent: { offsetX: number } }) => setCursor(pickIndex(e.nativeEvent.offsetX)),
          onMouseLeave: () => setCursor(null),
        } as object)
      : {};

  const idx = cursor ?? closes.length - 1;
  const when = times[idx] ? new Date(times[idx]).toISOString().slice(5, 16).replace('T', ' ') : '';
  const fmt = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(digits));

  return (
    <View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height, backgroundColor: colors.bg, borderRadius: radius.md, overflow: 'hidden' }}
        accessibilityLabel={`Price chart with ${series.length} indicator line${series.length === 1 ? '' : 's'}`}
        {...responder.panHandlers}
        {...webHover}
      >
        {model ? (
          <Svg width={width} height={height}>
            {model.ticks.map((v, k) => (
              <React.Fragment key={k}>
                <Line x1={PAD.left} x2={width - PAD.right} y1={model.y(v)} y2={model.y(v)} stroke={colors.grid} strokeWidth={1} />
                <SvgText x={PAD.left - 8} y={model.y(v) + 4} fill={colors.muted} fontSize={11} textAnchor="end">
                  {v.toFixed(digits)}
                </SvgText>
              </React.Fragment>
            ))}
            <Path d={model.price} stroke={colors.muted} strokeWidth={1.5} fill="none" />
            {model.lines.map((l) => (
              <Path key={l.id} d={l.d} stroke={l.color} strokeWidth={2} fill="none" strokeLinejoin="round" />
            ))}
            {cursor != null ? (
              <>
                <Line x1={model.x(cursor)} x2={model.x(cursor)} y1={PAD.top} y2={height - PAD.bottom} stroke={colors.borderStrong} strokeWidth={1} />
                <Rect x={model.x(cursor) - 4} y={model.y(closes[cursor]) - 4} width={8} height={8} rx={4} fill={colors.text} stroke={colors.bg} strokeWidth={2} />
              </>
            ) : null}
            <SvgText x={PAD.left} y={height - 6} fill={colors.muted} fontSize={11}>
              {times[0] ? new Date(times[0]).toISOString().slice(11, 16) : ''}
            </SvgText>
            <SvgText x={width - PAD.right} y={height - 6} fill={colors.muted} fontSize={11} textAnchor="end">
              {times[times.length - 1] ? new Date(times[times.length - 1]).toISOString().slice(11, 16) : ''} (broker time)
            </SvgText>
          </Svg>
        ) : null}
      </View>

      {/* Legend — always present; values track the crosshair (latest bar otherwise). */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.sm, alignItems: 'center' }}>
        <Text style={font.small}>{cursor != null ? when : 'Latest bar'}</Text>
        <LegendItem color={colors.muted} label="Price" value={fmt(closes[idx])} />
        {series.map((s) => (
          <LegendItem key={s.id} color={s.color} label={s.label} value={fmt(s.points[idx])} />
        ))}
      </View>
    </View>
  );
}

function LegendItem({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}
