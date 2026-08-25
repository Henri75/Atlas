import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ROUTE_CLASS_META,
  rangeDays,
  rangeLabel as rangeLabelOf,
  type RouteClass,
} from '@atlas/shared';
import * as Haptics from 'expo-haptics';
import { usePersistentState } from '../../state/prefs';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../../theme';
import { RangePicker, type FilterState } from './Filters';
import { CallsTab } from './CallsTab';
import { StatsTab } from './StatsTab';
import { AdoptionTab } from './AdoptionTab';

type Tab = 'overview' | 'calls' | 'stats' | 'adoption';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'calls', label: 'Calls' },
  { key: 'stats', label: 'Stats' },
  { key: 'adoption', label: 'Adoption' },
];

/** Classes shown by default: everything the classification does not call noise. */
const SIGNAL_CLASSES = (Object.keys(ROUTE_CLASS_META) as RouteClass[]).filter(
  (c) => !ROUTE_CLASS_META[c].noise,
);

const DEFAULT_FILTERS: FilterState = {
  range: { mode: 'relative', n: 7, unit: 'days' },
  q: '',
  hideNoise: true,
};

/**
 * Monitor: who uses Atlas, for what, how well it answered. One window governs
 * every tab; refresh is manual with an opt-in live toggle (off by default —
 * this page's own requests are logged too).
 */
export function MonitorScreen() {
  const [tab, setTab] = useState<Tab>('overview');
  const [classes, setClasses] = usePersistentState<RouteClass[]>('atlas.monitor.classes', SIGNAL_CLASSES);
  const [filters, setFilters] = usePersistentState<FilterState>('atlas.monitor.filters', DEFAULT_FILTERS);
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const days = useMemo(() => rangeDays(filters.range), [filters.range]);
  const setRange = useCallback(
    (range: FilterState['range']) => setFilters((f) => ({ ...f, range })),
    [setFilters],
  );

  useEffect(() => {
    if (!live) return;
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [live, refresh]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <Text style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: '600' }}>Monitor</Text>
        <Text style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>
          Who calls Atlas, what they asked, what it answered ·{' '}
          {rangeLabelOf(filters.range)}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <RangePicker range={filters.range} onChange={setRange} />
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setLive((v) => !v);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: live }}
            style={{
              paddingHorizontal: 9,
              paddingVertical: 5,
              borderRadius: 7,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.line,
              backgroundColor: live ? colors.panel2 : 'transparent',
            }}
          >
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: live ? colors.kdb : colors.muted }}>
              {live ? '● live' : '○ live'}
            </Text>
          </Pressable>
          <Pressable
            onPress={refresh}
            accessibilityRole="button"
            style={{
              paddingHorizontal: 9,
              paddingVertical: 5,
              borderRadius: 7,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.line,
            }}
          >
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>refresh</Text>
          </Pressable>
        </View>

        {/* Tabs */}
        <View style={{ flexDirection: 'row', gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, marginTop: 12 }}>
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setTab(t.key);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderBottomWidth: on ? 2 : 0,
                  borderBottomColor: colors.kdb,
                  marginBottom: -StyleSheet.hairlineWidth,
                }}
              >
                <Text style={{ fontSize: 13, color: on ? colors.ink : colors.muted }}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 48 }}
        style={{ flex: 1 }}
      >
        {tab === 'overview' && <OverviewLazy days={days} classes={classes} onClasses={setClasses} nonce={nonce} />}
        {tab === 'calls' && <CallsTab classes={classes} filters={filters} onFilters={setFilters} />}
        {tab === 'stats' && <StatsTab days={days} nonce={nonce} />}
        {tab === 'adoption' && <AdoptionTab nonce={nonce} />}
      </ScrollView>
    </View>
  );
}

/** Overview remounts on every class change via key — mirrors the web effect deps. */
function OverviewLazy({
  days,
  classes,
  onClasses,
  nonce,
}: {
  days: number;
  classes: RouteClass[];
  onClasses: (c: RouteClass[]) => void;
  nonce: number;
}) {
  return (
    <OverviewInner key={days + ':' + classes.join(',')} days={days} classes={classes} onClasses={onClasses} nonce={nonce} />
  );
}
import { OverviewTab as OverviewInner } from './OverviewTab';
