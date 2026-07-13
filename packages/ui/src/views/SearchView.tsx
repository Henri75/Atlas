import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EntryKind, SearchResult, SourceType } from '../types';
import type { Scope } from '../useScope';
import { scopeParam } from '../useScope';
import {
  Badge,
  DegradedBanner,
  Empty,
  ModeSwitch,
  MultiSelect,
  ProjectTag,
  SpineRow,
  Spinner,
  Stamp,
} from '../components/ui';
import { EntryDrawer } from '../components/EntryDrawer';
import { Markdown } from '../components/Markdown';
import { AskComposer, Conversation, useAskConversation } from './AskConversation';

/**
 * Search and Ask: one instrument, two modes.
 *
 * They used to be twin submit buttons on a shared box, distinguished only by a
 * modifier key. But they produce different *surfaces* — a list of records you
 * browse, or a synthesized answer that opens a conversation — so the mode is now
 * an explicit, visible state of the input rather than a second button competing
 * with the first.
 */

type Mode = 'search' | 'ask';

const SOURCES: SourceType[] = [
  'kdb_changelog', 'kdb_component', 'kdb_session', 'kdb_backlog',
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
  scope,
  inputRef,
  onOpenSession,
}: {
  scope: Scope;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onOpenSession: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('search');
  // A subset of source types; empty means all. Sent to the API as a
  // comma-separated `source` param that parses back to sourceType(s).
  const [sources, setSources] = useState<SourceType[]>([]);
  const [kind, setKind] = useState<EntryKind | ''>('');
  const [docStatus, setDocStatus] = useState<'' | 'active' | 'archived'>('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [showing, setShowing] = useState<Mode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scopeChanged, setScopeChanged] = useState(false);
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const seq = useRef(0);

  const ask = useAskConversation(scope.projects, setOpenEntry, sources);
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
        q,
        project: scopeParam(scope.projects),
        source: sources.join(','),
        kind,
        docStatus,
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
  }, [q, scope.projects, sources, kind, docStatus]);

  const runAsk = useCallback(() => {
    if (!q.trim() || busy) return;
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

  /**
   * Changing the scope changes what any answer *means*: its citations point at
   * entries from the old scope. Keeping them on screen is worse than clearing,
   * so drop the results and say why rather than leave the user wondering whether
   * the panel refreshed.
   */
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
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <ModeSwitch<Mode>
          value={mode}
          onChange={setMode}
          label="Search or ask"
          options={[
            { value: 'search', label: 'Search', icon: '⌕' },
            { value: 'ask', label: 'Ask', icon: '✦', accent: true },
          ]}
        />
        <p className="font-mono text-[11px] text-faint">
          {asking ? 'a cited answer, synthesized from your projects' : 'browse matching records'}
        </p>
      </div>

      <div className="mt-2.5 flex gap-2 items-center">
        <div
          className="flex-1 flex items-center gap-2 rounded-md border px-4 py-3"
          style={
            asking
              ? {
                  // The armed mode is legible before a word is typed.
                  borderColor: 'color-mix(in srgb, var(--color-kdb) 50%, transparent)',
                  background: 'color-mix(in srgb, var(--color-kdb) 4%, var(--color-panel))',
                }
              : { borderColor: 'var(--color-line)', background: 'var(--color-panel)' }
          }
        >
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={
              asking
                ? ask.turns.length
                  ? 'Ask a follow-up…'
                  : `Ask about ${scopeLabel}…`
                : `Search ${scopeLabel}…`
            }
            className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-faint"
            aria-label={asking ? 'Ask a question' : 'Search query'}
          />
          <kbd className="font-mono text-[10px] text-faint border border-line rounded px-1.5 py-0.5">
            ↵
          </kbd>
        </div>
        <button
          onClick={submit}
          disabled={asking && busy}
          className="px-4 py-3 rounded-md text-sm font-medium border disabled:opacity-50 whitespace-nowrap"
          style={
            asking
              ? {
                  borderColor: 'var(--color-kdb)',
                  color: 'var(--color-kdb)',
                  background: 'color-mix(in srgb, var(--color-kdb) 8%, transparent)',
                }
              : { borderColor: 'var(--color-line)', background: 'var(--color-panel-2)' }
          }
        >
          {asking ? (ask.turns.length ? 'Follow up' : 'Ask') : 'Search'}
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        <MultiSelect
          options={SOURCES}
          selected={sources}
          onChange={setSources}
          allLabel="all sources"
          label="Source filter"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as EntryKind | '')}
          className="bg-panel border border-line rounded-md px-2 py-2 text-sm text-muted font-mono"
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
          className="bg-panel border border-line rounded-md px-2 py-2 text-sm text-muted font-mono"
          aria-label="Doc status filter"
          title="Docs under archive-style paths are downranked by default; exclude or target them here."
        >
          {DOC_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {ask.turns.length > 0 && (
          <button
            onClick={ask.reset}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-medium hover:brightness-110"
            style={{
              borderColor: 'var(--color-kdb)',
              color: 'var(--color-kdb)',
              background: 'color-mix(in srgb, var(--color-kdb) 10%, transparent)',
            }}
          >
            ＋ New conversation
          </button>
        )}
      </div>

      {scopeChanged && (
        <p className="mt-3 font-mono text-[11px]" style={{ color: 'var(--color-report)' }}>
          Scope changed to “{scopeLabel}” — previous results were for a different scope and have
          been cleared. Ask or search again.
        </p>
      )}

      {loading && <Spinner label="searching" />}
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

      {showing === 'ask' && ask.turns.length > 0 && (
        <>
          <Conversation
            turns={ask.turns}
            onRetry={ask.retry}
            onDelete={ask.remove}
            onOpenEntry={setOpenEntry}
            showProjects={scope.isMulti}
          />
          <AskComposer
            value={q}
            onChange={setQ}
            onSend={runAsk}
            busy={busy}
            autoFocusKey={ask.turns.length}
          />
        </>
      )}

      {!loading && showing === 'search' && result && !error && (
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
                  {/* Where a hit came from only matters when the scope can span
                      projects; in a single-project view it is noise on every row. */}
                  {scope.isMulti && <ProjectTag slug={h.projectSlug} />}
                  {h.component && (
                    <span className="font-mono text-[11px] text-muted">{h.component}</span>
                  )}
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
                {/* The snippet is a blind 280-char cut of a markdown body, so it
                    renders `compact`: structure shows (bold, bullets), but every
                    block collapses to body size and zero margin so the row stays
                    two lines and the clamp keeps working. Markdown cut mid-syntax
                    is repaired before parsing — otherwise a dangling `**` renders
                    as the asterisks we are trying to get rid of. */}
                <Markdown
                  text={h.snippet}
                  compact
                  className="mt-0.5 text-[13px] text-muted line-clamp-2"
                />
              </SpineRow>
            ))}
            {result.hits.length === 0 && (
              <Empty title="Nothing matched." hint="Try broader words, drop filters, or widen the scope." />
            )}
          </div>
        </div>
      )}

      {!result && ask.turns.length === 0 && !loading && !error && !scopeChanged && (
        <Empty
          title={asking ? 'Ask your codebases what happened.' : 'Search everything you have built.'}
          hint={
            asking
              ? 'Try: "what were the bug fixes in video import?"'
              : 'Try: "qdrant timeout fix" — or switch to Ask for a cited answer.'
          }
        />
      )}

      <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} />
    </div>
  );
}
