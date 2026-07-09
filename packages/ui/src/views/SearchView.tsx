import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AskResult, SearchResult, SourceType } from '../types';
import { Badge, Empty, SpineRow, Spinner, Stamp } from '../components/ui';
import { EntryDrawer } from '../components/EntryDrawer';

/** Search + Ask: one input, two modes. '/' focuses; Enter searches; ⌘Enter asks. */

const SOURCES: (SourceType | '')[] = [
  '', 'kdb_changelog', 'kdb_component', 'kdb_session', 'kdb_backlog',
  'kdb_report', 'claude_session', 'git_commit', 'doc',
];

/** Render [n] citations as amber superscripts. */
function Cited({ text }: { text: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <div className="whitespace-pre-wrap leading-relaxed">
      {parts.map((p, i) => {
        const m = p.match(/^\[(\d+)\]$/);
        return m ? (
          <sup key={i} className="font-mono text-[11px] px-0.5" style={{ color: 'var(--color-kdb)' }}>
            [{m[1]}]
          </sup>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </div>
  );
}

export function SearchView({
  project,
  inputRef,
  onOpenSession,
}: {
  project: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onOpenSession: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [source, setSource] = useState<SourceType | ''>('');
  const [mode, setMode] = useState<'search' | 'ask'>('search');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (kind: 'search' | 'ask') => {
      if (!q.trim()) return;
      const mySeq = ++seq.current;
      // Cancel an in-flight stream so the server stops generating for a
      // question nobody is reading any more.
      abortRef.current?.abort();
      setError('');
      setMode(kind);

      if (kind === 'search') {
        setLoading(true);
        try {
          const r = await api.search({ q, project, source, limit: 30 });
          if (seq.current === mySeq) setResult(r);
        } catch (e) {
          if (seq.current === mySeq) setError((e as Error).message);
        } finally {
          if (seq.current === mySeq) setLoading(false);
        }
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setAskResult({ answer: '', sources: [], model: '', degraded: false });
      setStreaming(true);
      try {
        const stream = api.askStream(
          { question: q, project: project || undefined },
          controller.signal,
        );
        for await (const ev of stream) {
          if (seq.current !== mySeq) return; // superseded by a newer question
          if (ev.type === 'sources') {
            setAskResult((prev) => ({ ...prev!, sources: ev.sources }));
          } else if (ev.type === 'delta') {
            setAskResult((prev) => ({ ...prev!, answer: prev!.answer + ev.text }));
          } else if (ev.type === 'done') {
            setAskResult((prev) => ({ ...prev!, model: ev.model, degraded: ev.degraded }));
          } else if (ev.type === 'error') {
            setError(ev.message);
          }
        }
      } catch (e) {
        if (seq.current === mySeq && (e as Error).name !== 'AbortError') {
          setError((e as Error).message);
        }
      } finally {
        if (seq.current === mySeq) setStreaming(false);
      }
    },
    [q, project, source],
  );

  // Abort any in-flight stream when the view unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    // Re-run an existing search when the project filter changes.
    if (result && mode === 'search' && q.trim()) void run('search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex gap-2 items-center">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(e.metaKey || e.ctrlKey ? 'ask' : 'search');
          }}
          placeholder="Search everything… (Enter = search, ⌘Enter = ask)"
          className="flex-1 bg-panel border border-line rounded-md px-4 py-3 text-[15px] placeholder:text-faint"
          aria-label="Search query"
        />
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourceType | '')}
          className="bg-panel border border-line rounded-md px-2 py-3 text-sm text-muted font-mono"
          aria-label="Source filter"
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'all sources' : s}
            </option>
          ))}
        </select>
        <button
          onClick={() => void run('search')}
          className="px-4 py-3 rounded-md bg-panel-2 border border-line text-sm hover:border-faint"
        >
          Search
        </button>
        <button
          onClick={() => void run('ask')}
          className="px-4 py-3 rounded-md text-sm font-medium border"
          style={{
            borderColor: 'var(--color-kdb)',
            color: 'var(--color-kdb)',
            background: 'color-mix(in srgb, var(--color-kdb) 8%, transparent)',
          }}
        >
          Ask
        </button>
      </div>

      {loading && <Spinner />}
      {error && <p className="font-mono text-sm py-4" style={{ color: 'var(--color-report)' }}>{error}</p>}

      {mode === 'ask' && askResult && (
        <div className="mt-6 rise">
          {askResult.degraded && (
            <p className="font-mono text-xs mb-3" style={{ color: 'var(--color-report)' }}>
              ⚠ LLM unavailable — showing retrieved sources only
            </p>
          )}
          <div className="bg-panel border border-line rounded-md p-5 min-h-[3.5rem]">
            {askResult.answer ? (
              <Cited text={askResult.answer} />
            ) : (
              <span className="font-mono text-sm text-faint">
                {streaming ? 'reading sources…' : ''}
              </span>
            )}
            {streaming && askResult.answer && (
              <span
                className="inline-block w-[7px] h-[15px] translate-y-[2px] ml-0.5 animate-pulse"
                style={{ background: 'var(--color-kdb)' }}
                aria-hidden
              />
            )}
          </div>
          <div className="mt-4 space-y-1.5">
            {askResult.sources.map((s) => (
              <button
                key={s.n}
                onClick={() => setOpenEntry(s.entryId)}
                className="w-full flex items-baseline gap-2 text-sm text-left hover:bg-panel rounded px-1 py-0.5"
              >
                <span className="font-mono text-[11px]" style={{ color: 'var(--color-kdb)' }}>
                  [{s.n}]
                </span>
                <Badge source={s.sourceType} />
                <span className="text-muted truncate">{s.title}</span>
                <Stamp iso={s.occurredAt} />
              </button>
            ))}
          </div>
        </div>
      )}

      {!loading && mode === 'search' && result && (
        <div className="mt-6">
          <p className="font-mono text-[11px] text-faint mb-3">
            {result.hits.length} hits · {result.mode}
            {result.degraded ? ' · degraded' : ''} · {result.tookMs}ms
          </p>
          <div className="space-y-1.5">
            {result.hits.map((h) => (
              <SpineRow
                key={`${h.entryId}`}
                source={h.sourceType}
                onClick={() => setOpenEntry(h.entryId)}
              >
                <div className="flex items-baseline gap-2">
                  <Badge source={h.sourceType} />
                  {h.component && (
                    <span className="font-mono text-[11px] text-muted">{h.component}</span>
                  )}
                  <span className="font-mono text-[11px] text-faint">{h.projectSlug}</span>
                  <div className="flex-1" />
                  {h.sessionId && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenSession(h.sessionId!);
                      }}
                      className="font-mono text-[10px] text-muted hover:text-ink underline underline-offset-2"
                    >
                      open session
                    </button>
                  )}
                  <Stamp iso={h.occurredAt} />
                </div>
                <div className="mt-1 font-medium text-[14px]">{h.title}</div>
                <div className="mt-0.5 text-[13px] text-muted line-clamp-2">{h.snippet}</div>
              </SpineRow>
            ))}
            {result.hits.length === 0 && (
              <Empty title="Nothing matched." hint="Try broader words, drop filters, or reindex." />
            )}
          </div>
        </div>
      )}

      {!result && !askResult && !loading && (
        <Empty
          title="Ask your codebases what happened."
          hint='Try "qdrant timeout fix", or Ask: "what were the bug fixes in video import?"'
        />
      )}

      <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} />
    </div>
  );
}
