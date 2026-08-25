// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation } from '../../packages/ui/src/views/AskConversation';
import { useAskConversation, type Turn } from '@atlas/shared';
import { api } from '../../packages/ui/src/api';

/** The real web transport, so the stubbed global fetch is still what answers. */
const stream = (body: Record<string, unknown>, signal?: AbortSignal) => api.askStream(body, signal);

afterEach(cleanup);

const sse = (...events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** Capture what the client actually POSTs, and reply with a canned stream. */
function stubStream(body: string) {
  const spy = vi.fn(async () => ({
    ok: true,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const sentHistory = (spy: any, call = 0) => JSON.parse(spy.mock.calls[call][1].body).history;

describe('useAskConversation', () => {
  it('appends a question and streams its answer', async () => {
    stubStream(sse({ type: 'sources', sources: [] }, { type: 'delta', text: 'Hi' }, { type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('deepcast', () => {}, [], '', stream));

    act(() => result.current.send('what broke?'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    expect(result.current.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(result.current.turns[1]!.content).toBe('Hi');
  });

  it('passes the selected source subset to the ask endpoint', async () => {
    const spy = stubStream(sse({ type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() =>
      useAskConversation('deepcast', () => {}, ['doc', 'kdb_component'], '', stream),
    );
    act(() => result.current.send('q'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));
    expect(JSON.parse(spy.mock.calls[0][1].body).source).toEqual(['doc', 'kdb_component']);
  });

  it('omits source when nothing is selected (all sources)', async () => {
    const spy = stubStream(sse({ type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('', () => {}, [], '', stream));
    act(() => result.current.send('q'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));
    expect(JSON.parse(spy.mock.calls[0][1].body).source).toBeUndefined();
  });

  it('captures a scopeFallback marker from the sources event', async () => {
    stubStream(
      sse(
        { type: 'sources', sources: [], scopeFallback: { requested: 'deepcast', usedAllProjects: true } },
        { type: 'done', model: 'm', degraded: false },
      ),
    );
    const { result } = renderHook(() => useAskConversation('deepcast', () => {}, [], '', stream));
    act(() => result.current.send('q'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));
    expect(result.current.turns[1]!.scopeFallback).toEqual({
      requested: 'deepcast',
      usedAllProjects: true,
    });
  });

  it('sends the prior conversation with a follow-up', async () => {
    const spy = stubStream(sse({ type: 'delta', text: 'a' }, { type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('', () => {}, [], '', stream));

    act(() => result.current.send('first'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));
    act(() => result.current.send('second'));
    await waitFor(() => expect(result.current.turns[3]!.streaming).toBe(false));

    expect(sentHistory(spy, 0)).toEqual([]);
    expect(sentHistory(spy, 1)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  /**
   * A retry must not show the model the answer it is replacing, or it will
   * simply agree with it.
   */
  it('retries a reply without sending that reply back as context', async () => {
    const spy = stubStream(sse({ type: 'delta', text: 'x' }, { type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('', () => {}, [], '', stream));

    act(() => result.current.send('first'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));
    act(() => result.current.send('second'));
    await waitFor(() => expect(result.current.turns[3]!.streaming).toBe(false));

    const answerId = result.current.turns[3]!.id;
    act(() => result.current.retry(answerId));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));

    // History stops before "second" — it never contains "second" or its answer.
    expect(sentHistory(spy, 2)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'x' },
    ]);
    // Still two exchanges: the reply was replaced, not appended.
    expect(result.current.turns).toHaveLength(4);
  });

  it('deleting a question removes its orphaned reply too', async () => {
    stubStream(sse({ type: 'delta', text: 'a' }, { type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('', () => {}, [], '', stream));

    act(() => result.current.send('first'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    act(() => result.current.remove(result.current.turns[0]!.id));
    expect(result.current.turns).toHaveLength(0);
  });

  it('deleting a reply keeps its question', async () => {
    stubStream(sse({ type: 'delta', text: 'a' }, { type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('', () => {}, [], '', stream));

    act(() => result.current.send('first'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    act(() => result.current.remove(result.current.turns[1]!.id));
    expect(result.current.turns.map((t) => t.role)).toEqual(['user']);
  });

  it('surfaces a transport failure on the answer it belongs to', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    const { result } = renderHook(() => useAskConversation('', () => {}, [], '', stream));

    act(() => result.current.send('q'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));
    expect(result.current.turns[1]!.error).toMatch(/Could not reach the server/);
  });
});

describe('Conversation', () => {
  const turns: Turn[] = [
    { id: 'a', role: 'user', content: 'what broke?' },
    { id: 'b', role: 'assistant', content: 'pgbouncer [1]', sources: [] },
  ];

  it('offers retry only on assistant turns, and delete on both', () => {
    render(<Conversation turns={turns} onRetry={() => {}} onDelete={() => {}} onOpenEntry={() => {}} />);
    expect(screen.getAllByLabelText('Delete this turn')).toHaveLength(2);
    expect(screen.getAllByLabelText('Retry this reply')).toHaveLength(1);
  });

  it('does not offer retry while a reply is still streaming', () => {
    const streaming: Turn[] = [turns[0]!, { ...turns[1]!, streaming: true }];
    render(<Conversation turns={streaming} onRetry={() => {}} onDelete={() => {}} onOpenEntry={() => {}} />);
    expect(screen.queryByLabelText('Retry this reply')).toBeNull();
  });

  it('shows an error in place of the answer', () => {
    const failed: Turn[] = [turns[0]!, { ...turns[1]!, content: '', error: 'API is not reachable.' }];
    render(<Conversation turns={failed} onRetry={() => {}} onDelete={() => {}} onOpenEntry={() => {}} />);
    expect(screen.getByText('API is not reachable.')).toBeTruthy();
  });
});

/**
 * The reported bug: retrying a failed reply still showed "LLM unavailable".
 *
 * `run()` reset content/sources/streaming/error but *not* `degraded`, and the
 * banner renders on `degraded && !error` — so clearing `error` on retry actively
 * turned the stale banner back on. These pin every field of a previous attempt.
 */
describe('useAskConversation — retry clears the previous attempt', () => {
  const failed = sse(
    { type: 'sources', sources: [] },
    { type: 'delta', text: '\n\n_LLM unavailable (boom)._' },
    { type: 'done', model: 'm', degraded: true },
  );
  const ok = sse(
    { type: 'sources', sources: [] },
    { type: 'delta', text: 'The real answer.' },
    {
      type: 'done',
      model: 'm',
      degraded: false,
      metrics: { model: 'gemma-4-31b-it', substituted: true, totalTokens: 30 },
    },
  );

  it('clears degraded, the failure prose and the stale metrics', async () => {
    // First attempt fails, second succeeds.
    let body = failed;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
      })),
    );

    const { result } = renderHook(() => useAskConversation('p', () => {}, [], '', stream));
    act(() => result.current.send('q'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    expect(result.current.turns[1]!.degraded).toBe(true);
    expect(result.current.turns[1]!.content).toContain('LLM unavailable');

    body = ok;
    act(() => result.current.retry(result.current.turns[1]!.id));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    const reply = result.current.turns[1]!;
    // The banner's condition must now be false...
    expect(reply.degraded).toBe(false);
    // ...and the failure text must not survive in the body either.
    expect(reply.content).toBe('The real answer.');
    expect(reply.content).not.toContain('LLM unavailable');
    expect(reply.metrics?.model).toBe('gemma-4-31b-it');
  });

  it('drops metrics from a previous attempt when the retry reports none', async () => {
    let body = ok;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
      })),
    );

    const { result } = renderHook(() => useAskConversation('p', () => {}, [], '', stream));
    act(() => result.current.send('q'));
    await waitFor(() => expect(result.current.turns[1]!.metrics).toBeTruthy());

    // A degraded retry carries no metrics; the old ones must not linger.
    body = failed;
    act(() => result.current.retry(result.current.turns[1]!.id));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    expect(result.current.turns[1]!.metrics).toBeUndefined();
    expect(result.current.turns[1]!.degraded).toBe(true);
  });
});

describe('Conversation — metrics', () => {
  const withMetrics = (metrics: any): Turn[] => [
    { id: 'a', role: 'user', content: 'q' },
    { id: 'b', role: 'assistant', content: 'answer', sources: [], metrics },
  ];

  it('reports the model that actually served the answer', () => {
    render(
      <Conversation
        turns={withMetrics({
          model: 'gemma-4-31b-it',
          substituted: true,
          totalTokens: 30,
          ttftMs: 412,
          tokensPerSec: 18.3,
        })}
        onRetry={() => {}}
        onDelete={() => {}}
        onOpenEntry={() => {}}
      />,
    );
    expect(screen.getByText('gemma-4-31b-it')).toBeTruthy();
    expect(screen.getByText(/30 tok/)).toBeTruthy();
    expect(screen.getByText(/412ms to first token/)).toBeTruthy();
    expect(screen.getByText(/18\.3 tok\/s/)).toBeTruthy();
  });

  it('shows the model alone when the provider reported no token usage', () => {
    render(
      <Conversation
        turns={withMetrics({ model: 'gemma-4-31b-it', substituted: false })}
        onRetry={() => {}}
        onDelete={() => {}}
        onOpenEntry={() => {}}
      />,
    );
    expect(screen.getByText('gemma-4-31b-it')).toBeTruthy();
    // Never a fabricated zero for something nobody measured.
    expect(screen.queryByText(/0 tok/)).toBeNull();
  });

  it('renders nothing when the LLM never answered', () => {
    const degraded: Turn[] = [
      { id: 'a', role: 'user', content: 'q' },
      { id: 'b', role: 'assistant', content: 'sources only', sources: [], degraded: true },
    ];
    const { container } = render(
      <Conversation turns={degraded} onRetry={() => {}} onDelete={() => {}} onOpenEntry={() => {}} />,
    );
    expect(screen.getByText(/LLM unavailable/)).toBeTruthy();
    expect(container.querySelector('[title*="request"]')).toBeNull();
  });
});
