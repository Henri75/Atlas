import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ENTRY_KIND_META,
  compact,
  duration,
  exact,
  matches,
  plural,
  type EntryKind,
  type EntryRecord,
  type ProjectRow,
  type SessionRow,
} from '@atlas/shared';
import { api } from '../api/endpoints';
import type { ScopeHandle } from '../hooks/useScope';
import { Empty, Eyebrow, Highlight, PickProject, Spinner, Stamp } from '../components/atoms';
import { FilterInput } from '../components/FilterInput';
import { Markdown } from '../components/MarkdownNative';
import { colors, fonts, tint } from '../theme';

/**
 * Session browser + replay: prompts, responses, insights and what was done.
 * Browses ONE project (a session belongs to a project); the detail is a pushed
 * native screen with back-swipe.
 */

const kindOf = (e: EntryRecord): EntryKind => ((e.meta?.kind as EntryKind) ?? 'response');

/** Elapsed time between two ISO stamps, or null when it cannot be known. */
function elapsed(from?: string, to?: string): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return duration(ms / 1000);
}

export function SessionsScreen({
  scope,
  projects,
  onProject,
  onOpenSession,
}: {
  scope: ScopeHandle;
  projects: ProjectRow[];
  /** Browse-this-one affordance from the empty state. */
  onProject: (slug: string) => void;
  /** Pushes the session detail onto this tab's native stack. */
  onOpenSession: (id: string) => void;
}) {
  const project = scope.project;
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    setSessions([]);
    setQ('');
    if (!project) return;
    let alive = true;
    void api
      .sessions(project)
      .then((r) => alive && setSessions(r.sessions))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project]);

  const shown = useMemo(
    () => sessions.filter((s) => matches(s.title, q) || matches(s.id, q) || matches(s.cwd, q)),
    [sessions, q],
  );

  if (!project) {
    return (
      <ScrollView contentContainerStyle={{ paddingVertical: 12 }}>
        <PickProject what="Claude Code sessions" projects={projects} onProject={onProject} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 }}>
      <Eyebrow>Sessions — {project}</Eyebrow>
      <FilterInput
        value={q}
        onChange={setQ}
        placeholder="Filter sessions by title, id or folder…"
        count={{ shown: shown.length, total: sessions.length }}
      />
      <View style={{ gap: 6 }}>
        {shown.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => onOpenSession(s.id)}
            android_ripple={{ color: tint(colors.ink, 5) }}
            style={({ pressed }) => ({
              borderLeftWidth: 3,
              borderLeftColor: colors.claude,
              backgroundColor: pressed ? colors.panel2 : colors.panel,
              borderTopRightRadius: 8,
              borderBottomRightRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 10,
            })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
                {s.id.slice(0, 8)}
              </Text>
              <Highlight
                text={s.title ?? '(untitled session)'}
                needle={q}
                style={{ fontSize: 14, color: colors.ink, flexShrink: 1 }}
                numberOfLines={1}
              />
              <View style={{ flex: 1 }} />
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>
                {compact(s.prompt_count)}p · {compact(s.action_count ?? 0)}a
              </Text>
              <Stamp iso={s.started_at} />
            </View>
          </Pressable>
        ))}
        {sessions.length === 0 ? <Empty title="No sessions indexed for this project yet." /> : null}
        {sessions.length > 0 && shown.length === 0 ? <Empty title="No sessions match that filter." /> : null}
      </View>
    </ScrollView>
  );
}

/* -------------------------------------------------------------------------
 * Session detail — its own pushed screen (native back gesture).
 * ---------------------------------------------------------------------- */

export function SessionDetailScreen({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<{ session: SessionRow; entries: EntryRecord[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [kinds, setKinds] = useState<Set<EntryKind>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .session(sessionId)
      .then((d) => alive && setDetail(d))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // Hooks stay unconditional: the loading→loaded transition changes state,
  // never the hook order (React throws on a hook-count change mid-mount).
  const entries = detail?.entries ?? [];
  const present = useMemo(() => {
    const s = new Set<EntryKind>();
    for (const e of entries) s.add(kindOf(e));
    return [...s];
  }, [entries]);

  if (loading) return <Spinner label="loading session" />;
  if (!detail) return <Empty title="Session not found." />;
  const { session } = detail;

  const shown = entries.filter(
    (e) => (kinds.size === 0 || kinds.has(kindOf(e))) && matches(e.body, q),
  );

  const toggleKind = (k: EntryKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const took = elapsed(session.started_at, session.ended_at);

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 48 }}>
      <Text style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: '600', lineHeight: 24 }}>
        {session.title ?? session.id}
      </Text>

      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, marginTop: 6, lineHeight: 17 }}>
        <Stamp iso={session.started_at} />
        {took ? ` · took ${took}` : ''}
        {` · ${plural(session.prompt_count, 'prompt')}`}
        {` · ${plural(session.action_count ?? 0, 'action')}`}
        {` · ${plural(entries.length, 'message')}`}
        {session.files_touched?.length > 0 ? ` · ${plural(session.files_touched.length, 'file')} changed` : ''}
      </Text>
      {session.cwd ? (
        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, marginTop: 3 }} numberOfLines={1}>
          {session.cwd}
        </Text>
      ) : null}

      <View style={{ marginTop: 18 }}>
        <FilterInput
          value={q}
          onChange={setQ}
          placeholder="Filter this conversation…"
          count={{ shown: shown.length, total: entries.length }}
        />
        {present.length > 1 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {present.map((k) => {
              const on = kinds.has(k);
              const meta = ENTRY_KIND_META[k];
              return (
                <Pressable
                  key={k}
                  onPress={() => toggleKind(k)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 4,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: on ? meta.color : colors.line,
                    backgroundColor: on ? tint(meta.color, 14) : 'transparent',
                  }}
                >
                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: meta.color }}>
                    {meta.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

      <View style={{ gap: 12 }}>
        {shown.map((e) => {
          const k = kindOf(e);
          const meta = ENTRY_KIND_META[k];
          return (
            <View
              key={String(e.id)}
              style={{
                borderLeftWidth: 3,
                borderLeftColor: meta.color,
                backgroundColor: colors.panel,
                borderTopRightRadius: 8,
                borderBottomRightRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 9,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: meta.color }}>
                  {meta.label}
                </Text>
                <Stamp iso={e.occurred_at} />
              </View>
              <View style={{ marginTop: 4 }}>
                <Markdown text={e.body} baseSize={13} needle={q || undefined} />
              </View>
            </View>
          );
        })}
        {shown.length === 0 ? (
          <Empty title="No messages match." hint="Clear the filter or pick another kind." />
        ) : null}
      </View>

      {session.files_touched?.length > 0 ? (
        <View style={{ marginTop: 22 }}>
          <Eyebrow>Files touched</Eyebrow>
          <View style={{ gap: 3 }}>
            {session.files_touched.map((f) => (
              <Highlight key={f} text={f} needle={q} style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.muted }} numberOfLines={1} />
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
