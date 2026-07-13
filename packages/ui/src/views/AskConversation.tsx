import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { AskMetrics, AskSource, ScopeFallback, SourceType } from '../types';
import { Badge, CopyButton, ProjectTag, Pulse, Stamp } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { ExportButtons, type Exportable } from '../components/ExportReply';

/**
 * Multi-turn Ask. Each turn is addressable, so a reply can be retried and any
 * turn deleted. The history sent to the LLM is derived by slicing the
 * conversation *above* the question being answered — a retry must not see the
 * answer it is replacing, and a deletion must not leave a dangling reference.
 */

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Assistant turns only. */
  sources?: AskSource[];
  streaming?: boolean;
  error?: string;
  degraded?: boolean;
  /**
   * Set when *every* asked-for project was empty and the search widened to all.
   * Imported rather than redeclared: an inline copy of the shape here let the UI
   * keep typechecking against a stale contract after core changed it.
   */
  scopeFallback?: ScopeFallback;
  /** What it cost to produce this reply. Absent when the LLM never answered. */
  metrics?: AskMetrics;
}

/**
 * Everything `run()` derives for a single attempt. Retrying an answer must reset
 * *all* of it: leaving `degraded` behind from a failed attempt made the
 * "LLM unavailable" banner reappear on a successful retry, because the banner
 * renders on `degraded && !error` and the retry had just cleared `error`.
 */
const EMPTY_RESULT = {
  content: '',
  sources: [],
  error: undefined,
  degraded: false,
  scopeFallback: undefined,
  metrics: undefined,
} satisfies Partial<Turn>;

let seq = 0;
const newId = () => `t${++seq}`;

/** A one-line, paste-ready reference for a cited source. */
function sourceRef(s: AskSource): string {
  const date = s.occurredAt ? ` (${s.occurredAt.slice(0, 10)})` : '';
  return `[${s.n}] ${s.title} — ${s.projectSlug}/${s.sourceType}${date}\n${s.sourcePath}`;
}

export function useAskConversation(
  /** The scoped projects. Empty means all — the API treats it as unconstrained. */
  projects: string[],
  onOpenEntry: (id: number) => void,
  sources: SourceType[] = [],
) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  // Read at send time so the callbacks don't churn on every filter change and
  // don't capture a stale source list. `projects` is an array — a new identity
  // on every parent render — so depending on it directly would rebuild `run`
  // (and every callback derived from it) constantly. Reading through a ref also
  // means an in-flight answer keeps the scope it *started* with.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  // Mirrors `turns` so send/retry can read the current conversation without
  // doing side effects inside a state updater (which StrictMode runs twice).
  const turnsRef = useRef<Turn[]>([]);

  const commit = useCallback((next: Turn[] | ((prev: Turn[]) => Turn[])) => {
    setTurns((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      turnsRef.current = value;
      return value;
    });
  }, []);

  const patch = useCallback(
    (id: string, up: Partial<Turn>) =>
      commit((prev) => prev.map((t) => (t.id === id ? { ...t, ...up } : t))),
    [commit],
  );

  /** Ask `question`, appending its answer after `history` (exclusive). */
  const run = useCallback(
    async (question: string, history: Turn[], answerId: string) => {
      const myRun = ++runRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Clear every trace of the previous attempt, not just the visible text —
      // a stale `degraded` used to resurrect the "LLM unavailable" banner here.
      patch(answerId, { ...EMPTY_RESULT, streaming: true });

      try {
        const stream = api.askStream(
          {
            question,
            // A list on the wire; omitted entirely when the scope is "all", so
            // the API applies no project constraint at all.
            project: projectsRef.current.length ? projectsRef.current : undefined,
            source: sourcesRef.current.length ? sourcesRef.current : undefined,
            history: history.map((t) => ({ role: t.role, content: t.content })),
          },
          controller.signal,
        );
        for await (const ev of stream) {
          if (runRef.current !== myRun) break;
          if (ev.type === 'sources')
            patch(answerId, { sources: ev.sources, scopeFallback: ev.scopeFallback });
          else if (ev.type === 'delta') {
            commit((prev) =>
              prev.map((t) => (t.id === answerId ? { ...t, content: t.content + ev.text } : t)),
            );
          } else if (ev.type === 'done')
            patch(answerId, { degraded: ev.degraded, metrics: ev.metrics });
          else if (ev.type === 'error') patch(answerId, { error: ev.message });
        }
      } catch (e) {
        const err = e as Error;
        if (runRef.current === myRun && err.name !== 'AbortError') {
          patch(answerId, { error: describeError(err) });
        }
      } finally {
        if (runRef.current === myRun) patch(answerId, { streaming: false });
      }
    },
    // Everything mutable is read through a ref at send time, so `run` is stable
    // for the life of the hook. `patch`/`commit` are themselves stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, commit],
  );

  const send = useCallback(
    (question: string) => {
      const history = turnsRef.current;
      const q: Turn = { id: newId(), role: 'user', content: question };
      const a: Turn = { id: newId(), role: 'assistant', content: '', streaming: true };
      commit([...history, q, a]);
      void run(question, history, a.id);
    },
    [commit, run],
  );

  /** Re-answer the question above this reply, using only what preceded it. */
  const retry = useCallback(
    (answerId: string) => {
      const prev = turnsRef.current;
      const at = prev.findIndex((t) => t.id === answerId);
      if (at < 1) return;
      const question = prev[at - 1]!;
      if (question.role !== 'user') return;
      // History stops *before* the question, so the retry never sees the reply
      // it is replacing.
      void run(question.content, prev.slice(0, at - 1), answerId);
    },
    [run],
  );

  /** Delete one turn. A user turn takes its orphaned reply with it. */
  const remove = useCallback(
    (id: string) => {
      commit((prev) => {
        const at = prev.findIndex((t) => t.id === id);
        if (at === -1) return prev;
        const drop = new Set([id]);
        const next = prev[at + 1];
        if (prev[at]!.role === 'user' && next?.role === 'assistant') drop.add(next.id);
        return prev.filter((t) => !drop.has(t.id));
      });
    },
    [commit],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    runRef.current++;
    commit([]);
  }, [commit]);

  return { turns, send, retry, remove, reset, onOpenEntry };
}

function describeError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/^50[0-9]/.test(msg) || /bad gateway/i.test(msg)) {
    return 'The API is not reachable. Is the stack running?';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the server. Is the stack running?';
  }
  return msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Millisecond durations read better at human scale: 412ms, 1.4s. */
function ms(v: number): string {
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`;
}

/**
 * What produced this answer, stated as fact.
 *
 * The model shown is the one the gateway *served*, not the one config asked for:
 * G2P routes by policy and substitutes freely, so the configured name would
 * attribute the answer to a model that never saw the question. Substitution is
 * normal and therefore not flagged — a warning that fires on every reply is
 * noise. `attempts > 1` *is* worth surfacing (the gateway failed over), so it
 * rides along in the tooltip with the request id.
 */
function Metrics({ m }: { m: AskMetrics }) {
  const bits: string[] = [];
  if (m.totalTokens !== undefined) bits.push(`${m.totalTokens} tok`);
  if (m.ttftMs !== undefined) bits.push(`${ms(m.ttftMs)} to first token`);
  if (m.tokensPerSec !== undefined) bits.push(`${m.tokensPerSec} tok/s`);

  const detail = [
    m.promptTokens !== undefined && `prompt ${m.promptTokens} · completion ${m.completionTokens}`,
    m.totalMs !== undefined && `total ${ms(m.totalMs)}`,
    m.attempts !== undefined && m.attempts > 1 && `${m.attempts} gateway attempts`,
    m.requestId && `request ${m.requestId}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <p className="font-mono text-[10px] text-faint mt-2 flex items-center gap-1.5" title={detail}>
      <span style={{ color: 'var(--color-claude)' }}>{m.model}</span>
      {bits.length > 0 && <span>· {bits.join(' · ')}</span>}
      {m.attempts !== undefined && m.attempts > 1 && (
        <span style={{ color: 'var(--color-report)' }}>· {m.attempts} attempts</span>
      )}
    </p>
  );
}

/** The floating card shown while a [n] marker is hovered or focused. */
function CitePeek({
  source,
  at,
}: {
  source: AskSource;
  at: { x: number; y: number };
}) {
  return (
    <div
      role="tooltip"
      className="fixed z-50 max-w-md -translate-x-1/2 -translate-y-full pointer-events-none rise"
      style={{ left: at.x, top: at.y - 8 }}
    >
      <div className="rounded-md border border-line bg-panel-2 px-3 py-2 shadow-lg">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px]" style={{ color: 'var(--color-kdb)' }}>
            [{source.n}]
          </span>
          <Badge source={source.sourceType} />
          <Stamp iso={source.occurredAt} />
        </div>
        <div className="mt-1 text-[13px] text-ink">{source.title}</div>
        <div className="mt-0.5 font-mono text-[10px] text-faint break-all">
          {source.projectSlug} · {source.sourcePath}
        </div>
      </div>
    </div>
  );
}

export function Conversation({
  turns,
  onRetry,
  onDelete,
  onOpenEntry,
  /** Tag each cited source with its project — only meaningful across a multi-scope. */
  showProjects = false,
}: {
  turns: Turn[];
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenEntry: (entryId: number) => void;
  showProjects?: boolean;
}) {
  const citations = useCitationSets(turns);
  // Which [n] is being hovered, and where to float its card.
  const [peek, setPeek] = useState<{ turnId: string; n: number; at: { x: number; y: number } } | null>(
    null,
  );
  // The source row a citation jumped to, flashed briefly so the eye can find it
  // — scrolling something into view without marking it leaves the user hunting.
  const [flash, setFlash] = useState<string>('');

  const jumpToSource = (turnId: string, n: number) => {
    const el = document.getElementById(`src-${turnId}-${n}`);
    if (!el) return;
    // The peek card is position:fixed at the marker's old viewport coordinates.
    // Once the user commits to jumping, the preview has done its job — leaving it
    // pinned mid-air while the page scrolls under it just looks broken.
    setPeek(null);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(`${turnId}-${n}`);
    setTimeout(() => setFlash(''), 1600);
  };

  const peeked = peek && turns.find((t) => t.id === peek.turnId)?.sources?.find((s) => s.n === peek.n);

  return (
    <div className="mt-6 space-y-4">
      {turns.map((t) =>
        t.role === 'user' ? (
          <div key={t.id} className="group flex items-start gap-2">
            <div
              className="flex-1 rounded-md border border-line bg-panel-2 px-4 py-2.5 text-[14px]"
              style={{ borderLeftColor: 'var(--color-git)', borderLeftWidth: 3 }}
            >
              {t.content}
            </div>
            <TurnActions onDelete={() => onDelete(t.id)} />
          </div>
        ) : (
          <div key={t.id} className="group">
            <div className="flex items-start gap-2">
              <div className="flex-1 bg-panel border border-line rounded-md p-5 min-h-[3rem]">
                {t.error ? (
                  <p className="text-[13px]" style={{ color: 'var(--color-report)' }}>
                    {t.error}
                  </p>
                ) : t.content ? (
                  <Markdown
                    text={t.content}
                    // The answer is the thing you sit and read, so it keeps the
                    // generous reading size. (.kdb-md inherits its size now, so
                    // the caller says how big its markdown is.)
                    className="text-[15px]"
                    citations={citations.get(t.id)}
                    onCite={(n) => jumpToSource(t.id, n)}
                    onCitePeek={(n, at) =>
                      setPeek(n === null || !at ? null : { turnId: t.id, n, at })
                    }
                  />
                ) : (
                  // Before the first token there is nothing to show but the
                  // wait itself — so show that it is *alive*, not just pending.
                  t.streaming && <Pulse label="reading sources" />
                )}
                {t.streaming && t.content && (
                  <span
                    className="caret inline-block w-[7px] h-[15px] translate-y-[2px] ml-0.5"
                    style={{ background: 'var(--color-kdb)' }}
                    aria-hidden
                  />
                )}
                {t.degraded && !t.error && (
                  <p className="font-mono text-xs mt-3" style={{ color: 'var(--color-report)' }}>
                    ⚠ LLM unavailable — sources only
                  </p>
                )}

                {/* Footer: what produced the answer on the left, what you can do
                    with it on the right. Both belong to the reply, so both live
                    inside its card. */}
                {!t.streaming && (
                  <div className="mt-2 flex items-end justify-between gap-4">
                    {t.metrics && !t.error ? <Metrics m={t.metrics} /> : <span />}
                    <ReplyToolbar
                      onRetry={() => onRetry(t.id)}
                      copyText={t.content || undefined}
                      exportable={
                        t.content && !t.error
                          ? {
                              question: questionFor(turns, t.id),
                              content: t.content,
                              sources: t.sources,
                            }
                          : undefined
                      }
                    />
                  </div>
                )}
              </div>
              {/* Delete acts on the turn, not on its content, so it stays in the
                  gutter with the question's own delete control. */}
              <TurnActions onDelete={() => onDelete(t.id)} />
            </div>

            {t.scopeFallback && (
              <p className="font-mono text-xs mt-2" style={{ color: 'var(--color-report)' }}>
                ⓘ Nothing matched in <b>{t.scopeFallback.requested.join(', ')}</b> — searched all
                projects instead.
              </p>
            )}

            {t.sources && t.sources.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {t.sources.map((s) => (
                  // A row is not itself a <button> (it holds a nested copy
                  // button — invalid to nest). The title area is the click target.
                  <div
                    key={s.n}
                    id={`src-${t.id}-${s.n}`}
                    className={`group/src flex items-baseline gap-2 text-sm rounded px-1 py-0.5 transition-colors ${
                      flash === `${t.id}-${s.n}` ? 'cite-flash' : 'hover:bg-panel'
                    }`}
                  >
                    <button
                      onClick={() => onOpenEntry(s.entryId)}
                      className="flex-1 min-w-0 flex items-baseline gap-2 text-left"
                    >
                      <span className="font-mono text-[11px]" style={{ color: 'var(--color-kdb)' }}>
                        [{s.n}]
                      </span>
                      <Badge source={s.sourceType} />
                      {showProjects && <ProjectTag slug={s.projectSlug} />}
                      <span className="text-muted truncate">{s.title}</span>
                      <Stamp iso={s.occurredAt} />
                    </button>
                    <CopyButton
                      text={sourceRef(s)}
                      title="Copy source reference"
                      className="opacity-0 group-hover/src:opacity-100 focus:opacity-100 transition-opacity"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ),
      )}
      {peeked && peek && <CitePeek source={peeked} at={peek.at} />}
    </div>
  );
}

/**
 * The citation numbers each reply actually has sources for, keyed by turn.
 *
 * Built once per turns-change rather than inline per render: a fresh Set on
 * every render is a new prop identity, which would defeat Markdown's memo and
 * rebuild the answer's DOM continuously.
 */
function useCitationSets(turns: Turn[]): Map<string, ReadonlySet<number>> {
  return useMemo(() => {
    const m = new Map<string, ReadonlySet<number>>();
    for (const t of turns) {
      if (t.role === 'assistant') m.set(t.id, new Set((t.sources ?? []).map((s) => s.n)));
    }
    return m;
  }, [turns]);
}

/** The user turn immediately above an answer — its question, for the export. */
function questionFor(turns: Turn[], answerId: string): string | undefined {
  const at = turns.findIndex((t) => t.id === answerId);
  const prev = at > 0 ? turns[at - 1] : undefined;
  return prev?.role === 'user' ? prev.content : undefined;
}

/**
 * The reply's own toolbar, sitting in its footer next to the metrics.
 *
 * Copy/export/retry belong *to the answer*, so they live inside its card rather
 * than in the narrow gutter beside it: five controls stacked in that column read
 * as a jumble, and the labelled ones ("md", "pdf") never fit the icon rhythm of
 * the rest. Delete stays in the gutter — it acts on the turn, not the content.
 */
function ReplyToolbar({
  onRetry,
  copyText,
  exportable,
}: {
  onRetry?: () => void;
  copyText?: string;
  exportable?: Exportable;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      {copyText && <CopyButton text={copyText} title="Copy reply" />}
      {exportable && <ExportButtons reply={exportable} />}
      {onRetry && (
        <button
          onClick={onRetry}
          title="Ask again"
          aria-label="Retry this reply"
          className="text-muted hover:text-ink text-[13px] leading-none px-1"
        >
          ↻
        </button>
      )}
    </div>
  );
}

/** Removing a turn — the one action that is about the turn, not its content. */
function TurnActions({ onDelete }: { onDelete: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button
        onClick={onDelete}
        title="Remove from conversation"
        aria-label="Delete this turn"
        className="text-muted hover:text-ink text-[13px] leading-none px-1"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Follow-up composer, sitting under the conversation where the reply ends.
 *
 * It shares one text value with the top search bar rather than holding its own:
 * two independent inputs let half-typed text sit forgotten in the off-screen one
 * and get sent by accident. Autofocused when a reply lands so a follow-up needs
 * no scroll and no click.
 */
export function AskComposer({
  value,
  onChange,
  onSend,
  busy,
  autoFocusKey,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  /** Changes when a reply completes; refocuses the field for the next question. */
  autoFocusKey: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [autoFocusKey, busy]);

  return (
    <div className="mt-4 flex items-end gap-2">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline. A follow-up is usually one
          // line, so requiring a modifier to send would be the wrong default.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!busy) onSend();
          }
        }}
        rows={1}
        placeholder="Ask a follow-up… (Enter to send, Shift+Enter for a new line)"
        aria-label="Ask a follow-up"
        className="flex-1 resize-none bg-panel border border-line rounded-md px-4 py-3 text-[14px] placeholder:text-faint field-sizing-content max-h-40"
      />
      <button
        onClick={onSend}
        disabled={busy || !value.trim()}
        className="px-4 py-3 rounded-md text-sm font-medium border disabled:opacity-40 whitespace-nowrap"
        style={{
          borderColor: 'var(--color-kdb)',
          color: 'var(--color-kdb)',
          background: 'color-mix(in srgb, var(--color-kdb) 8%, transparent)',
        }}
      >
        {busy ? <Pulse label="thinking" /> : 'Send'}
      </button>
    </div>
  );
}
