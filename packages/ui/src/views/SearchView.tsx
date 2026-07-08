import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AskResult, SearchResult, SourceType } from '../types';
import { Badge, Empty, SpineRow, Spinner, Stamp } from '../components/ui';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const run = useCallback(
    async (kind: 'search' | 'ask') => {
      if (!q.trim()) return;
      const mySeq = ++seq.current;
      setLoading(true);
      setError('');
      setMode(kind);
      try {
        if (kind === 'search') {
          const r = await api.search({ q, project, source, limit: 30 });
          if (seq.current === mySeq) setResult(r);
        } else {
          setAskResult(null);
          const r = await api.ask({ question: q, project: project || undefined });
          if (seq.current === mySeq) setAskResult(r);
        }
      } catch (e) {
        if (seq.current === mySeq) setError((e as Error).message);
      } finally {
        if (seq.current === mySeq) setLoading(false);
      }
    },
    [q, project, source],
  );

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
      {error && <p className="text-report font-mono text-sm py-4" style={{ color: 'var(--color-report)' }}>{error}</p>}

      {!loading && mode === 'ask' && askResult && (
        <div className="mt-6 rise">
          {askResult.degraded && (
            <p className="font-mono text-xs mb-3" style={{ color: 'var(--color-report)' }}>
              ⚠ LLM unavailable — showing retrieved sources only
            </p>
          )}
          <div className="bg-panel border border-line rounded-md p-5">
            <Cited text={askResult.answer} />
          </div>
          <div className="mt-4 space-y-1.5">
            {askResult.sources.map((s) => (
              <div key={s.n} className="flex items-baseline gap-2 text-sm">
                <span className="font-mono text-[11px]" style={{ color: 'var(--color-kdb)' }}>
                  [{s.n}]
                </span>
                <Badge source={s.sourceType} />
                <span className="text-muted truncate">{s.title}</span>
                <Stamp iso={s.occurredAt} />
              </div>
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
                onClick={h.sessionId ? () => onOpenSession(h.sessionId!) : undefined}
              >
                <div className="flex items-baseline gap-2">
                  <Badge source={h.sourceType} />
                  {h.component && (
                    <span className="font-mono text-[11px] text-muted">{h.component}</span>
                  )}
                  <span className="font-mono text-[11px] text-faint">{h.projectSlug}</span>
                  <div className="flex-1" />
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
    </div>
  );
}
