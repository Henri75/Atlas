import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ENTRY_KIND_META as KIND } from '@atlas/shared';
import type { ProjectRow, SessionEntryKind, SessionRow } from '../types';
import { Markdown } from '../components/Markdown';
import {
  Empty,
  Eyebrow,
  FilterInput,
  Highlight,
  ModeSwitch,
  PickProject,
  Spinner,
  Stamp,
  matches,
} from '../components/ui';
import { SessionRefActions, type SessionTab } from '../components/SessionRefActions';
import { usePersistentState } from '../usePersistentState';
import { SessionFinder } from './sessions/SessionFinder';
import { SessionInsightsPanel } from './sessions/SessionInsightsPanel';
import { SessionRelatedPanel } from './sessions/SessionRelatedPanel';
import { compact, duration, exact, plural } from '../format';

const kindOf = (e: any): SessionEntryKind => (e.meta?.kind as SessionEntryKind) ?? 'response';

/** Elapsed time between two ISO stamps, or null when it cannot be known. */
function elapsed(from?: string, to?: string): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return duration(ms / 1000);
}

/** The conversation replay — unchanged behaviour, now one tab of three. */
function Conversation({ detail }: { detail: { session: SessionRow; entries: any[] } }) {
  const [q, setQ] = useState('');
  const [kinds, setKinds] = useState<Set<SessionEntryKind>>(new Set());
  const { session, entries } = detail;

  const present = useMemo(() => {
    const s = new Set<SessionEntryKind>();
    for (const e of entries) s.add(kindOf(e));
    return [...s];
  }, [entries]);

  const shown = useMemo(
    () =>
      entries.filter(
        (e) => (kinds.size === 0 || kinds.has(kindOf(e))) && matches(e.body, q),
      ),
    [entries, q, kinds],
  );

  const toggleKind = (k: SessionEntryKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  return (
    <div>
      <div className="mt-1">
        <FilterInput
          value={q}
          onChange={setQ}
          placeholder="Filter this conversation…"
          count={{ shown: shown.length, total: entries.length }}
        />
        {present.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {present.map((k) => {
              const on = kinds.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  aria-pressed={on}
                  className="font-mono text-[10px] tracking-widest px-2 py-1 rounded-sm border"
                  style={{
                    color: KIND[k].color,
                    borderColor: on ? KIND[k].color : 'var(--color-line)',
                    background: on
                      ? `color-mix(in srgb, ${KIND[k].color} 14%, transparent)`
                      : 'transparent',
                  }}
                >
                  {KIND[k].label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-3">
        {shown.map((e) => {
          const k = kindOf(e);
          return (
            <div
              key={e.id}
              className="rise border-l-[3px] px-3 py-2 rounded-r-md bg-panel"
              style={{ borderLeftColor: KIND[k].color }}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="font-mono text-[10px] tracking-widest"
                  style={{ color: KIND[k].color }}
                >
                  {KIND[k].label}
                </span>
                <Stamp iso={e.occurred_at} />
              </div>
              {/* Transcript messages are markdown — Claude writes lists, code
                  fences and bold; prompts are often pasted markdown too. The
                  filter term still highlights, but it can no longer be a React
                  wrapper: rendered markdown is injected as an HTML string, so
                  the match is spliced into the markup instead (see Markdown). */}
              <Markdown
                text={e.body}
                needle={q}
                className="mt-1 text-[13px] text-ink/90 max-h-96 overflow-y-auto"
              />
            </div>
          );
        })}
        {shown.length === 0 && (
          <Empty title="No messages match." hint="Clear the filter or pick another kind." />
        )}
      </div>

      {session.files_touched?.length > 0 && (
        <div className="mt-6">
          <Eyebrow>Files touched</Eyebrow>
          <ul className="font-mono text-[12px] text-muted space-y-0.5">
            {session.files_touched.map((f) => (
              <li key={f}>
                <Highlight text={f} needle={q} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The session detail: one conversation, three ways of reading it.
 *
 * Replay is what happened, insights are what it meant, related is where it sits
 * in the wider work. They are tabs rather than pages because they are three
 * views of ONE thing, and because moving between them must not cost a reload of
 * the conversation you were already reading.
 */
function SessionDetail({
  detail,
  tab,
  onTab,
  onBack,
  onOpenSession,
}: {
  detail: { session: SessionRow; entries: any[] };
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
  onBack: () => void;
  onOpenSession: (id: string, tab: SessionTab) => void;
}) {
  const { session, entries } = detail;
  const took = elapsed(session.started_at, session.ended_at);

  const tabs: { key: SessionTab; label: string }[] = [
    { key: 'conversation', label: 'Conversation' },
    { key: 'insights', label: 'Insights' },
    { key: 'related', label: 'Related' },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      <button onClick={onBack} className="text-sm text-muted hover:text-ink mb-4">
        ← back to sessions
      </button>

      <h2 className="font-display text-lg font-semibold leading-snug">
        {session.title ?? session.id}
      </h2>

      {/* The facts you need when scanning old work: when, how long, how much. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
        <Stamp iso={session.started_at} />
        {took && <span>· took {took}</span>}
        <span>· {plural(session.prompt_count, 'prompt')}</span>
        <span>· {plural(session.action_count ?? 0, 'action')}</span>
        <span>· {plural(entries.length, 'message')}</span>
        {session.files_touched?.length > 0 && (
          <span>· {plural(session.files_touched.length, 'file')} changed</span>
        )}
      </div>
      {session.cwd && <p className="mt-1 font-mono text-[11px] text-faint">{session.cwd}</p>}
      {session.title && session.title !== session.id && (
        <p className="mt-1 font-mono text-[10px] text-faint">{session.id}</p>
      )}

      <div className="mt-4 flex gap-1 border-b border-line" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => onTab(t.key)}
            className="px-3 py-1.5 text-[13px] border-b-2 -mb-px transition-colors"
            style={{
              color: tab === t.key ? 'var(--color-ink)' : 'var(--color-muted)',
              borderBottomColor: tab === t.key ? 'var(--color-kdb)' : 'transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === 'conversation' && <Conversation detail={detail} />}
        {tab === 'insights' && <SessionInsightsPanel sessionId={session.id} />}
        {tab === 'related' && (
          <SessionRelatedPanel
            sessionId={session.id}
            onOpenSession={(id) => onOpenSession(id, 'related')}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The sessions workspace: find one, then read it three ways.
 *
 * `Find` is the default because it is the thing you came to do, and unlike the
 * per-project browse it works without knowing where the work lived. Browse
 * stays, unchanged, for the times you do.
 */
export function SessionsView({
  project,
  projects,
  scopeProjects,
  onProject,
  openSessionId,
  onOpenSession,
  tab,
  onTab,
  inputRef,
}: {
  /** Exactly one project, or null at 0 or 2+ — the browse mode needs one. */
  project: string | null;
  projects: ProjectRow[];
  /** Every project currently in scope; the finder uses this as a filter. */
  scopeProjects: string[];
  onProject: (slug: string) => void;
  openSessionId: string;
  onOpenSession: (id: string, tab?: SessionTab) => void;
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [mode, setMode] = usePersistentState<'find' | 'browse'>('atlas.sessions.mode', 'find');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [detail, setDetail] = useState<{ session: SessionRow; entries: any[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    setSessions([]);
    setQ('');
    if (!project || mode !== 'browse') return;
    void api.sessions(project).then((r) => setSessions(r.sessions));
  }, [project, mode]);

  useEffect(() => {
    setDetail(null);
    if (!openSessionId) return;
    setLoading(true);
    void api
      .session(openSessionId)
      .then(setDetail)
      .finally(() => setLoading(false));
  }, [openSessionId]);

  const shown = useMemo(
    () => sessions.filter((s) => matches(s.title, q) || matches(s.id, q) || matches(s.cwd, q)),
    [sessions, q],
  );

  if (openSessionId) {
    if (loading) return <Spinner />;
    if (!detail) {
      return (
        <Empty
          title="That session is not indexed."
          hint="It may predate this index, or its transcript may have been removed."
        />
      );
    }
    return (
      <SessionDetail
        detail={detail}
        tab={tab}
        onTab={onTab}
        onBack={() => onOpenSession('')}
        onOpenSession={onOpenSession}
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <ModeSwitch
          value={mode}
          onChange={setMode}
          label="Session mode"
          options={[
            { value: 'find', label: 'Find', accent: true },
            { value: 'browse', label: 'Browse' },
          ]}
        />
        <span className="font-mono text-[10px] text-faint">
          {mode === 'find'
            ? 'search every indexed session'
            : 'list one project’s sessions, newest first'}
        </span>
      </div>

      {mode === 'find' ? (
        <SessionFinder
          scopeProjects={scopeProjects}
          onOpen={onOpenSession}
          inputRef={inputRef}
        />
      ) : !project ? (
        <PickProject what="Claude Code sessions" projects={projects} onProject={onProject} />
      ) : (
        <>
          <Eyebrow>Sessions — {project}</Eyebrow>
          <FilterInput
            value={q}
            onChange={setQ}
            placeholder="Filter sessions by title, id or folder…"
            count={{ shown: shown.length, total: sessions.length }}
          />
          <div className="space-y-1.5">
            {shown.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpenSession(s.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpenSession(s.id)}
                className="rise border-l-[3px] px-3 py-2.5 rounded-r-md bg-panel hover:bg-panel-2 cursor-pointer"
                style={{ borderLeftColor: 'var(--color-claude)' }}
              >
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-[11px] text-faint">{s.id.slice(0, 8)}</span>
                  <span className="text-[14px] flex-1 truncate">
                    <Highlight text={s.title ?? '(untitled session)'} needle={q} />
                  </span>
                  <span
                    className="font-mono text-[11px] text-muted whitespace-nowrap tabular-nums"
                    title={`${exact(s.prompt_count)} prompts · ${exact(s.action_count ?? 0)} actions`}
                  >
                    {compact(s.prompt_count)}p · {compact(s.action_count ?? 0)}a
                  </span>
                  <Stamp iso={s.started_at} />
                </div>
                {/* Insights and related are reachable from every place a session
                    is named, browse included — not only from search results. */}
                <div className="mt-1.5">
                  <SessionRefActions sessionId={s.id} onOpen={onOpenSession} compact />
                </div>
              </div>
            ))}
            {sessions.length === 0 && <Empty title="No sessions indexed for this project yet." />}
            {sessions.length > 0 && shown.length === 0 && (
              <Empty title="No sessions match that filter." />
            )}
          </div>
        </>
      )}
    </div>
  );
}
