import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EntryKind, SearchResult, SourceType } from '../types';
import { Badge, DegradedBanner, Empty, SpineRow, Spinner, Stamp } from '../components/ui';
import { EntryDrawer } from '../components/EntryDrawer';
import { Conversation, useAskConversation } from './AskConversation';

/** Search + Ask: one input, two modes. '/' focuses; Enter searches; ⌘Enter asks. */

const SOURCES: (SourceType | '')[] = [
  '', 'kdb_changelog', 'kdb_component', 'kdb_session', 'kdb_backlog',
  'kdb_report', 'claude_session', 'git_commit', 'doc',
];

/** Only session entries carry a kind; the filter is offered for all sources. */
const KINDS: (EntryKind | '')[] = ['', 'prompt', 'plan', 'insight', 'summary', 'action', 'response'];

/** Doc staleness scope. Archived docs are indexed and downranked, never hidden — unless asked. */
const DOC_STATUSES: { value: '' | 'active' | 'archived'; label: string }[] = [
  { value: '', label: 'any status' },
  { value: 'active', label: 'exclude archived' },
  { value: 'archived', label: 'archived only' },
];

/** Badge for stale doc hits: archived is loud, aging is informational. */
function StaleBadge({ hit }: { hit: { docStatus?: 'aging' | 'archived'; ageMonths?: number } }) {
  if (!hit.docStatus) return null;
  const archived = hit.docStatus === 'archived';
  const color = archived ? 'var(--color-report)' : 'var(--color-faint)';
  const label = archived
    ? `archived${hit.ageMonths != null ? ` · ${hit.ageMonths} mo` : ''}`
    : `aging · ${hit.ageMonths} mo`;
  return (
    <span
      className="font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm whitespace-nowrap"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      title={
        archived
          ? 'Lives under an archive-style path (archive/, _legacy/, Previous/…). Downranked, never hidden.'
          : 'Not modified in a long time; ranked normally.'
      }
    >
      {label}
    </span>
  );
}

/**
 * Turn a fetch/HTTP failure into something the user can act on. A dead API
 * returns a full nginx HTML error page, which is useless as a message.
 */
function describeError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/^50[0-9]/.test(msg) || /bad gateway/i.test(msg)) {
    return 'The API is not reachable. Is the stack running? Try `make ps` and `make logs`.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the server. Is the stack running?';
  }
  // Strip an HTML body if one leaked through.
  return msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
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
  const [kind, setKind] = useState<EntryKind | ''>('');
  const [docStatus, setDocStatus] = useState<'' | 'active' | 'archived'>('');
  const [mode, setMode] = useState<'search' | 'ask'>('search');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scopeChanged, setScopeChanged] = useState(false);
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const seq = useRef(0);

  const ask = useAskConversation(project, setOpenEntry);
  const busy = ask.turns.some((t) => t.streaming);

  const runSearch = useCallback(async () => {
    if (!q.trim()) return;
    const mySeq = ++seq.current;
    setMode('search');
    setError('');
    setScopeChanged(false);
    setLoading(true);
    try {
      const r = await api.search({ q, project, source, kind, docStatus, limit: 30 });
      if (seq.current === mySeq) setResult(r);
    } catch (e) {
      if (seq.current === mySeq) {
        setResult(null);
        setError(describeError(e));
      }
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }, [q, project, source, kind, docStatus]);

  const runAsk = useCallback(() => {
    if (!q.trim() || busy) return;
    setMode('ask');
    setError('');
    setScopeChanged(false);
    ask.send(q.trim());
    setQ('');
  }, [q, busy, ask]);

  /**
   * Changing the project changes what any answer *means*: its citations point
   * at entries from the old scope. Keeping them on screen is worse than
   * clearing, so drop the results and say why rather than leave the user
   * wondering whether the panel refreshed.
   */
  const first = useRef(true);
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
  }, [project]);

  const scopeLabel = project || 'all projects';

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex gap-2 items-center">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.metaKey || e.ctrlKey ? runAsk() : void runSearch();
          }}
          placeholder={
            ask.turns.length
              ? 'Ask a follow-up… (⌘Enter)'
              : 'Search everything… (Enter = search, ⌘Enter = ask)'
          }
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
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as EntryKind | '')}
          className="bg-panel border border-line rounded-md px-2 py-3 text-sm text-muted font-mono"
          aria-label="Message kind filter"
          title="Session messages are classified: insights, plans, summaries, actions…"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k === '' ? 'any kind' : k}
            </option>
          ))}
        </select>
        <select
          value={docStatus}
          onChange={(e) => setDocStatus(e.target.value as '' | 'active' | 'archived')}
          className="bg-panel border border-line rounded-md px-2 py-3 text-sm text-muted font-mono"
          aria-label="Doc status filter"
          title="Docs under archive-style paths are downranked by default; exclude or target them here."
        >
          {DOC_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => void runSearch()}
          className="px-4 py-3 rounded-md bg-panel-2 border border-line text-sm hover:border-faint"
        >
          Search
        </button>
        <button
          onClick={runAsk}
          disabled={busy}
          className="px-4 py-3 rounded-md text-sm font-medium border disabled:opacity-50"
          style={{
            borderColor: 'var(--color-kdb)',
            color: 'var(--color-kdb)',
            background: 'color-mix(in srgb, var(--color-kdb) 8%, transparent)',
          }}
        >
          {ask.turns.length ? 'Follow up' : 'Ask'}
        </button>
      </div>

      {/* Always say what is being searched — the sidebar selection is easy to lose. */}
      <div className="mt-2 flex items-center gap-3 font-mono text-[11px] text-faint">
        <span>
          scope: <span className="text-muted">{scopeLabel}</span>
          {source && <span className="text-muted"> · {source}</span>}
          {kind && <span className="text-muted"> · {kind}</span>}
          {docStatus && (
            <span className="text-muted">
              {' '}
              · {DOC_STATUSES.find((s) => s.value === docStatus)?.label}
            </span>
          )}
        </span>
        {ask.turns.length > 0 && (
          <button onClick={ask.reset} className="text-muted hover:text-ink underline underline-offset-2">
            new conversation
          </button>
        )}
      </div>

      {scopeChanged && (
        <p className="mt-3 font-mono text-[11px]" style={{ color: 'var(--color-report)' }}>
          Project changed to “{scopeLabel}” — previous results were for a different scope and have
          been cleared. Ask or search again.
        </p>
      )}

      {loading && <Spinner />}
      {error && (
        <div
          role="alert"
          className="mt-6 rounded-md border px-4 py-3 text-[13px] leading-relaxed"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-report) 45%, transparent)',
            background: 'color-mix(in srgb, var(--color-report) 8%, transparent)',
          }}
        >
          <span style={{ color: 'var(--color-report)' }}>Something went wrong.</span>{' '}
          <span className="text-muted">{error}</span>
        </div>
      )}

      {mode === 'ask' && ask.turns.length > 0 && (
        <Conversation
          turns={ask.turns}
          onRetry={ask.retry}
          onDelete={ask.remove}
          onOpenEntry={setOpenEntry}
        />
      )}

      {!loading && mode === 'search' && result && !error && (
        <div className="mt-6">
          {result.degraded && <DegradedBanner mode={result.mode} />}
          <p className="font-mono text-[11px] text-faint mb-3">
            {result.hits.length} hits · {result.mode} · {result.tookMs}ms
          </p>
          <div className="space-y-1.5">
            {result.hits.map((h) => (
              <SpineRow key={`${h.entryId}`} source={h.sourceType} onClick={() => setOpenEntry(h.entryId)}>
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
                  <StaleBadge hit={h} />
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

      {!result && ask.turns.length === 0 && !loading && !error && !scopeChanged && (
        <Empty
          title="Ask your codebases what happened."
          hint='Try "qdrant timeout fix", or Ask: "what were the bug fixes in video import?"'
        />
      )}

      <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} />
    </div>
  );
}
