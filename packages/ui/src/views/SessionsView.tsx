import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SessionRow } from '../types';
import { Empty, Eyebrow, Spinner, Stamp } from '../components/ui';

/** Session browser + replay: prompts (you) and substantial responses (ai). */
export function SessionsView({
  project,
  openSessionId,
  onOpenSession,
}: {
  project: string;
  openSessionId: string;
  onOpenSession: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [detail, setDetail] = useState<{ session: SessionRow; entries: any[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSessions([]);
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

  if (openSessionId) {
    return (
      <div className="max-w-4xl mx-auto">
        <button onClick={() => onOpenSession('')} className="text-sm text-muted hover:text-ink mb-4">
          ← back to sessions
        </button>
        {loading && <Spinner />}
        {detail && (
          <>
            <h2 className="font-display text-lg font-semibold">
              {detail.session.title ?? detail.session.id}
            </h2>
            <p className="font-mono text-[11px] text-faint mt-1">
              {detail.session.cwd} · {detail.session.prompt_count} prompts
            </p>
            <div className="mt-5 space-y-3">
              {detail.entries.map((e) => {
                const you = e.meta?.kind === 'prompt';
                return (
                  <div
                    key={e.id}
                    className="rise border-l-[3px] px-3 py-2 rounded-r-md bg-panel"
                    style={{ borderLeftColor: you ? 'var(--color-git)' : 'var(--color-claude)' }}
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className="font-mono text-[10px] tracking-widest"
                        style={{ color: you ? 'var(--color-git)' : 'var(--color-claude)' }}
                      >
                        {you ? 'YOU' : 'CLAUDE'}
                      </span>
                      <Stamp iso={e.occurred_at} />
                    </div>
                    <pre className="mt-1 text-[13px] whitespace-pre-wrap font-sans leading-relaxed text-ink/90 max-h-96 overflow-y-auto">
                      {e.body}
                    </pre>
                  </div>
                );
              })}
            </div>
            {detail.session.files_touched?.length > 0 && (
              <div className="mt-6">
                <Eyebrow>Files touched</Eyebrow>
                <ul className="font-mono text-[12px] text-muted space-y-0.5">
                  {detail.session.files_touched.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (!project) return <Empty title="Pick a project to browse its Claude Code sessions." />;

  return (
    <div className="max-w-4xl mx-auto">
      <Eyebrow>Sessions — {project}</Eyebrow>
      <div className="space-y-1.5">
        {sessions.map((s) => (
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
              <span className="text-[14px] flex-1 truncate">{s.title ?? '(untitled session)'}</span>
              <span className="font-mono text-[11px] text-muted">{s.prompt_count} prompts</span>
              <Stamp iso={s.started_at} />
            </div>
          </div>
        ))}
        {sessions.length === 0 && <Empty title="No sessions indexed for this project yet." />}
      </div>
    </div>
  );
}
