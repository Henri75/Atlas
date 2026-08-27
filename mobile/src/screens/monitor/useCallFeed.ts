import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveRange, type RouteClass, type UsageCallPage, type UsageCallRow, type UsageCursor, type UsageFacet } from '@atlas/shared';
import { api } from '../../api/endpoints';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import type { FilterState } from './Filters';

/**
 * The paged call feed behind infinite scroll (web useCallFeed, ported whole —
 * the correctness is all in the sequencing):
 *
 *  - **Cursor, not offset** — the log grows while you read.
 *  - **Stale responses lose** — a generation counter drops rows for filters
 *    the reader has already left.
 *  - **Ids stay unique** — append de-duplicates rather than trusting the wire.
 */
export interface CallFeed {
  calls: UsageCallRow[];
  total: number;
  facets: { byClient: UsageFacet[]; byTool: UsageFacet[] };
  loading: boolean;
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
  pageSize = 80,
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

  // Debounced so typing in the search box does not fire a request per
  // keystroke, each of which resets the list under the reader's cursor.
  const debouncedQ = useDebouncedValue(filters.q, 250);

  // The identity of a result set. Anything here invalidates the list and
  // rewinds the cursor; anything outside it does not.
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
      // Only an APPEND can meaningfully collide: two page-N requests would
      // fetch the same cursor twice. A reset must never be dropped — bailing
      // out here left the list empty with nothing in flight whenever a filter
      // changed while a page was still in the air, and the stale response was
      // then discarded by the generation check below.
      if (inFlight.current && append) return;
      inFlight.current = true;
      const gen = generation.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
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
        // A newer generation owns these flags now; clearing them here would
        // announce "idle" while its request is still running.
        if (gen === generation.current) {
          inFlight.current = false;
          setLoadingMore(false);
          setLoading(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, pageSize],
  );

  useEffect(() => {
    generation.current += 1;
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
    generation.current += 1;
    cursor.current = undefined;
    setDone(false);
    void fetchPage(false);
  }, [fetchPage]);

  return { calls, total, facets, loading, loadingMore, error, done, loadMore, reload };
}
