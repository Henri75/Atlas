import { useCallback, useRef, useState } from 'react';
import type { AskMetrics, AskSource, ScopeFallback, SourceType } from './types.js';

/**
 * Multi-turn Ask, platform-neutral.
 *
 * Each turn is addressable, so a reply can be retried and any turn deleted. The
 * history sent to the LLM is derived by slicing the conversation *above* the
 * question being answered — a retry must not see the answer it is replacing,
 * and a deletion must not leave a dangling reference.
 *
 * The ONLY platform-specific piece is the transport, injected as `stream`:
 * the web passes a fetch/SSE reader, native an expo/fetch streaming reader.
 * Everything else — sequencing, retry semantics, abort handling — is shared.
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
   */
  scopeFallback?: ScopeFallback;
  /** What it cost to produce this reply. Absent when the LLM never answered. */
  metrics?: AskMetrics;
}

/** Events emitted by a streaming ask (mirrors core's AskEvent). */
export type AskEvent =
  | { type: 'sources'; sources: AskSource[]; scopeFallback?: ScopeFallback }
  | { type: 'delta'; text: string }
  // `metrics` is absent when the LLM never answered (no headers, no usage).
  | { type: 'done'; model: string; degraded: boolean; metrics?: AskMetrics }
  | { type: 'error'; message: string };

/** The injected transport: POST the question, yield events as they arrive. */
export type AskStreamer = (
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => AsyncGenerator<AskEvent, void, unknown>;

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

/**
 * Turn a fetch/HTTP failure into something the user can act on. A dead API
 * returns a full nginx HTML error page, which is useless as a message.
 */
export function describeError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/^50[0-9]/.test(msg) || /bad gateway/i.test(msg)) {
    return 'The API is not reachable. Is the stack running?';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the server. Is the stack running?';
  }
  // Strip an HTML body if one leaked through.
  return msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Millisecond durations read better at human scale: 412ms, 1.4s. */
export function ms(v: number): string {
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`;
}

/** The user turn immediately above an answer — its question, for the export. */
export function questionFor(turns: Turn[], answerId: string): string | undefined {
  const at = turns.findIndex((t) => t.id === answerId);
  const prev = at > 0 ? turns[at - 1] : undefined;
  return prev?.role === 'user' ? prev.content : undefined;
}

export function useAskConversation(
  /** The scoped projects. Empty means all — the API treats it as unconstrained. */
  projects: string[],
  onOpenEntry: (id: number) => void,
  sources: SourceType[] = [],
  /** First-ingested-from filter (spec §6); '' means unconstrained. */
  machine = '',
  /** Injected transport (5th arg). Web and native each supply their own. */
  stream: AskStreamer,
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
  const machineRef = useRef(machine);
  machineRef.current = machine;
  const streamRef = useRef(stream);
  streamRef.current = stream;
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
        const events = streamRef.current(
          {
            question,
            // A list on the wire; omitted entirely when the scope is "all", so
            // the API applies no project constraint at all.
            project: projectsRef.current.length ? projectsRef.current : undefined,
            source: sourcesRef.current.length ? sourcesRef.current : undefined,
            machine: machineRef.current || undefined,
            history: history.map((t) => ({ role: t.role, content: t.content })),
          },
          controller.signal,
        );
        for await (const ev of events) {
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
