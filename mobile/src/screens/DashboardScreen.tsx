import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  SOURCE_META,
  bytes,
  compact,
  duration,
  exact,
  plural,
  relativeTime,
  type Dashboard,
  type MachineRow,
  type RunRow,
  type SourceDetailRow,
} from '@atlas/shared';
import { api } from '../api/endpoints';
import { useServer } from '../state/server';
import { useMachines } from '../hooks/useMachines';
import { ActivityChart, SyncDot } from '../components/charts';
import { Empty, Eyebrow, Spinner } from '../components/atoms';
import { OfflineBanner } from '../components/banners';
import { colors, fonts, tint } from '../theme';

/**
 * The landing overview: what is indexed, whether it is working, what it costs.
 * Numbers render compact with the exact value one long-press away — compact is
 * scannable but lossy, so both exist. Sizes that cannot be determined render
 * as "—", never as 0.
 */
export function DashboardScreen({ onGoToSearch }: { onGoToSearch: () => void }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const offline = useServer().offline;
  const { self, machines, multiMachine, syncIntervalMin } = useMachines(15_000);

  const load = useCallback(() => {
    return api
      .dashboard()
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  if ((error || offline) && !data) {
    return (
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <OfflineBanner onRetry={() => void load()} />
        <Empty title="Cannot reach the API." hint="The stack may still be starting." />
      </ScrollView>
    );
  }
  if (!data) return <Spinner />;

  const stale = data.storage.collections.filter((c) => !c.active && c.bytes > 0);
  const staleBytes = stale.reduce((sum, c) => sum + c.bytes, 0);
  const indexing = (data.pending ?? 0) > 0 || data.backfill != null;

  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.kdb} />}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: '600' }}>Overview</Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
          indexed {relativeTime(data.lastRunAt)}
          {indexing ? ' · indexing…' : ''}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        <Stat label="Projects" value={compact(data.projects)} hint="" />
        <Stat label="Documents" value={compact(data.entries)} hint="indexed entries" />
        <Stat label="Chunks" value={compact(data.chunks)} hint="searchable pieces" />
        <Stat label="Sessions" value={compact(data.sessions)} hint="Claude transcripts" />
      </View>

      {multiMachine ? (
        <View style={{ marginTop: 24 }}>
          <Eyebrow>Fleet</Eyebrow>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {machines.map((m) => (
              <MachineCard key={m.name} m={m} self={self} syncIntervalMin={syncIntervalMin ?? 10} />
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ marginTop: 26 }}>
        <Eyebrow>Services</Eyebrow>
        <View style={{ gap: 7 }}>
          {Object.entries(data.health).map(([name, up]) => (
            <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <SyncDot color={up ? colors.git : colors.report} />
              <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{name}</Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: up ? colors.git : colors.report }}>
                {up ? 'running' : 'unreachable'}
              </Text>
            </View>
          ))}
          {data.embedderHealth?.name ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <SyncDot color={data.embedderHealth.fallback ? colors.report : colors.git} />
              <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>embedder</Text>
              <Text
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  color: data.embedderHealth.fallback ? colors.report : colors.git,
                }}
              >
                {data.embedderHealth.name}
              </Text>
            </View>
          ) : null}
        </View>

        {data.embedderHealth?.fallback ? (
          <WarnText>
            Running on a fallback embedder: “{data.embedderHealth.configured}” could not reach its
            preferred provider and settled for “{data.embedderHealth.name}”. Vectors are lower
            quality and indexing is far slower.
          </WarnText>
        ) : null}
        {data.embedderHealth?.searchDegraded ? (
          <WarnText>
            Dense search is off: the API has no embedder that can query “{data.collection}”, so
            results come from keyword matching alone. It recovers on its own once the provider is
            back.
          </WarnText>
        ) : null}

        <View style={{ gap: 4, marginTop: 14 }}>
          <Kv k="embedder" v={data.embedder} />
          {data.vectors ? (
            <Kv
              k="vectors"
              v={`${compact(data.vectors.points)} points · ${compact(data.vectors.vectors)} vectors`}
            />
          ) : null}
          <Kv k="queue" v={data.pending == null ? '—' : `${exact(data.pending)} pending`} />
          <Kv
            k="errors"
            v={
              data.recentErrors > 0
                ? `${exact(data.recentErrors)} in the last hour`
                : 'none in the last hour'
            }
            danger={data.recentErrors > 0}
          />
          <Kv
            k="coverage"
            v={
              data.unsearchableEntries > 0
                ? `${exact(data.unsearchableEntries)} not searchable`
                : 'all entries searchable'
            }
            danger={data.unsearchableEntries > 0}
          />
        </View>
      </View>

      <View style={{ marginTop: 26 }}>
        <Eyebrow>Storage</Eyebrow>
        <View style={{ gap: 4 }}>
          <Kv k="postgres (disk)" v={bytes(data.storage.postgresBytes)} />
          <Kv k="qdrant (disk)" v={bytes(data.storage.qdrantBytes)} />
          <Kv k="redis (memory)" v={bytes(data.storage.redisMemoryBytes)} />
        </View>

        {data.storage.collections.length > 0 ? (
          <View style={{ marginTop: 16 }}>
            <Eyebrow>Vector collections</Eyebrow>
            <View style={{ gap: 6 }}>
              {data.storage.collections.map((c) => (
                <View key={c.name} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                  <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, flex: 1 }}>
                    {c.name}
                  </Text>
                  <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>
                    {bytes(c.bytes)}
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10,
                      letterSpacing: 2,
                      color: c.active ? colors.git : colors.faint,
                    }}
                  >
                    {c.active ? 'ACTIVE' : 'STALE'}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {staleBytes > 0 ? (
          <WarnText>
            {bytes(staleBytes)} of stale vectors. Left behind by an embedding-model change; nothing
            reads them. Reclaim on the host with `docker compose down -v` and a reindex.
          </WarnText>
        ) : null}
      </View>

      <View style={{ marginTop: 26 }}>
        <Eyebrow>Indexing activity — last 30 days</Eyebrow>
        <ActivityChart activity={data.activity ?? []} />
      </View>

      <View style={{ marginTop: 26 }}>
        <Eyebrow>What is indexed</Eyebrow>
        <SourceBreakdown
          bySource={data.bySource}
          total={data.entries}
          detail={data.sourceDetail ?? []}
          archivedDocs={data.archivedDocs ?? 0}
        />
      </View>

      {(data.runs ?? []).length > 0 ? (
        <View style={{ marginTop: 26 }}>
          <Eyebrow>Recent index runs</Eyebrow>
          <RecentRuns runs={data.runs} />
        </View>
      ) : null}

      <GoButton label="Search & Ask →" onPress={onGoToSearch} />
    </ScrollView>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View
      style={{
        backgroundColor: colors.panel,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 11,
        minWidth: '47%' as unknown as number,
        flexGrow: 1,
      }}
    >
      <Text style={{ fontFamily: fonts.display, fontSize: 23, fontWeight: '600' }}>{value}</Text>
      <Text style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>{label}</Text>
      {hint ? <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>{hint}</Text> : null}
    </View>
  );
}

function Kv({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, flex: 1 }}>{k}</Text>
      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: danger ? colors.report : colors.muted }}>
        {v}
      </Text>
    </View>
  );
}

function WarnText({ children }: { children: React.ReactNode }) {
  return (
    <Text
      style={{
        marginTop: 10,
        fontSize: 12,
        lineHeight: 17,
        color: colors.report,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tint(colors.report, 40),
        backgroundColor: tint(colors.report, 6),
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      {children}
    </Text>
  );
}

/** Proportional bars, largest first, with the inventory behind each bar. */
function SourceBreakdown({
  bySource,
  total,
  detail,
  archivedDocs,
}: {
  bySource: Record<string, number>;
  total: number;
  detail: SourceDetailRow[];
  archivedDocs: number;
}) {
  const byType = new Map(detail.map((d) => [d.sourceType, d]));
  const rows = Object.entries(bySource)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!rows.length) return <Empty title="Nothing indexed yet." />;

  const max = rows[0]![1];
  return (
    <View style={{ gap: 7 }}>
      {rows.map(([source, n]) => {
        const meta = SOURCE_META[source as keyof typeof SOURCE_META];
        const d = byType.get(source as SourceDetailRow['sourceType']);
        const pct = total > 0 ? Math.round((n / total) * 100) : 0;
        return (
          <View key={source}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1.5, width: 86, color: meta?.color ?? colors.muted }} numberOfLines={1}>
                {meta?.label ?? source}
              </Text>
              <View style={{ flex: 1, height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.line }}>
                <View style={{ height: '100%', borderRadius: 3, width: `${(n / max) * 100}%`, backgroundColor: meta?.color ?? colors.muted }} />
              </View>
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, width: 42, textAlign: 'right' }}>
                {compact(n)}
              </Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, width: 30, textAlign: 'right' }}>
                {pct}%
              </Text>
            </View>
            {d ? (
              <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.faint, marginLeft: 94, marginTop: 1 }}>
                {compact(d.files)} files · {bytes(d.volumeChars)}
              </Text>
            ) : null}
          </View>
        );
      })}
      {archivedDocs > 0 ? (
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, paddingTop: 3 }}>
          {exact(archivedDocs)} doc sections live under archive-style paths — indexed and
          searchable, downranked in results.
        </Text>
      ) : null}
    </View>
  );
}

function RecentRuns({ runs }: { runs: RunRow[] }) {
  return (
    <View style={{ gap: 4 }}>
      {runs.slice(0, 6).map((r) => {
        const secs =
          r.startedAt && r.finishedAt
            ? (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000
            : null;
        return (
          <View key={r.id} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, width: 92 }}>
              {r.kind}
            </Text>
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, flex: 1 }} numberOfLines={1}>
              {relativeTime(r.startedAt)}
            </Text>
            {r.stats?.enqueued != null ? (
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
                {plural(Number(r.stats.enqueued), 'job')}
              </Text>
            ) : null}
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, width: 52, textAlign: 'right' }}>
              {r.finishedAt ? duration(secs) : 'running…'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const DEFAULT_SYNC_INTERVAL_MIN = 10;

function isStale(sync: MachineRow['sync'], intervalMin: number): boolean {
  if (!sync?.lastSuccessAt) return true;
  const ageMs = Date.now() - new Date(sync.lastSuccessAt).getTime();
  return ageMs >= intervalMin * 2 * 60_000;
}

export function MachineCard({
  m,
  self,
  syncIntervalMin,
}: {
  m: MachineRow;
  self: string;
  syncIntervalMin?: number;
}) {
  // Mirrors the dashboard's machine cards; syncStateOf lives in MachinesScreen.
  const state = syncStateOf(m.sync);
  const bad = state === 'unreachable' || state === 'error';
  const intervalMin = syncIntervalMin ?? DEFAULT_SYNC_INTERVAL_MIN;
  const stale = state === 'ok' && isStale(m.sync, intervalMin);
  const dotColor = bad ? colors.report : stale ? colors.kdb : state === 'ok' ? colors.git : colors.faint;
  return (
    <View
      style={{
        backgroundColor: colors.panel,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexGrow: 1,
        minWidth: '47%' as unknown as number,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SyncDot color={dotColor} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: '600' }}>
          {m.name}
          {m.name === self ? <Text style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: '400', color: colors.faint }}> (self)</Text> : null}
        </Text>
        <SyncPill state={state} />
      </View>
      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: stale ? colors.kdb : colors.faint, marginTop: 5 }}>
        last success {relativeTime(m.sync?.lastSuccessAt ?? undefined)}
      </Text>
    </View>
  );
}

export type SyncState = 'never' | 'running' | 'ok' | 'unreachable' | 'error';

/** `sync: null` (no machine_sync row yet) reads as 'never', same as the CLI. */
export function syncStateOf(sync: { status?: string } | null | undefined): SyncState {
  const s = sync?.status;
  return s === 'running' || s === 'ok' || s === 'unreachable' || s === 'error' ? s : 'never';
}

export function SyncPill({ state }: { state: SyncState }) {
  const map: Record<SyncState, string> = {
    never: colors.faint,
    running: colors.claude,
    ok: colors.git,
    unreachable: colors.kdb,
    error: colors.report,
  };
  const color = map[state];
  return (
    <Text
      style={{
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: 2,
        color,
        backgroundColor: tint(color, 12),
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 3,
        overflow: 'hidden',
      }}
    >
      {state}
    </Text>
  );
}

export function GoButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        marginTop: 26,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.kdb,
        backgroundColor: tint(colors.kdb, 8),
        paddingVertical: 13,
        alignItems: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.kdb }}>{label}</Text>
    </Pressable>
  );
}
