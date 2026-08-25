import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  describeError,
  ms,
  scopeParam,
  sourceRef,
  useAskConversation,
  type EntryKind,
  type SearchResult,
  type SourceType,
} from '@atlas/shared';
import { api } from '../api/endpoints';
import { colors, fonts, hexToRgba, tint } from '../theme';
import { useServer } from '../state/server';
import { useMachines } from '../hooks/useMachines';
import type { ScopeHandle } from '../hooks/useScope';
import { Badge, Dots, Empty, MachineBadge, ProjectTag, Pulse, SpineRow, Stamp } from '../components/atoms';
import { DegradedBanner } from '../components/banners';
import { ModeSwitch, MultiSelect, SingleSelect } from '../components/selectors';
import { FilterInput } from '../components/FilterInput';
import { Markdown } from '../components/MarkdownNative';
import { EntrySheet } from '../components/EntrySheet';
import { toast } from '../components/Toast';

/**
 * Search and Ask: one instrument, two modes (the web's SearchView, native).
 * Search paints a browsable list of records; Ask streams a synthesized answer
 * into a conversation. The mode is an explicit visible state of the input.
 */

type Mode = 'search' | 'ask';

const SOURCES: SourceType[] = [
  'kdb_changelog', 'kdb_component', 'kdb_session', 'kdb_backlog',
  'kdb_report', 'claude_session', 'git_commit', 'doc',
];

const KINDS: (EntryKind | '')[] = ['', 'prompt', 'plan', 'insight', 'summary', 'action', 'response'];

const DOC_STATUSES = [
  { value: '' as const, label: 'any status' },
  { value: 'active' as const, label: 'exclude archived' },
  { value: 'archived' as const, label: 'archived only' },
];

export function SearchAskScreen({ scope }: { scope: ScopeHandle }) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('search');
  const [sources, setSources] = useState<SourceType[]>([]);
  const [kind, setKind] = useState<EntryKind | ''>('');
  const [docStatus, setDocStatus] = useState<'' | 'active' | 'archived'>('');
  const [machine, setMachine] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [showing, setShowing] = useState<Mode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scopeChanged, setScopeChanged] = useState(false);
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const seq = useRef(0);

  const { baseUrl, token } = useServer();
  const { self, machines, multiMachine } = useMachines();

  // The shared conversation engine; the transport resolves connection settings
  // at call time so an in-flight answer keeps the scope it started with.
  const askStreamTransport = useCallback(
    (body: Record<string, unknown>, signal?: AbortSignal) =>
      api.ask(body, { baseUrl, token }, signal),
    [baseUrl, token],
  );
  const ask = useAskConversation(scope.projects, setOpenEntry, sources, machine, askStreamTransport);
  const busy = ask.turns.some((t) => t.streaming);

  const runSearch = useCallback(async () => {
    if (!q.trim()) return;
    const mySeq = ++seq.current;
    setShowing('search');
    setError('');
    setScopeChanged(false);
    setLoading(true);
    try {
      const r = await api.search({
        // Ask wants paragraph structure; a search query is a bag of terms.
        q: q.trim().replace(/\s+/g, ' '),
        project: scopeParam(scope.projects),
        source: sources.join(','),
        kind,
        docStatus,
        machine: machine || undefined,
        limit: 30,
      });
      if (seq.current === mySeq) setResult(r);
    } catch (e) {
      if (seq.current === mySeq) {
        setResult(null);
        setError(describeError(e));
      }
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }, [q, scope.projects, sources, kind, docStatus, machine]);

  const runAsk = useCallback(() => {
    if (!q.trim() || busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setShowing('ask');
    setError('');
    setScopeChanged(false);
    ask.send(q.trim());
    setQ('');
  }, [q, busy, ask]);

  const submit = useCallback(() => {
    if (mode === 'ask') runAsk();
    else void runSearch();
  }, [mode, runAsk, runSearch]);

  // Changing the scope changes what any answer *means*: drop stale results and
  // say why rather than leave the user wondering whether the panel refreshed.
  const first = useRef(true);
  const scopeKey = scope.projects.join(',');
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const had = result !== null || ask.turns.length > 0;
    setResult(null);
    ask.reset();
    setError('');
    setScopeChanged(had);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const scopeLabel = scope.isAll ? 'all projects' : scope.projects.join(', ');
  const asking = mode === 'ask';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <ModeSwitch<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'search', label: 'Search', icon: '⌕' },
              { value: 'ask', label: 'Ask', icon: '✦', accent: true },
            ]}
          />
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, flex: 1 }} numberOfLines={1}>
            {asking ? 'a cited answer, synthesized' : 'browse matching records'}
          </Text>
        </View>

        {/* The composer: one multiline field in both modes so switching never
            remounts it; Ask arms the amber border before a word is typed. */}
        <View
          style={{
            marginTop: 10,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: 8,
            paddingHorizontal: 14,
            paddingVertical: 4,
            borderColor: asking ? tint(colors.kdb, 50) : colors.line,
            backgroundColor: asking ? tint(colors.kdb, 4) : colors.panel,
          }}
        >
          <TextInput
            value={q}
            onChangeText={setQ}
            multiline
            placeholder={
              asking
                ? ask.turns.length
                  ? 'Ask a follow-up…'
                  : `Ask about ${scopeLabel}…`
                : `Search ${scopeLabel}…`
            }
            placeholderTextColor={colors.faint}
            accessibilityLabel={asking ? 'Ask a question' : 'Search query'}
            style={{
              minHeight: asking ? 66 : 42,
              maxHeight: 200,
              color: colors.ink,
              fontSize: 15,
              lineHeight: 22,
              paddingTop: 8,
              paddingBottom: 8,
            }}
          />
        </View>

        <Pressable
          onPress={submit}
          disabled={asking && busy}
          accessibilityRole="button"
          style={({ pressed }) => ({
            marginTop: 10,
            alignSelf: 'flex-end',
            borderRadius: 8,
            borderWidth: StyleSheet.hairlineWidth,
            paddingHorizontal: 18,
            paddingVertical: 10,
            opacity: asking && busy ? 0.5 : pressed ? 0.85 : 1,
            borderColor: asking ? colors.kdb : colors.line,
            backgroundColor: asking ? tint(colors.kdb, 8) : colors.panel2,
          })}
        >
          <Text
            style={{
              fontSize: 13.5,
              fontWeight: '600',
              color: asking ? colors.kdb : colors.ink,
            }}
          >
            {asking ? (ask.turns.length ? 'Follow up' : 'Ask') : 'Search'}
          </Text>
        </Pressable>

        {/* Filters */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <MultiSelect
            options={SOURCES}
            selected={sources}
            onChange={setSources}
            allLabel="all sources"
            label="Source filter"
          />
          <SingleSelect
            value={kind}
            onChange={(v) => setKind(v)}
            label="Message kind filter"
            options={KINDS.map((k) => ({ value: k, label: k === '' ? 'any kind' : k }))}
          />
          <SingleSelect
            value={docStatus}
            onChange={(v) => setDocStatus(v)}
            label="Doc status filter"
            options={DOC_STATUSES.map((s) => ({ value: s.value, label: s.label }))}
          />
          {/* Hidden below two machines: a single-machine install has nothing to disambiguate. */}
          {multiMachine ? (
            <SingleSelect
              value={machine}
              onChange={(v) => setMachine(v)}
              label="First ingested from"
              options={[
                { value: '', label: 'any machine' },
                ...machines.map((m) => ({
                  value: m.name as string,
                  label: m.name === self ? `${m.name} (self)` : m.name,
                })),
              ]}
            />
          ) : null}
          {ask.turns.length > 0 ? (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                ask.reset();
              }}
              style={{
                marginLeft: 'auto',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                borderRadius: 8,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.kdb,
                backgroundColor: tint(colors.kdb, 10),
                paddingHorizontal: 10,
                paddingVertical: 7,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '600', color: colors.kdb }}>＋ New conversation</Text>
            </Pressable>
          ) : null}
        </View>

        {scopeChanged ? (
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.report, marginTop: 12 }}>
            Scope changed to “{scopeLabel}” — previous results were for a different scope and have
            been cleared.
          </Text>
        ) : null}

        {loading ? (
          <View style={{ paddingVertical: 26, alignItems: 'center' }}>
            <Pulse label="searching" />
          </View>
        ) : null}

        {error ? <ErrorCard message={error} /> : null}

        {showing === 'ask' && ask.turns.length > 0 ? (
          <ConversationNative turns={ask.turns} onRetry={ask.retry} onDelete={ask.remove} onOpenEntry={setOpenEntry} showProjects={scope.isMulti} busy={busy} composerValue={q} composerChange={setQ} onSend={runAsk} />
        ) : null}

        {!loading && showing === 'search' && result && !error ? (
          <View style={{ marginTop: 20 }}>
            {result.degraded ? <DegradedBanner mode={result.mode} /> : null}
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, marginBottom: 10 }}>
              {result.hits.length} hits · {result.mode} · {result.tookMs}ms
            </Text>
            <View style={{ gap: 6 }}>
              {result.hits.map((h) => (
                <SpineRow key={h.entryId} source={h.sourceType} onPress={() => setOpenEntry(h.entryId)}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <Badge source={h.sourceType} />
                    {scope.isMulti ? <ProjectTag slug={h.projectSlug} /> : null}
                    {multiMachine ? <MachineBadge machine={h.machine} /> : null}
                    {h.component ? (
                      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>{h.component}</Text>
                    ) : null}
                    <View style={{ flex: 1 }} />
                    {h.docStatus ? <StaleBadge hit={h} /> : null}
                    <Stamp iso={h.occurredAt} />
                  </View>
                  <Text style={{ fontWeight: '600', fontSize: 14, marginTop: 4 }}>{h.title}</Text>
                  {/* The snippet is a blind cut of a markdown body: compact mode
                      repairs mid-syntax truncation and collapses blocks. */}
                  <Markdown text={h.snippet} compact baseSize={13} />
                </SpineRow>
              ))}
              {result.hits.length === 0 ? (
                <Empty title="Nothing matched." hint="Try broader words, drop filters, or widen the scope." />
              ) : null}
            </View>
          </View>
        ) : null}

        {!result && ask.turns.length === 0 && !loading && !error && !scopeChanged ? (
          <Empty
            title={asking ? 'Ask your codebases what happened.' : 'Search everything you have built.'}
            hint={
              asking
                ? 'Try: "what were the bug fixes in video import?"'
                : 'Try: "qdrant timeout fix" — or switch to Ask for a cited answer.'
            }
          />
        ) : null}
      </ScrollView>

      <EntrySheet entryId={openEntry} onClose={() => setOpenEntry(null)} multiMachine={multiMachine} />
    </KeyboardAvoidingView>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <View
      style={{
        marginTop: 20,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tint(colors.report, 45),
        backgroundColor: tint(colors.report, 8),
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
      accessibilityRole="alert"
    >
      <Text style={{ fontSize: 13, lineHeight: 19 }}>
        <Text style={{ color: colors.report }}>Something went wrong.</Text>{' '}
        <Text style={{ color: colors.muted }}>{message}</Text>
      </Text>
    </View>
  );
}

/** Badge for stale doc hits: archived is loud, aging is informational. */
function StaleBadge({ hit }: { hit: { docStatus?: 'aging' | 'archived'; ageMonths?: number } }) {
  if (!hit.docStatus) return null;
  const archived = hit.docStatus === 'archived';
  const color = archived ? colors.report : colors.faint;
  const label = archived
    ? `archived${hit.ageMonths != null ? ` · ${hit.ageMonths} mo` : ''}`
    : `aging · ${hit.ageMonths} mo`;
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
      {label}
    </Text>
  );
}

/* -------------------------------------------------------------------------
 * Conversation rendering (web AskConversation, native form)
 * ---------------------------------------------------------------------- */

function MetricsLine({ m }: { m: import('@atlas/shared').AskMetrics }) {
  const bits: string[] = [];
  if (m.totalTokens !== undefined) bits.push(`${m.totalTokens} tok`);
  if (m.ttftMs !== undefined) bits.push(`${ms(m.ttftMs)} to first token`);
  if (m.tokensPerSec !== undefined) bits.push(`${m.tokensPerSec} tok/s`);
  return (
    <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 8 }}>
      <Text style={{ color: colors.claude }}>{m.model}</Text>
      {bits.length > 0 ? ` · ${bits.join(' · ')}` : ''}
      {m.attempts !== undefined && m.attempts > 1 ? (
        <Text style={{ color: colors.report }}> · {m.attempts} attempts</Text>
      ) : null}
    </Text>
  );
}

function ConversationNative({
  turns,
  onRetry,
  onDelete,
  onOpenEntry,
  showProjects,
  busy,
  composerValue,
  composerChange,
  onSend,
}: {
  turns: import('@atlas/shared').Turn[];
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenEntry: (entryId: number) => void;
  showProjects: boolean;
  busy: boolean;
  composerValue: string;
  composerChange: (v: string) => void;
  onSend: () => void;
}) {
  const citationsByTurn = useMemo(() => {
    const m = new Map<string, ReadonlySet<number>>();
    for (const t of turns) {
      if (t.role === 'assistant') m.set(t.id, new Set((t.sources ?? []).map((s) => s.n)));
    }
    return m;
  }, [turns]);

  return (
    <View style={{ marginTop: 22, gap: 16 }}>
      {turns.map((t) =>
        t.role === 'user' ? (
          <View key={t.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
            <View
              style={{
                flex: 1,
                backgroundColor: colors.panel2,
                borderLeftWidth: 3,
                borderLeftColor: colors.git,
                borderTopRightRadius: 8,
                borderBottomRightRadius: 8,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <Text style={{ fontSize: 14, lineHeight: 20 }}>{t.content}</Text>
            </View>
            <TurnDelete onPress={() => onDelete(t.id)} />
          </View>
        ) : (
          <View key={t.id}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
              <View
                style={{
                  flex: 1,
                  backgroundColor: colors.panel,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.line,
                  borderRadius: 8,
                  padding: 16,
                  minHeight: 48,
                }}
              >
                {t.error ? (
                  <Text style={{ fontSize: 13, color: colors.report }}>{t.error}</Text>
                ) : t.content ? (
                  <Markdown
                    text={t.content}
                    baseSize={15}
                    citations={citationsByTurn.get(t.id)}
                    onCite={() => {
                      /* Sources are listed directly under each reply on
                         mobile — tapping a citation opens its row's entry. */
                    }}
                  />
                ) : t.streaming ? (
                  <Pulse label="reading sources" />
                ) : null}
                {t.degraded && !t.error ? (
                  <Text style={{ fontFamily: fonts.mono, fontSize: 11.5, color: colors.report, marginTop: 10 }}>
                    ⚠ LLM unavailable — sources only
                  </Text>
                ) : null}

                {!t.streaming ? (
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 8 }}>
                    {t.metrics && !t.error ? <MetricsLine m={t.metrics} /> : <View />}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                      {t.content ? (
                        <Pressable
                          hitSlop={6}
                          onPress={() => {
                            void Clipboard.setStringAsync(t.content).then(() => {
                              toast('Reply copied');
                              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                            });
                          }}
                        >
                          <Text style={{ color: colors.muted, fontSize: 13 }}>⧉</Text>
                        </Pressable>
                      ) : null}
                      <Pressable hitSlop={6} onPress={() => onRetry(t.id)} accessibilityLabel="Retry this reply">
                        <Text style={{ color: colors.muted, fontSize: 13 }}>↻</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
              <TurnDelete onPress={() => onDelete(t.id)} />
            </View>

            {t.scopeFallback ? (
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.report, marginTop: 8 }}>
                ⓘ Nothing matched in “{t.scopeFallback.requested.join(', ')}” — searched all
                projects instead.
              </Text>
            ) : null}

            {t.sources && t.sources.length > 0 ? (
              <View style={{ marginTop: 8, gap: 5 }}>
                {t.sources.map((s) => (
                  <Pressable
                    key={s.n}
                    onPress={() => onOpenEntry(s.entryId)}
                    onLongPress={() => {
                      void Clipboard.setStringAsync(sourceRef(s)).then(() => toast('Source reference copied'));
                    }}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'baseline',
                      gap: 8,
                      paddingHorizontal: 4,
                      paddingVertical: 3,
                      borderRadius: 4,
                      backgroundColor: pressed ? colors.panel : 'transparent',
                    })}
                  >
                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.kdb }}>[{s.n}]</Text>
                    <Badge source={s.sourceType} />
                    {showProjects ? <ProjectTag slug={s.projectSlug} /> : null}
                    <Text numberOfLines={1} style={{ color: colors.muted, flex: 1, fontSize: 13 }}>
                      {s.title}
                    </Text>
                    <Stamp iso={s.occurredAt} />
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ),
      )}

      {/* Follow-up composer, pinned under the conversation where the reply ends. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 6 }}>
        <TextInput
          value={composerValue}
          onChangeText={composerChange}
          multiline
          placeholder="Ask a follow-up…"
          placeholderTextColor={colors.faint}
          accessibilityLabel="Ask a follow-up"
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 140,
            backgroundColor: colors.panel,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.line,
            borderRadius: 8,
            paddingHorizontal: 14,
            paddingVertical: 10,
            fontSize: 14,
            color: colors.ink,
          }}
        />
        <Pressable
          onPress={() => {
            if (!busy) onSend();
          }}
          disabled={busy || !composerValue.trim()}
          style={({ pressed }) => ({
            borderRadius: 8,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.kdb,
            backgroundColor: tint(colors.kdb, 8),
            paddingHorizontal: 16,
            paddingVertical: 11,
            opacity: busy || !composerValue.trim() ? 0.4 : pressed ? 0.85 : 1,
          })}
        >
          {busy ? <Dots size={3.5} /> : (
            <Text style={{ fontSize: 13.5, fontWeight: '600', color: colors.kdb }}>Send</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function TurnDelete({ onPress }: { onPress: () => void }) {
  return (
    <Pressable hitSlop={8} onPress={onPress} accessibilityLabel="Delete this turn" style={{ paddingVertical: 6 }}>
      <Text style={{ color: colors.muted, fontSize: 13 }}>✕</Text>
    </Pressable>
  );
}
