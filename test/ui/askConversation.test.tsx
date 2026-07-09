// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation, useAskConversation, type Turn } from '../../packages/ui/src/views/AskConversation';

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
    const { result } = renderHook(() => useAskConversation('deepcast', () => {}));

    act(() => result.current.send('what broke?'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    expect(result.current.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(result.current.turns[1]!.content).toBe('Hi');
  });

  it('sends the prior conversation with a follow-up', async () => {
    const spy = stubStream(sse({ type: 'delta', text: 'a' }, { type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('', () => {}));

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
    const { result } = renderHook(() => useAskConversation('', () => {}));

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
    const { result } = renderHook(() => useAskConversation('', () => {}));

    act(() => result.current.send('first'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    act(() => result.current.remove(result.current.turns[0]!.id));
    expect(result.current.turns).toHaveLength(0);
  });

  it('deleting a reply keeps its question', async () => {
    stubStream(sse({ type: 'delta', text: 'a' }, { type: 'done', model: 'm', degraded: false }));
    const { result } = renderHook(() => useAskConversation('', () => {}));

    act(() => result.current.send('first'));
    await waitFor(() => expect(result.current.turns[1]!.streaming).toBe(false));

    act(() => result.current.remove(result.current.turns[1]!.id));
    expect(result.current.turns.map((t) => t.role)).toEqual(['user']);
  });

  it('surfaces a transport failure on the answer it belongs to', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    const { result } = renderHook(() => useAskConversation('', () => {}));

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
