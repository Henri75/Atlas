// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The call feed's sequencing, which is where all of its correctness lives.
 *
 * Regression: a filter change while a page was still in the air used to be
 * swallowed. `fetchPage` bailed on the shared `inFlight` guard, so no request
 * was ever issued for the new filters, and the response already in flight was
 * then dropped by the generation check — leaving the feed permanently empty
 * with nothing loading and no error to explain it.
 */

const usageCalls = vi.fn();
vi.mock('../../packages/ui/src/api', () => ({ api: { usageCalls: (p: unknown) => usageCalls(p) } }));

const { useCallFeed } = await import('../../packages/ui/src/views/monitor/useCallFeed');
import type { FilterState } from '../../packages/ui/src/views/monitor/Filters';

const BASE: FilterState = { range: '7d' as FilterState['range'], q: '', hideNoise: false };

function page(ids: number[]) {
  return {
    calls: ids.map((id) => ({ id, at: `2026-08-27T00:00:0${id}Z` })),
    total: ids.length,
    facets: { byClient: [], byTool: [] },
    nextCursor: undefined,
  };
}

/** A response we can resolve by hand, so "in flight" is a state we control. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// mockReset, not clearAllMocks: a `...Once` queued by a failing test would
// otherwise survive into the next one and answer its first request.
afterEach(() => { cleanup(); usageCalls.mockReset(); });
beforeEach(() => { vi.useRealTimers(); });

describe('useCallFeed', () => {
  it('serves the new filters when they change mid-request', async () => {
    const first = deferred<ReturnType<typeof page>>();
    usageCalls.mockReturnValueOnce(first.promise).mockResolvedValueOnce(page([2]));

    const { result, rerender } = renderHook(
      ({ filters }) => useCallFeed(filters, ['mcp'] as never, 80),
      { initialProps: { filters: BASE } },
    );
    await waitFor(() => expect(usageCalls).toHaveBeenCalledTimes(1));

    // Change the result-set identity while request #1 is still unresolved.
    rerender({ filters: { ...BASE, status: 'error' } as FilterState });

    // The new identity must get its own request rather than inheriting the
    // dropped one. Without the fix this stays at 1 forever.
    await waitFor(() => expect(usageCalls).toHaveBeenCalledTimes(2));
    expect(usageCalls.mock.calls[1]![0]).toMatchObject({ status: 'error' });

    // The superseded response must not repopulate the list.
    await act(async () => { first.resolve(page([1])); await first.promise; });

    await waitFor(() => expect(result.current.calls.map((c) => c.id)).toEqual([2]));
    expect(result.current.loading).toBe(false);
  });

  it('still collapses concurrent loadMore calls into one request', async () => {
    usageCalls.mockResolvedValue({ ...page([1]), nextCursor: { at: 'x', id: 1 } });

    const { result } = renderHook(() => useCallFeed(BASE, ['mcp'] as never, 80));
    await waitFor(() => expect(result.current.calls).toHaveLength(1));
    expect(usageCalls).toHaveBeenCalledTimes(1);

    const slow = deferred<ReturnType<typeof page>>();
    usageCalls.mockReturnValueOnce(slow.promise);
    act(() => { result.current.loadMore(); result.current.loadMore(); });

    // Two appends against the same cursor would double-fetch the same page.
    expect(usageCalls).toHaveBeenCalledTimes(2);
    await act(async () => { slow.resolve(page([3])); await slow.promise; });
  });
});
