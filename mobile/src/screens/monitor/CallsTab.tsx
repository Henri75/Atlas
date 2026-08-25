import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  clientColor,
  compact,
  describeQuery,
  exact,
  millis,
  relativeTime,
  type RouteClass,
  type UsageCallRow,
} from '@atlas/shared';
import { EmptyRule, Swatch } from '../../components/charts';
import { Empty, Spinner } from '../../components/atoms';
import { StatusBadgeNative } from '../../components/StatusBadge';
import { CallSheet } from '../../components/CallSheet';
import { Filters, type FilterState } from './Filters';
import { useCallFeed } from './useCallFeed';
import { colors, fonts, tint } from '../../theme';

/**
 * The forensic list: every recorded call, newest first, with what was asked
 * and (one tap away) what came back. Infinite scroll rather than pages —
 * reading a log is a scan — so "how many" is stated explicitly in the header.
 */
export function CallsTab({
  classes,
  filters,
  onFilters,
}: {
  classes: RouteClass[];
  filters: FilterState;
  onFilters: (f: FilterState) => void;
}) {
  const feed = useCallFeed(filters, classes);
  const [openId, setOpenId] = useState<number | null>(null);
  const shown = feed.calls.length;

  return (
    <View>
      <Filters state={filters} onChange={onFilters} facets={feed.facets} />

      <TopStats facets={feed.facets} total={feed.total} />

      {feed.error ? <Empty title="Cannot load calls." hint={feed.error} /> : null}
      {!feed.error && feed.loading && shown === 0 ? <Spinner label="loading calls" /> : null}

      {!feed.error && !feed.loading && shown === 0 ? (
        <Empty
          title="No calls match."
          hint={
            classes.length === 0
              ? 'No route classes are selected — pick at least one on the Overview tab.'
              : filters.hideNoise
                ? 'Try a wider range, or switch off "hide noise" to include /api/projects and query-less calls.'
                : 'Try a wider range, or clear the filters.'
          }
        />
      ) : null}

      {shown > 0 ? (
        <>
          <View style={{ marginTop: 14 }}>
            {feed.calls.map((c) => (
              <CallRow key={c.id} call={c} onOpen={() => setOpenId(c.id)} />
            ))}
          </View>

          {/* The footer doubles as the load-more trigger; the sentinel logic of
              the web becomes onEndReached on this tab's list host. */}
          <Pressable
            onPress={feed.loadMore}
            disabled={feed.loadingMore || feed.done}
            style={{ paddingVertical: 16, alignItems: 'center' }}
          >
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
              {feed.loadingMore
                ? 'loading…'
                : feed.done
                  ? `${exact(shown)} of ${exact(feed.total)} · end of the log`
                  : `${exact(shown)} of ${exact(feed.total)} · tap for more`}
            </Text>
          </Pressable>
        </>
      ) : null}

      <CallSheet id={openId} onClose={() => setOpenId(null)} />
    </View>
  );
}

/**
 * Headline counts by client and by type over the filtered set — computed
 * server-side from the same WHERE clause as the rows.
 */
function TopStats({
  facets,
  total,
}: {
  facets: { byClient: { key: string; calls: number }[]; byTool: { key: string; calls: number }[] };
  total: number;
}) {
  if (total === 0) return null;
  return (
    <View
      style={{
        marginTop: 14,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.panel,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 10,
      }}
    >
      <View>
        <Text style={{ fontFamily: fonts.mono, fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.2, color: colors.faint, marginBottom: 6 }}>
          By client · {exact(total)} calls
        </Text>
        <BarListNative
          items={facets.byClient.map((f) => ({ key: f.key, calls: f.calls, color: clientColor(f.key) }))}
        />
      </View>
      <View>
        <Text style={{ fontFamily: fonts.mono, fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.2, color: colors.faint, marginBottom: 6 }}>
          By type
        </Text>
        <BarListNative items={facets.byTool.slice(0, 6).map((f) => ({ key: f.key, calls: f.calls }))} />
        {facets.byTool.length > 6 ? (
          <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.faint, marginTop: 3 }}>
            +{facets.byTool.length - 6} more — filter by tool above
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function BarListNative({ items }: { items: { key: string; calls: number; color?: string }[] }) {
  if (items.length === 0) {
    return <Text style={{ fontSize: 12, color: colors.faint }}>nothing recorded</Text>;
  }
  const top = Math.max(...items.map((i) => i.calls), 1);
  return (
    <View style={{ gap: 4 }}>
      {items.map((i) => (
        <View key={i.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.muted, width: 92 }}>
            {i.key}
          </Text>
          <View style={{ flex: 1, height: 10, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.line }}>
            <View
              style={{
                height: '100%',
                minWidth: 2,
                width: `${(i.calls / top) * 100}%`,
                backgroundColor: i.color ?? colors.kdb,
                borderRadius: 3,
              }}
            />
          </View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.muted, width: 40, textAlign: 'right' }}>
            {compact(i.calls)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function CallRow({ call, onOpen }: { call: UsageCallRow; onOpen: () => void }) {
  // Memoised: this parses a URL query string per row, and an infinite list can
  // hold a few thousand of them.
  const asked = useMemo(() => describeQuery(call.query), [call.query]);

  return (
    <Pressable
      onPress={onOpen}
      android_ripple={{ color: tint(colors.ink, 5) }}
      style={({ pressed }) => ({
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.line,
        paddingVertical: 8,
        gap: 3,
        backgroundColor: pressed ? colors.panel : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.muted, width: 74 }}>
          {relativeTime(call.at)}
        </Text>
        <Swatch color={clientColor(call.client)}>{call.client}</Swatch>
        <View style={{ flex: 1 }} />
        <StatusBadgeNative status={call.status} />
        <Text style={{ fontFamily: fonts.mono, fontSize: 10.5 }}>{millis(call.durationMs)}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingLeft: 82 }}>
        <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11.5, color: colors.ink, flexShrink: 1 }}>
          {call.tool ?? call.path}
          {call.hasReply ? <Text style={{ color: colors.faint }}> ⏎</Text> : null}
        </Text>
      </View>
      {asked?.text ? (
        <Text numberOfLines={1} style={{ paddingLeft: 82, fontSize: 12, color: colors.muted }} ellipsizeMode="tail">
          {asked.text}
        </Text>
      ) : null}
      {asked && asked.filters.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingLeft: 82 }}>
          {asked.filters.slice(0, 3).map((f) => (
            <Text
              key={`${f.key}-${f.value}`}
              style={{
                fontFamily: fonts.mono,
                fontSize: 9.5,
                backgroundColor: colors.panel2,
                color: colors.muted,
                paddingHorizontal: 5,
                paddingVertical: 2,
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              {f.key}:{f.value}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}
