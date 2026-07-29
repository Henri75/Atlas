import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { resolveRange } from '../../dateRange';
import type { RouteClass, UsageCallPage, UsageCallRow, UsageCursor, UsageFacet } from '../../types';
import type { FilterState } from './Filters';

/**
 * The paged call feed behind the infinite scroll.
 *
 * Kept out of the component because the correctness here is all in the
 * sequencing, not the markup, and sequencing bugs in an infinite list are the
 * kind you only notice as duplicated rows three screens down.
 *
 * Three things it has to get right:
 *
 *  - **Cursor, not offset.** The log grows while you read it, so a page measured
 *    from the top is measured from somewhere that moved.
 *  - **Stale responses lose.** Changing a filter mid-flight must not let the old
 *    request's rows land on top of the new list. A generation counter is checked
 *    on arrival; a slow reply for a filter you have left is dropped.
 *  - **Ids stay unique.** Even with a cursor, a row can arrive twice if a filter
 *    round-trips, so append de-duplicates rather than trusting the server.
 */
export interface CallFeed {
  calls: UsageCallRow[];
  total: number;
  facets: { byClient: UsageFacet[]; byTool: UsageFacet[] };
  loading: boolean;
  /** True while fetching a *further* page, so the first load can show a spinner
   *  and later ones a footer — different states, different treatments. */
  loadingMore: boolean;
  error: string;
  done: boolean;
  loadMore: () => void;
  reload: () => void;
}

const EMPTY_FACETS = { byClient: [], byTool: [] };

export function useCallFeed(
  filters: FilterState,
  classes: RouteClass[],
  pageSize = 100,
): CallFeed {
  const [calls, setCalls] = useState<UsageCallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<{ byClient: UsageFacet[]; byTool: UsageFacet[] }>(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const cursor = useRef<UsageCursor | undefined>(undefined);
  const generation = useRef(0);
  const inFlight = useRef(false);

  // Debounced so typing in the search box does not fire a request per keystroke,
  // each of which resets the list under the reader's cursor.
  const [debouncedQ, setDebouncedQ] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 250);
    return () => clearTimeout(t);
  }, [filters.q]);

  // The identity of a *result set*. Anything in here invalidates the list and
  // rewinds the cursor; anything outside it (e.g. which row is open) does not.
  const key = JSON.stringify([
    debouncedQ.trim(),
    filters.client ?? '',
    filters.tool ?? '',
    filters.status ?? '',
    filters.hideNoise,
    filters.range,
    classes,
  ]);

  const fetchPage = useCallback(
    async (append: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const gen = generation.current;
      append ? setLoadingMore(true) : setLoading(true);
      try {
        const { since, until } = resolveRange(filters.range);
        const page: UsageCallPage = await api.usageCalls({
          since,
          until,
          class: classes.join(','),
          client: filters.client,
          tool: filters.tool,
          status: filters.status,
          q: debouncedQ.trim() || undefined,
          hideNoise: filters.hideNoise,
          limit: pageSize,
          cursorAt: append ? cursor.current?.at : undefined,
          cursorId: append ? cursor.current?.id : undefined,
        });
        // A filter changed while this was in the air: its rows describe a set the
        // reader has already left.
        if (gen !== generation.current) return;

        cursor.current = page.nextCursor;
        setDone(!page.nextCursor);
        setTotal(page.total);
        setFacets(page.facets ?? EMPTY_FACETS);
        setCalls((prev) => {
          if (!append) return page.calls;
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...page.calls.filter((c) => !seen.has(c.id))];
        });
        setError('');
      } catch (e) {
        if (gen === generation.current) setError((e as Error).message);
      } finally {
        inFlight.current = false;
        setLoadingMore(false);
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, pageSize],
  );

  // Reset and refetch whenever the result-set identity changes.
  useEffect(() => {
    generation.current++;
    cursor.current = undefined;
    setDone(false);
    setCalls([]);
    void fetchPage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadMore = useCallback(() => {
    if (done || loading || loadingMore || !cursor.current) return;
    void fetchPage(true);
  }, [done, loading, loadingMore, fetchPage]);

  const reload = useCallback(() => {
    generation.current++;
    cursor.current = undefined;
    setDone(false);
    void fetchPage(false);
  }, [fetchPage]);

  return { calls, total, facets, loading, loadingMore, error, done, loadMore, reload };
}
