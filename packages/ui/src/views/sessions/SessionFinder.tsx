import { useEffect, useRef, useState } from 'react';
import type { SessionSearchResponse } from '@atlas/shared';
import { api } from '../../api';
import { DegradedBanner, Empty, Pulse, submitOnEnter } from '../../components/ui';
import type { SessionTab } from '../../components/SessionRefActions';
import { SessionCardRow } from './SessionCardRow';

/**
 * "I remember doing this — which session was it?"
 *
 * Deliberately NOT scoped to a project. The old Sessions view made you pick one
 * first, which is fine for browsing and fatal for finding: the whole premise
 * here is that you remember the work, not where it lived. Scope is a filter
 * that narrows results, never a gate that blocks the question.
 */
export function SessionFinder({
  scopeProjects,
  machine,
  onOpen,
  inputRef,
}: {
  scopeProjects: string[];
  machine?: string;
  onOpen: (id: string, tab: SessionTab) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<SessionSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Guards against a slow earlier query landing after a faster later one and
  // overwriting it with stale results.
  const seq = useRef(0);

  const run = (text: string) => {
    const query = text.trim();
    if (!query) return;
    const mine = ++seq.current;
    setSubmitted(query);
    setLoading(true);
    setError('');
    api
      .findSessions({
        q: query,
        ...(scopeProjects.length ? { projects: scopeProjects.join(',') } : {}),
        ...(machine ? { machine } : {}),
        limit: 25,
      })
      .then((r) => {
        if (mine === seq.current) setResult(r);
      })
      .catch((e: Error) => {
        if (mine === seq.current) setError(e.message);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  };

  // Re-run when the scope changes, so the visible results always match the
  // scope bar rather than silently describing a different one.
  useEffect(() => {
    if (submitted) run(submitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProjects.join(','), machine]);

  return (
    <div>
      <div className="relative">
        <textarea
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={submitOnEnter(() => run(q))}
          rows={2}
          aria-label="Find a session"
          placeholder="Describe the work, paste a session id, or name a file…"
          className="w-full resize-none rounded-md bg-panel border border-line px-3 py-2.5 text-[14px] focus:outline-none focus:border-[var(--color-kdb)]"
        />
        <div className="mt-1.5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => run(q)}
            disabled={!q.trim()}
            className="rounded px-3 py-1 text-[13px] font-medium disabled:opacity-40"
            style={{ background: 'var(--color-kdb)', color: 'var(--color-bg)' }}
          >
            Find
          </button>
          <span className="font-mono text-[10px] text-faint">
            searches every project unless the scope bar narrows it
          </span>
          <div className="flex-1" />
          {loading && <Pulse label="searching" />}
        </div>
      </div>

      {error && <Empty title="Search failed." hint={error} />}

      {result && !error && (
        <div className="mt-5">
          {result.degraded && <DegradedBanner mode={result.mode} />}
          <p className="font-mono text-[11px] text-faint mb-2">
            {result.sessions.length} session{result.sessions.length === 1 ? '' : 's'} ·{' '}
            {result.tookMs} ms
            {result.interpreted?.since && (
              <>
                {' '}
                · read a date from your query and narrowed to{' '}
                {result.interpreted.since.slice(0, 10)}
                {result.interpreted.until ? ` – ${result.interpreted.until.slice(0, 10)}` : ''}
              </>
            )}
          </p>
          <div className="space-y-1.5">
            {result.sessions.map((s) => (
              <SessionCardRow
                key={s.sessionId}
                card={s}
                needle={submitted}
                showProject
                showMachine={!!s.machine && !!machine}
                onOpen={onOpen}
              />
            ))}
          </div>
          {result.sessions.length === 0 && (
            <Empty
              title="No session matches that."
              hint="Try fewer words, a file name, or widen the scope — a feature often lives under a project slug you would not guess."
            />
          )}
        </div>
      )}

      {!result && !loading && !error && (
        <div className="mt-8">
          <Empty
            title="Find a session by what you remember about it."
            hint="A phrase from the conversation, a file it touched, a project name, or a session id."
          />
        </div>
      )}
    </div>
  );
}
