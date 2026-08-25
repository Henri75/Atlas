import { useEffect, useMemo, useRef, useState } from 'react';
import { ms, questionFor, sourceRef, useAskConversation } from '@atlas/shared';
import type { AskMetrics, AskSource, Turn } from '@atlas/shared';
import { Badge, CopyButton, ProjectTag, Pulse, Stamp, submitOnEnter } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { ExportButtons } from '../components/ExportReply';

export type { Turn };
export { useAskConversation };

/**
 * Multi-turn Ask presentation. The conversation ENGINE (turn sequencing,
 * retry/delete semantics, history slicing) lives in @atlas/shared so the
 * native app behaves identically; this file is the web rendering of it.
 * The transport is injected here as `api.askStream` (fetch/SSE).
 */

/** Millisecond durations read better at human scale: 412ms, 1.4s. */
const fmtMs = ms;

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
  if (m.ttftMs !== undefined) bits.push(`${fmtMs(m.ttftMs)} to first token`);
  if (m.tokensPerSec !== undefined) bits.push(`${m.tokensPerSec} tok/s`);

  const detail = [
    m.promptTokens !== undefined && `prompt ${m.promptTokens} · completion ${m.completionTokens}`,
    m.totalMs !== undefined && `total ${fmtMs(m.totalMs)}`,
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
  exportable?: Parameters<typeof ExportButtons>[0]['reply'];
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
        // Enter sends; Shift+Enter is a newline. A follow-up is usually one
        // line, so requiring a modifier to send would be the wrong default —
        // and the composer at the top of the view now agrees, via this handler.
        onKeyDown={submitOnEnter(() => {
          if (!busy) onSend();
        })}
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
