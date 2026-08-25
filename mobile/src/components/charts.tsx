import { useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import {
  ACTIVITY_FAMILIES,
  compact,
  exact,
  millis,
  type ActivityPoint,
  type SourceType,
} from '@atlas/shared';
import { colors, fonts, tint } from '../theme';

/**
 * Chart primitives, hand-rolled from views and SVG — no charting library, for
 * the same reason the web has none: Atlas binds each hue to a data meaning,
 * and hand-rolled marks *are* the design system. Every chart must read
 * correctly at three sizes of nothing: no data at all, a single point, and one
 * non-zero value among many zeroes.
 */

/** A zero-height rule, so an empty bucket is visibly empty rather than missing. */
export function EmptyRule() {
  return <View style={{ height: 1, alignSelf: 'stretch', backgroundColor: colors.line }} />;
}

/** The status dot used across services, fleet cards and health rows. */
export function SyncDot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Swatch({ color, children }: { color: string; children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>{children}</Text>
    </View>
  );
}

/** Daily stacked activity bars (Dashboard): entries indexed per day, by family. */
export function ActivityChart({ activity }: { activity: ActivityPoint[] }) {
  const days = useMemo(() => {
    const out: string[] = [];
    for (let i = 29; i >= 0; i--) {
      out.push(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
    }
    return out;
  }, []);

  const perDay = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const p of activity) {
      const fam = ACTIVITY_FAMILIES.find((f) => f.types.includes(p.sourceType as SourceType))?.key ?? 'doc';
      const day = m.get(p.day) ?? new Map<string, number>();
      day.set(fam, (day.get(fam) ?? 0) + p.count);
      m.set(p.day, day);
    }
    return m;
  }, [activity]);

  const totals = days.map((d) => [...(perDay.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  const anything = new Set(activity.map((p) => p.day)).size > 0;

  if (!anything) {
    return (
      <Text style={{ color: colors.faint, fontSize: 12.5, paddingVertical: 16 }}>
        No indexing activity in the last 30 days.
      </Text>
    );
  }

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 96 }}>
        {days.map((day, i) => {
          const m = perDay.get(day);
          const total = totals[i]!;
          return (
            <View key={day} style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}>
              {total === 0 ? (
                EmptyRule()
              ) : (
                ACTIVITY_FAMILIES.filter((f) => m!.has(f.key)).map((f) => (
                  <View
                    key={f.key}
                    style={{
                      backgroundColor: f.color,
                      marginTop: 1,
                      borderTopLeftRadius: 1.5,
                      borderTopRightRadius: 1.5,
                      height: `${Math.max(((m!.get(f.key) ?? 0) / max) * 100, 2)}%` as `${number}%`,
                    }}
                  />
                ))
              )}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        <Text style={caption}>{days[0]}</Text>
        <Text style={caption}>max {exact(max)}/day</Text>
        <Text style={caption}>{days[days.length - 1]}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
        {ACTIVITY_FAMILIES.map((f) => (
          <Swatch key={f.key} color={f.color}>
            {f.label}
          </Swatch>
        ))}
      </View>
    </View>
  );
}

const caption = { fontFamily: fonts.mono, fontSize: 10, color: colors.faint } as const;

/* -------------------------------------------------------------------------
 * Monitor charts
 * ---------------------------------------------------------------------- */

export interface StackedDay {
  /** ISO date, YYYY-MM-DD. */
  day: string;
  /** Calls per client on that day. */
  byClient: Record<string, number>;
}

/** Daily stacked bars with a continuous axis — idle days show as gaps. */
export function Bars({
  days,
  clientColor,
  height = 112,
}: {
  days: StackedDay[];
  clientColor: (c: string) => string;
  height?: number;
}) {
  const totals = days.map((d) => Object.values(d.byClient).reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  const anything = totals.some((t) => t > 0);

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height }}>
        {days.map((d, i) => {
          const total = totals[i]!;
          const clients = Object.entries(d.byClient).filter(([, n]) => n > 0);
          return (
            <View key={d.day} style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}>
              {total === 0 ? (
                EmptyRule()
              ) : (
                clients.map(([client, n]) => (
                  <View
                    key={client}
                    style={{
                      backgroundColor: clientColor(client),
                      marginTop: 1,
                      height: `${Math.max((n / max) * 100, 2)}%` as `${number}%`,
                      borderTopLeftRadius: 1.5,
                      borderTopRightRadius: 1.5,
                    }}
                  />
                ))
              )}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        <Text style={caption}>{days[0]?.day ?? ''}</Text>
        <Text style={caption}>{anything ? `peak ${exact(max)}/day` : 'no calls'}</Text>
        <Text style={caption}>{days[days.length - 1]?.day ?? ''}</Text>
      </View>
    </View>
  );
}

/** Inline trend for one row — axis-less shape only; numbers sit beside it. */
export function Sparkline({
  values,
  color = colors.kdb,
}: {
  values: number[];
  color?: string;
}) {
  const w = 64;
  const h = 18;
  if (values.length === 0) {
    return <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>—</Text>;
  }
  const max = Math.max(...values, 1);
  if (values.length === 1) {
    return (
      <Svg width={w} height={h}>
        <Circle cx={w / 2} cy={h - (values[0]! / max) * (h - 2) - 1} r={2} fill={color} />
      </Svg>
    );
  }
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${i * step},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <Svg width={w} height={h}>
      <Polyline points={pts} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

/** Calls by hour of day, 24 cells. Opacity encodes one quantity — not hue. */
export function HourStrip({ byHour }: { byHour: { hour: number; calls: number }[] }) {
  const counts = Array.from({ length: 24 }, (_, h) => byHour.find((b) => b.hour === h)?.calls ?? 0);
  const max = Math.max(...counts, 1);
  const total = counts.reduce((a, b) => a + b, 0);

  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 1 }}>
        {counts.map((n, hour) => (
          <View
            key={hour}
            style={{
              flex: 1,
              height: 26,
              borderRadius: 3,
              backgroundColor:
                n === 0 ? colors.line : tint(colors.kdb, Math.max(12, (n / max) * 100)),
              opacity: n === 0 ? 0.55 : 1,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        <Text style={caption}>00h</Text>
        <Text style={caption}>{total > 0 ? `busiest ${exact(max)}/h · UTC` : 'no calls'}</Text>
        <Text style={caption}>23h</Text>
      </View>
    </View>
  );
}

/** A headline number tile (web StatTile). */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: string;
}) {
  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.panel,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flex: 1,
        minWidth: '45%' as unknown as number,
      }}
    >
      <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 1.2, color: colors.faint }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.display, fontSize: 22, fontWeight: '600', color: tone ?? colors.ink, marginTop: 2 }}>
        {value}
      </Text>
      {hint ? <Text style={{ fontSize: 11, color: colors.muted, marginTop: 1 }}>{hint}</Text> : null}
    </View>
  );
}

/** Latency shown as median with the tail beside it — the mean alone hides both. */
export function LatencyPair({ p50, p95 }: { p50: number; p95: number }) {
  return (
    <Text style={{ fontFamily: fonts.mono, fontSize: 11 }}>
      <Text>{millis(p50)}</Text>
      <Text style={{ color: colors.faint }}> / {millis(p95)}</Text>
    </Text>
  );
}

/** Horizontal share bar for a categorical breakdown (route classes). */
export function ShareBar({ parts }: { parts: { key: string; calls: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.calls, 0);
  if (total === 0) return <EmptyRule />;
  return (
    <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' }}>
      {parts
        .filter((p) => p.calls > 0)
        .map((p) => (
          <View key={p.key} style={{ width: `${(p.calls / total) * 100}%`, backgroundColor: p.color }} />
        ))}
    </View>
  );
}

/** Ranked horizontal bars — "which things, in what proportion", words for labels. */
export function BarList({
  items,
  max,
  emptyLabel = 'nothing recorded',
}: {
  items: { key: string; calls: number; color?: string }[];
  max?: number;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <Text style={{ fontSize: 12, color: colors.faint }}>{emptyLabel}</Text>;
  }
  const top = max ?? Math.max(...items.map((i) => i.calls), 1);
  return (
    <View style={{ gap: 4 }}>
      {items.map((i) => (
        <View key={i.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, width: 110 }}>
            {i.key}
          </Text>
          <View style={{ flex: 1, height: 11, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.line }}>
            <View
              style={{
                height: '100%',
                minWidth: 2,
                maxWidth: '100%',
                width: `${(i.calls / top) * 100}%`,
                backgroundColor: i.color ?? colors.kdb,
                borderRadius: 3,
              }}
            />
          </View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, width: 44, textAlign: 'right' }}>
            {compact(i.calls)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Latency distribution over fixed log-ish buckets — equal-width buckets would
 * put everything in the first one and report a flat line.
 */
export function Histogram({ buckets }: { buckets: { bucket: string; calls: number }[] }) {
  const max = Math.max(...buckets.map((b) => b.calls), 1);
  const total = buckets.reduce((a, b) => a + b.calls, 0);
  if (total === 0) {
    return <Text style={{ fontSize: 12, color: colors.faint }}>no calls in this window</Text>;
  }
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 92 }}>
        {buckets.map((b) => (
          <View key={b.bucket} style={{ flex: 1, justifyContent: 'flex-end', height: '100%' }}>
            <View
              style={{
                height:
                  b.calls === 0
                    ? 1
                    : (`${Math.max((b.calls / max) * 100, 3)}%` as `${number}%`),
                backgroundColor: b.calls === 0 ? colors.line : colors.kdb,
                borderTopLeftRadius: 2,
                borderTopRightRadius: 2,
              }}
            />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 3, marginTop: 4 }}>
        {buckets.map((b) => (
          <Text key={b.bucket} numberOfLines={1} style={{ flex: 1, textAlign: 'center', fontFamily: fonts.mono, fontSize: 8.5, color: colors.faint }}>
            {b.bucket}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** A single proportion, stated as a number with the bar underneath. */
export function Rate({
  label,
  value,
  of,
  hint,
  tone,
}: {
  label: string;
  value: number;
  of: number;
  hint?: string;
  tone?: string;
}) {
  const pct = of > 0 ? value / of : 0;
  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.panel,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flex: 1,
        minWidth: '45%' as unknown as number,
      }}
    >
      <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 1.2, color: colors.faint }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
        <Text style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: '600', color: tone ?? colors.ink }}>
          {of > 0 ? `${Math.round(pct * 100)}%` : '—'}
        </Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
          {exact(value)}/{exact(of)}
        </Text>
      </View>
      <View style={{ height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: colors.line, marginTop: 6 }}>
        <View style={{ height: '100%', width: `${pct * 100}%`, backgroundColor: tone ?? colors.kdb }} />
      </View>
      {hint ? <Text style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>{hint}</Text> : null}
    </View>
  );
}
