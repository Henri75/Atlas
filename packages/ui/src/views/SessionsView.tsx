import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ProjectRow, SessionEntryKind, SessionRow } from '../types';
import {
  Empty,
  Eyebrow,
  FilterInput,
  Highlight,
  PickProject,
  Spinner,
  Stamp,
  matches,
} from '../components/ui';

/** Colour and label per message kind. Actions are the "what was done" trail. */
const KIND: Record<SessionEntryKind, { label: string; color: string }> = {
  prompt: { label: 'YOU', color: 'var(--color-git)' },
  plan: { label: 'PLAN', color: 'var(--color-doc)' },
  insight: { label: 'INSIGHT', color: 'var(--color-kdb)' },
  summary: { label: 'SUMMARY', color: 'var(--color-report)' },
  action: { label: 'DID', color: 'var(--color-muted)' },
  response: { label: 'CLAUDE', color: 'var(--color-claude)' },
};

const kindOf = (e: any): SessionEntryKind => (e.meta?.kind as SessionEntryKind) ?? 'response';

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human duration between two ISO stamps. */
function duration(from?: string, to?: string): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

function SessionDetail({
  detail,
  onBack,
}: {
  detail: { session: SessionRow; entries: any[] };
  onBack: () => void;
}) {
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

  const took = duration(session.started_at, session.ended_at);

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

      <div className="mt-5">
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
              <pre className="mt-1 text-[13px] whitespace-pre-wrap font-sans leading-relaxed text-ink/90 max-h-96 overflow-y-auto">
                <Highlight text={e.body} needle={q} />
              </pre>
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

/** Session browser + replay: prompts, responses, insights and what was done. */
export function SessionsView({
  project,
  projects,
  onProject,
  openSessionId,
  onOpenSession,
}: {
  project: string;
  projects: ProjectRow[];
  onProject: (slug: string) => void;
  openSessionId: string;
  onOpenSession: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [detail, setDetail] = useState<{ session: SessionRow; entries: any[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    setSessions([]);
    setQ('');
    if (!project) return;
    void api.sessions(project).then((r) => setSessions(r.sessions));
  }, [project]);

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
    if (!detail) return <Empty title="Session not found." />;
    return <SessionDetail detail={detail} onBack={() => onOpenSession('')} />;
  }

  if (!project) {
    return <PickProject what="Claude Code sessions" projects={projects} onProject={onProject} />;
  }

  return (
    <div className="max-w-4xl mx-auto">
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
              <span className="font-mono text-[11px] text-muted whitespace-nowrap">
                {s.prompt_count}p · {s.action_count ?? 0}a
              </span>
              <Stamp iso={s.started_at} />
            </div>
          </div>
        ))}
        {sessions.length === 0 && <Empty title="No sessions indexed for this project yet." />}
        {sessions.length > 0 && shown.length === 0 && (
          <Empty title="No sessions match that filter." />
        )}
      </div>
    </div>
  );
}
