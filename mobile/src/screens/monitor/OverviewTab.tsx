import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ROUTE_CLASS_META,
  clientColor,
  compact,
  exact,
  millis,
  plural,
  relativeTime,
  type RouteClass,
  type UsageStats,
} from '@atlas/shared';
import { Bars, HourStrip, ShareBar, Sparkline as Spark, StatTile, Swatch } from '../../components/charts';
import { Empty, Eyebrow, Spinner } from '../../components/atoms';
import { api } from '../../api/endpoints';
import { Chip } from './Filters';
import { colors, fonts } from '../../theme';

/**
 * Monitor Overview: who calls Atlas, how much, how fast. Refresh is manual
 * with an opt-in live toggle — every request this page makes is itself logged,
 * so a page that polled would appear in its own charts as the busiest client.
 */
export function OverviewTab({
  days,
  classes,
  onClasses,
  nonce,
}: {
  days: number;
  classes: RouteClass[];
  onClasses: (c: RouteClass[]) => void;
  /** Bumped by the shell's refresh/live controls to refetch. */
  nonce: number;
}) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api
      .usage(days, classes)
      .then((s) => {
        if (live) {
          setStats(s);
          setError('');
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [days, classes, nonce]);

  if (error) return <Empty title="Cannot load usage." hint={error} />;
  if (!stats) return <Spinner label="loading usage" />;

  const errorRate = stats.calls ? stats.errors / stats.calls : 0;

  return (
    <ScrollView scrollEnabled={false} contentContainerStyle={{ gap: 24 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <StatTile label="Calls" value={compact(stats.calls)} hint={`${plural(stats.clients, 'client')} · last ${days}d`} />
        <StatTile
          label="Errors"
          value={compact(stats.errors)}
          hint={stats.calls ? `${(errorRate * 100).toFixed(1)}% of calls` : 'nothing to rate'}
          tone={stats.errors > 0 ? colors.report : undefined}
        />
        <StatTile label="Median" value={millis(stats.p50Ms)} hint="half of calls are faster" />
        <StatTile label="p95" value={millis(stats.p95Ms)} hint="the slow tail" />
      </View>

      <ClassFilter byClass={stats.byClass} selected={classes} onChange={onClasses} />

      <View>
        <Eyebrow>Activity</Eyebrow>
        <DailyBars byDay={stats.byDay} days={days} />
      </View>

      <View>
        <Eyebrow>By hour</Eyebrow>
        <HourStrip byHour={stats.byHour} />
      </View>

      <View>
        <Eyebrow>By tool</Eyebrow>
        <ToolTable stats={stats} />
      </View>
    </ScrollView>
  );
}

/**
 * Which route classes count. Always shows every class with its real total,
 * even the filtered-out ones — this is the one place that can tell you what a
 * filter is hiding.
 */
function ClassFilter({
  byClass,
  selected,
  onChange,
}: {
  byClass: UsageStats['byClass'];
  selected: RouteClass[];
  onChange: (c: RouteClass[]) => void;
}) {
  const all = Object.keys(ROUTE_CLASS_META) as RouteClass[];
  const count = (c: RouteClass) => byClass.find((b) => b.routeClass === c)?.calls ?? 0;
  const toggle = (c: RouteClass) =>
    onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);

  return (
    <View>
      <Eyebrow>Route classes</Eyebrow>
      <ShareBar parts={all.map((c) => ({ key: c, calls: count(c), color: ROUTE_CLASS_META[c].color }))} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {all.map((c) => (
          <Chip key={c} on={selected.includes(c)} onClick={() => toggle(c)} color={ROUTE_CLASS_META[c].color} title={ROUTE_CLASS_META[c].hint}>
            {ROUTE_CLASS_META[c].label} {compact(count(c))}
          </Chip>
        ))}
      </View>
      <Text style={{ fontSize: 11, color: colors.faint, marginTop: 8, lineHeight: 16 }}>
        Everything is recorded. Unselected classes are excluded from the figures above, not
        discarded — status and admin are hidden by default because polling would otherwise
        dominate every count.
      </Text>
    </View>
  );
}

/** Fills every calendar day so idle days stay visible as gaps. */
function DailyBars({ byDay, days }: { byDay: UsageStats['byDay']; days: number }) {
  const stacked = useMemo(() => {
    const span = Math.min(days, 90);
    const out: { day: string; byClient: Record<string, number> }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      out.push({ day: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), byClient: {} });
    }
    const index = new Map(out.map((d) => [d.day, d]));
    for (const row of byDay) {
      const slot = index.get(row.day);
      if (slot) slot.byClient[row.client] = (slot.byClient[row.client] ?? 0) + row.calls;
    }
    return out;
  }, [byDay, days]);

  const clients = [...new Set(byDay.map((d) => d.client))];

  return (
    <View>
      <Bars days={stacked} clientColor={clientColor} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
        {clients.length === 0 ? (
          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
            no traffic in this window
          </Text>
        ) : (
          clients.map((c) => (
            <Swatch key={c} color={clientColor(c)}>
              {c}
            </Swatch>
          ))
        )}
      </View>
    </View>
  );
}

function ToolTable({ stats }: { stats: UsageStats }) {
  if (stats.byTool.length === 0) return <Empty title="No calls in this window." />;

  // Per-tool daily series for the sparklines. byDay aggregates by client, not
  // tool, so the shape shown is the client's — labelled as such.
  const series = new Map<string, number[]>();
  const dayKeys = [...new Set(stats.byDay.map((d) => d.day))].sort();
  for (const t of stats.byTool) {
    series.set(
      `${t.client}/${t.tool}`,
      dayKeys.map(
        (d) => stats.byDay.find((b) => b.day === d && b.client === t.client)?.calls ?? 0,
      ),
    );
  }

  return (
    <View>
      {stats.byTool.map((t) => {
        const c = clientColor(t.client);
        return (
          <View
            key={`${t.client}/${t.tool}`}
            style={{
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.line,
              paddingVertical: 9,
              gap: 6,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11.5, flexShrink: 1 }}>
                {t.tool}
              </Text>
              <Swatch color={c}>{t.client}</Swatch>
              <View style={{ flex: 1 }} />
              {t.errors > 0 ? (
                <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.report }}>{exact(t.errors)} err</Text>
              ) : null}
              <Text style={{ fontFamily: fonts.mono, fontSize: 11 }}>
                {millis(t.p50Ms)}
                <Text style={{ color: colors.faint }}> / {millis(t.p95Ms)}</Text>
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Spark values={series.get(`${t.client}/${t.tool}`) ?? []} color={c} />
              <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.faint }}>
                {compact(t.calls)} calls · max {millis(t.maxMs)} · {relativeTime(t.lastAt)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
