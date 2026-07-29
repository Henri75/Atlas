import { useEffect, useMemo, useRef, useState } from 'react';
import type { RouteClass, UsageCallRow } from '../../types';
import { Empty, Spinner } from '../../components/ui';
import { BarList, Swatch, clientColor } from '../../components/charts';
import { compact, exact, millis, relativeTime } from '../../format';
import { describeQuery } from '../../describeQuery';
import { Filters, type FilterState } from './Filters';
import { useCallFeed } from './useCallFeed';
import { CallDrawer } from './CallDrawer';

/**
 * The forensic list: every recorded call, newest first, with what was asked and
 * (one click away) what came back.
 *
 * Infinite scroll rather than pages, because reading a log is a scan and paging
 * breaks a scan into a series of decisions. The cost is that "how many are
 * there" stops being implicit, so the total is stated explicitly in the header
 * instead.
 */
export function CallsTab({
  classes,
  filters,
  onFilters,
  nonce,
  pageSize = 100,
}: {
  classes: RouteClass[];
  filters: FilterState;
  onFilters: (f: FilterState) => void;
  nonce: number;
  pageSize?: number;
}) {
  const feed = useCallFeed(filters, classes, pageSize);
  const [openId, setOpenId] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Refresh button / live toggle from the shell.
  const firstNonce = useRef(nonce);
  useEffect(() => {
    if (nonce !== firstNonce.current) {
      firstNonce.current = nonce;
      feed.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  /**
   * IntersectionObserver rather than a scroll handler: it fires only when the
   * sentinel actually enters the viewport, so there is no per-pixel callback
   * doing arithmetic, and it works regardless of which ancestor is the scroll
   * container.
   *
   * `rootMargin` starts the fetch 400px early, so the next page is usually
   * already in place by the time the reader reaches the bottom.
   */
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) feed.loadMore();
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [feed.loadMore]);

  const shown = feed.calls.length;

  return (
    <div>
      <Filters state={filters} onChange={onFilters} facets={feed.facets} />

      <TopStats facets={feed.facets} total={feed.total} />

      {feed.error && <Empty title="Cannot load calls." hint={feed.error} />}

      {!feed.error && feed.loading && shown === 0 && <Spinner label="loading calls" />}

      {!feed.error && !feed.loading && shown === 0 && (
        <Empty
          title="No calls match."
          hint={
            classes.length === 0
              ? 'No route classes are selected — pick at least one on the Overview tab.'
              : filters.hideNoise
                ? 'Try a wider range, or switch off "hide noise" to include /api/projects and query-less calls.'
                : 'Try a wider range, or clear the filters.'
          }
        />
      )}

      {shown > 0 && (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-[12.5px] border-collapse">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-faint">
                  <th className="py-1.5 pr-3 font-normal">When</th>
                  <th className="py-1.5 pr-3 font-normal">Client</th>
                  <th className="py-1.5 pr-3 font-normal">Tool / path</th>
                  <th className="py-1.5 pr-3 font-normal">Asked</th>
                  <th className="py-1.5 pr-3 font-normal text-right">Took</th>
                  <th className="py-1.5 font-normal text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {feed.calls.map((c) => (
                  <CallRow key={c.id} call={c} onOpen={() => setOpenId(c.id)} />
                ))}
              </tbody>
            </table>
          </div>

          {/* The sentinel sits below the last row; crossing it fetches the next
              page. Rendered even when done, so the footer never jumps. */}
          <div ref={sentinel} className="py-4 text-center font-mono text-[11px] text-faint">
            {feed.loadingMore ? (
              <span className="dots" aria-label="loading more">
                <i /><i /><i />
              </span>
            ) : feed.done ? (
              <span>
                {exact(shown)} of {exact(feed.total)} · end of the log
              </span>
            ) : (
              <span>
                {exact(shown)} of {exact(feed.total)} · scroll for more
              </span>
            )}
          </div>
        </>
      )}

      {openId != null && <CallDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/**
 * Headline counts by client and by type, over the filtered set.
 *
 * Computed server-side from the same WHERE clause as the rows, so these never
 * describe a different population from the list underneath — which is what a
 * client-side count over the loaded pages would do as you scroll.
 */
function TopStats({
  facets,
  total,
}: {
  facets: { byClient: { key: string; calls: number }[]; byTool: { key: string; calls: number }[] };
  total: number;
}) {
  if (total === 0) return null;
  return (
    <div className="mt-4 grid md:grid-cols-2 gap-x-8 gap-y-4 rounded-md border border-line bg-panel px-4 py-3">
      <div>
        <div className="font-mono text-[9px] uppercase tracking-wider text-faint mb-1.5">
          By client · {exact(total)} calls
        </div>
        <BarList
          items={facets.byClient.map((f) => ({
            key: f.key,
            calls: f.calls,
            color: clientColor(f.key),
            hint: `${exact(f.calls)} of ${exact(total)}`,
          }))}
        />
      </div>
      <div>
        <div className="font-mono text-[9px] uppercase tracking-wider text-faint mb-1.5">
          By type
        </div>
        <BarList
          items={facets.byTool.slice(0, 6).map((f) => ({
            key: f.key,
            calls: f.calls,
            hint: `${exact(f.calls)} of ${exact(total)}`,
          }))}
        />
        {facets.byTool.length > 6 && (
          <p className="mt-1 font-mono text-[9px] text-faint">
            +{facets.byTool.length - 6} more — filter by tool above
          </p>
        )}
      </div>
    </div>
  );
}

function CallRow({ call, onOpen }: { call: UsageCallRow; onOpen: () => void }) {
  // Memoised: this parses a URL query string per row, and an infinite list can
  // hold a few thousand of them.
  const asked = useMemo(() => describeQuery(call.query), [call.query]);

  return (
    <tr onClick={onOpen} className="border-t border-line cursor-pointer hover:bg-panel">
      <td className="py-1.5 pr-3 text-[11px] text-muted whitespace-nowrap" title={call.at}>
        {relativeTime(call.at)}
      </td>
      <td className="py-1.5 pr-3">
        <Swatch color={clientColor(call.client)}>{call.client}</Swatch>
      </td>
      <td className="py-1.5 pr-3 font-mono text-[11.5px] whitespace-nowrap">
        {call.tool ?? call.path}
        {call.hasReply && (
          <span className="ml-1.5 text-faint" title="A reply was recorded">
            ⏎
          </span>
        )}
      </td>
      <td className="py-1.5 pr-3 max-w-lg">
        {asked ? (
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="truncate" title={asked.text || call.query}>
              {asked.text || <span className="text-faint">—</span>}
            </span>
            {asked.filters.slice(0, 3).map((f) => (
              <span
                key={f.key}
                className="shrink-0 font-mono text-[9.5px] px-1 rounded"
                style={{ background: 'var(--color-panel-2)', color: 'var(--color-muted)' }}
                title={`${f.key} = ${f.value}`}
              >
                {f.key}:{f.value}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono text-[11px]">{millis(call.durationMs)}</td>
      <td className="py-1.5 text-right font-mono text-[11px]">
        <StatusBadge status={call.status} />
      </td>
    </tr>
  );
}

/** 499/500 on the stream route are outcomes, not wire statuses — name them. */
export function StatusBadge({ status }: { status: number }) {
  if (status === 499)
    return (
      <span
        style={{ color: 'var(--color-kdb)' }}
        title="The caller gave up before the answer finished"
      >
        aborted
      </span>
    );
  if (status >= 400) return <span style={{ color: 'var(--color-report)' }}>{status}</span>;
  return <span className="text-faint">{status}</span>;
}

export { compact };
