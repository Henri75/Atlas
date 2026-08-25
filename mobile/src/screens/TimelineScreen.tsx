import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  matches,
  type ProjectRow,
  type TimelineItem,
} from '@atlas/shared';
import { api } from '../api/endpoints';
import type { ScopeHandle } from '../hooks/useScope';
import { Badge, Empty, Eyebrow, Highlight, ProjectTag, Spinner, Stamp, SpineRow } from '../components/atoms';
import { FilterInput } from '../components/FilterInput';
import { EntrySheet } from '../components/EntrySheet';
import { usePersistentState } from '../state/prefs';
import { colors, fonts, tint } from '../theme';

type Layout = 'feed' | 'table';

/**
 * Two ways to read history: feed (grouped by day, source colour on a spine) or
 * table (date and time in their own columns for scanning). The choice is
 * persisted — a working preference, not a per-visit decision.
 */
export function TimelineScreen({
  scope,
  projects,
}: {
  scope: ScopeHandle;
  projects: ProjectRow[];
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [q, setQ] = useState('');
  const [layout, setLayout] = usePersistentState<Layout>('kdbscope.timeline.layout', 'feed');
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const slugs = scope.isAll ? projects.map((p) => p.slug) : scope.projects;

  const load = useCallback(
    async (before?: string) => {
      if (!slugs.length) return;
      setLoading(true);
      try {
        const r = await api.timeline(slugs, { limit: 60, before });
        setItems((prev) => (before ? [...prev, ...r.items] : r.items));
        setDone(r.items.length < 60);
      } catch {
        // The offline banner lives in the shell; keep whatever rows we have.
      } finally {
        setLoading(false);
      }
    },
    [slugs.join(',')],
  );

  useEffect(() => {
    setItems([]);
    setDone(false);
    setQ('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugs.join(',')]);

  const shown = useMemo(
    () => items.filter((t) => matches(t.title, q) || matches(t.component, q)),
    [items, q],
  );

  const onRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.kdb} />}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontFamily: fonts.display, textTransform: 'uppercase', letterSpacing: 2, fontSize: 11, color: colors.muted }}>
              Timeline — {scope.isAll ? 'all projects' : scope.projects.join(' + ')}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {(['feed', 'table'] as Layout[]).map((l) => (
              <Pressable
                key={l}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setLayout(l);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: layout === l }}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 4,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: layout === l ? colors.faint : colors.line,
                  backgroundColor: layout === l ? colors.panel2 : 'transparent',
                }}
              >
                <Text
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    letterSpacing: 2,
                    color: layout === l ? colors.ink : colors.muted,
                  }}
                >
                  {l.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <FilterInput
            value={q}
            onChange={setQ}
            placeholder="Filter loaded entries…"
            count={{ shown: shown.length, total: items.length }}
          />
        </View>

        {layout === 'table' ? (
          <TableLayout items={shown} needle={q} onOpenEntry={setOpenEntry} showProjects={scope.isMulti} />
        ) : (
          <FeedLayout items={shown} needle={q} onOpenEntry={setOpenEntry} showProjects={scope.isMulti} />
        )}

        {loading && items.length > 0 ? <Spinner /> : null}
        {!loading && !done && items.length > 0 ? (
          <Pressable
            onPress={() => void load(items[items.length - 1]!.occurredAt)}
            style={({ pressed }) => ({
              marginTop: 14,
              paddingVertical: 11,
              alignItems: 'center',
              backgroundColor: colors.panel,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: pressed ? colors.faint : colors.line,
              borderRadius: 8,
            })}
          >
            <Text style={{ fontSize: 13, color: colors.muted }}>Load older</Text>
          </Pressable>
        ) : null}
        {!loading && items.length === 0 ? <Empty title="No dated activity indexed yet." /> : null}
        {!loading && items.length > 0 && shown.length === 0 ? (
          <Empty title="Nothing loaded matches that filter." hint="The filter searches what is loaded — try “Load older” for more." />
        ) : null}
      </ScrollView>

      <EntrySheet entryId={openEntry} onClose={() => setOpenEntry(null)} />
    </View>
  );
}

function FeedLayout({
  items,
  needle,
  onOpenEntry,
  showProjects,
}: {
  items: TimelineItem[];
  needle: string;
  onOpenEntry: (id: number) => void;
  showProjects: boolean;
}) {
  let lastDay = '';
  return (
    <View style={{ gap: 6 }}>
      {items.map((t) => {
        const day = t.occurredAt.slice(0, 10);
        const ruler = day !== lastDay;
        lastDay = day;
        return (
          <View key={t.entryId}>
            {ruler ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 16, paddingBottom: 6 }}>
                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>{day}</Text>
                <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line }} />
              </View>
            ) : null}
            {/* Session-backed rows open the session's first entry; the web jumps
                into the session browser — here the record itself is the target. */}
            <SpineRow source={t.sourceType} onPress={() => onOpenEntry(t.entryId)}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <Stamp iso={t.occurredAt} />
                <Badge source={t.sourceType} />
                {showProjects ? <ProjectTag slug={t.projectSlug} /> : null}
                {t.component ? (
                  <Highlight text={t.component} needle={needle} style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }} numberOfLines={1} />
                ) : null}
              </View>
              <View style={{ marginTop: 3 }}>
                <Highlight text={t.title} needle={needle} style={{ fontSize: 14, color: colors.ink }} />
              </View>
            </SpineRow>
          </View>
        );
      })}
    </View>
  );
}

function TableLayout({
  items,
  needle,
  onOpenEntry,
  showProjects,
}: {
  items: TimelineItem[];
  needle: string;
  onOpenEntry: (id: number) => void;
  showProjects: boolean;
}) {
  return (
    <View>
      <View style={{ flexDirection: 'row', paddingBottom: 4 }}>
        <Col w={78}><Head>Date</Head></Col>
        <Col w={44}><Head>Time</Head></Col>
        <Col w={96}><Head>Source</Head></Col>
        {showProjects ? <Col w={70}><Head>Project</Head></Col> : null}
        <Col flex><Head>What happened</Head></Col>
      </View>
      {items.map((t) => (
        <Pressable
          key={t.entryId}
          onPress={() => onOpenEntry(t.entryId)}
          android_ripple={{ color: tint(colors.ink, 5) }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.line,
            paddingVertical: 7,
            alignItems: 'flex-start',
            backgroundColor: pressed ? colors.panel : 'transparent',
          })}
        >
          <Col w={78}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>{t.occurredAt.slice(0, 10)}</Text>
          </Col>
          <Col w={44}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>{t.occurredAt.slice(11, 16)}</Text>
          </Col>
          <Col w={96}>
            <Badge source={t.sourceType} />
          </Col>
          {showProjects ? (
            <Col w={70}>
              <ProjectTag slug={t.projectSlug} />
            </Col>
          ) : null}
          <Col flex>
            <Highlight text={t.title} needle={needle} style={{ fontSize: 12.5, color: colors.ink }} numberOfLines={2} />
          </Col>
        </Pressable>
      ))}
      {items.length === 0 ? null : (
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, paddingTop: 8 }}>
          tap a row for the full record
        </Text>
      )}
    </View>
  );
}

function Col({ w, flex, children }: { w?: number; flex?: boolean; children: React.ReactNode }) {
  return <View style={[{ paddingRight: 8 }, w != null ? { width: w } : null, flex ? { flex: 1 } : null]}>{children}</View>;
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1.5, textTransform: 'uppercase', color: colors.faint }}>
      {children}
    </Text>
  );
}
