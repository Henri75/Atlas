import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import type { AskSource } from '../types';
import { Badge, Stamp } from '../components/ui';

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
}

let seq = 0;
const newId = () => `t${++seq}`;

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

export function useAskConversation(project: string, onOpenEntry: (id: number) => void) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
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

      patch(answerId, { content: '', sources: [], streaming: true, error: undefined });

      try {
        const stream = api.askStream(
          {
            question,
            project: project || undefined,
            history: history.map((t) => ({ role: t.role, content: t.content })),
          },
          controller.signal,
        );
        for await (const ev of stream) {
          if (runRef.current !== myRun) break;
          if (ev.type === 'sources') patch(answerId, { sources: ev.sources });
          else if (ev.type === 'delta') {
            commit((prev) =>
              prev.map((t) => (t.id === answerId ? { ...t, content: t.content + ev.text } : t)),
            );
          } else if (ev.type === 'done') patch(answerId, { degraded: ev.degraded });
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
    [project],
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

export function Conversation({
  turns,
  onRetry,
  onDelete,
  onOpenEntry,
}: {
  turns: Turn[];
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenEntry: (entryId: number) => void;
}) {
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
                  <Cited text={t.content} />
                ) : (
                  <span className="font-mono text-sm text-faint">
                    {t.streaming ? 'reading sources…' : ''}
                  </span>
                )}
                {t.streaming && t.content && (
                  <span
                    className="inline-block w-[7px] h-[15px] translate-y-[2px] ml-0.5 animate-pulse"
                    style={{ background: 'var(--color-kdb)' }}
                    aria-hidden
                  />
                )}
                {t.degraded && !t.error && (
                  <p className="font-mono text-xs mt-3" style={{ color: 'var(--color-report)' }}>
                    ⚠ LLM unavailable — sources only
                  </p>
                )}
              </div>
              <TurnActions
                onRetry={t.streaming ? undefined : () => onRetry(t.id)}
                onDelete={() => onDelete(t.id)}
              />
            </div>

            {t.sources && t.sources.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {t.sources.map((s) => (
                  <button
                    key={s.n}
                    onClick={() => onOpenEntry(s.entryId)}
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
            )}
          </div>
        ),
      )}
    </div>
  );
}

function TurnActions({ onRetry, onDelete }: { onRetry?: () => void; onDelete: () => void }) {
  return (
    <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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
