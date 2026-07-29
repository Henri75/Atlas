import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ROUTE_CLASS_META } from '../types';
import type {
  CachedAdoption,
  RouteClass,
  ToolAdoption,
  UsageCallDetail,
  UsageCallRow,
  UsageStats,
} from '../types';
import { Empty, Eyebrow, Spinner } from '../components/ui';
import {
  Bars,
  HourStrip,
  LatencyPair,
  ShareBar,
  Sparkline,
  StatTile,
  Swatch,
  clientColor,
} from '../components/charts';
import { compact, exact, millis, plural, relativeTime } from '../format';
import { usePersistentState } from '../usePersistentState';

/**
 * Monitor: who uses Atlas, for what, how well it answered.
 *
 * Distinct from Overview on purpose. Overview is about the *index* — what is in
 * it, is it healthy, what it costs on disk. This is about the *traffic*: which
 * agent asked what, how long it took, and what came back. Same tool, opposite
 * ends of it.
 *
 * Refresh is manual with an opt-in live toggle, off by default. Every request
 * this page makes is itself logged, so a page that polled would appear in its
 * own charts as the busiest client Atlas has — the observer would dominate the
 * observation.
 */

type Tab = 'overview' | 'calls' | 'adoption';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'calls', label: 'Calls' },
  { key: 'adoption', label: 'Adoption' },
];

const WINDOWS = [1, 7, 30, 90] as const;

/** Classes shown by default: everything the classification does not call noise. */
const SIGNAL_CLASSES = (Object.keys(ROUTE_CLASS_META) as RouteClass[]).filter(
  (c) => !ROUTE_CLASS_META[c].noise,
);

export function MonitorView() {
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = usePersistentState<number>('atlas.monitor.days', 7);
  const [classes, setClasses] = usePersistentState<RouteClass[]>(
    'atlas.monitor.classes',
    SIGNAL_CLASSES,
  );
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [live, refresh]);

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-xl font-semibold">Monitor</h1>
          <p className="text-[12px] text-muted mt-0.5">
            Who calls Atlas, what they asked, and what it answered.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-line overflow-hidden">
            {WINDOWS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={`px-2.5 py-1 font-mono text-[11px] ${
                  days === d ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={() => setLive((v) => !v)}
            aria-pressed={live}
            title="Poll every 10s. Off by default — this page's own requests are logged too."
            className={`px-2.5 py-1 rounded-md border font-mono text-[11px] ${
              live ? 'border-line bg-panel-2 text-ink' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {live ? '● live' : '○ live'}
          </button>
          <button
            onClick={refresh}
            className="px-2.5 py-1 rounded-md border border-line font-mono text-[11px] text-muted hover:text-ink hover:border-faint"
          >
            refresh
          </button>
        </div>
      </div>

      <div className="mt-4 flex gap-1 border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-[13px] -mb-px border-b-2 ${
              tab === t.key
                ? 'border-current text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
            style={tab === t.key ? { borderColor: 'var(--color-kdb)' } : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'overview' && (
          <OverviewTab days={days} classes={classes} onClasses={setClasses} nonce={nonce} />
        )}
        {tab === 'calls' && <CallsTab days={days} classes={classes} nonce={nonce} />}
        {tab === 'adoption' && <AdoptionTab nonce={nonce} />}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

function OverviewTab({
  days,
  classes,
  onClasses,
  nonce,
}: {
  days: number;
  classes: RouteClass[];
  onClasses: (c: RouteClass[]) => void;
  nonce: number;
}) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api
      .usage(days, classes)
      .then((s) => live && (setStats(s), setError('')))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [days, classes, nonce]);

  if (error) return <Empty title="Cannot load usage." hint={error} />;
  if (!stats) return <Spinner label="loading usage" />;

  const errorRate = stats.calls ? stats.errors / stats.calls : 0;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="Calls"
          value={compact(stats.calls)}
          hint={`${plural(stats.clients, 'client')} · last ${days}d`}
        />
        <StatTile
          label="Errors"
          value={compact(stats.errors)}
          hint={stats.calls ? `${(errorRate * 100).toFixed(1)}% of calls` : 'nothing to rate'}
          tone={stats.errors > 0 ? 'var(--color-report)' : undefined}
        />
        <StatTile label="Median" value={millis(stats.p50Ms)} hint="half of calls are faster" />
        <StatTile label="p95" value={millis(stats.p95Ms)} hint="the slow tail" />
      </div>

      <ClassFilter byClass={stats.byClass} selected={classes} onChange={onClasses} />

      <section>
        <Eyebrow>Activity</Eyebrow>
        <DailyBars byDay={stats.byDay} days={days} />
      </section>

      <section>
        <Eyebrow>By hour</Eyebrow>
        <HourStrip byHour={stats.byHour} />
      </section>

      <section>
        <Eyebrow>By tool</Eyebrow>
        <ToolTable stats={stats} />
      </section>
    </div>
  );
}

/**
 * Which route classes count. Always shows every class with its real total, even
 * the ones currently filtered out — this is the one place that can tell you what
 * a filter is hiding, so filtering it too would defeat the purpose.
 */
function ClassFilter({
  byClass,
  selected,
  onChange,
}: {
  byClass: UsageStats['byClass'];
  selected: RouteClass[];
  onChange: (c: RouteClass[]) => void;
}) {
  const all = Object.keys(ROUTE_CLASS_META) as RouteClass[];
  const count = (c: RouteClass) => byClass.find((b) => b.routeClass === c)?.calls ?? 0;
  const toggle = (c: RouteClass) =>
    onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);

  return (
    <section>
      <Eyebrow>Route classes</Eyebrow>
      <ShareBar
        parts={all.map((c) => ({ key: c, calls: count(c), color: ROUTE_CLASS_META[c].color }))}
      />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {all.map((c) => {
          const on = selected.includes(c);
          const n = count(c);
          return (
            <button
              key={c}
              onClick={() => toggle(c)}
              aria-pressed={on}
              title={ROUTE_CLASS_META[c].hint}
              className={`px-2 py-0.5 rounded-full border font-mono text-[10px] ${
                on ? 'text-ink' : 'text-faint'
              }`}
              style={{
                borderColor: on ? ROUTE_CLASS_META[c].color : 'var(--color-line)',
                background: on
                  ? `color-mix(in srgb, ${ROUTE_CLASS_META[c].color} 14%, transparent)`
                  : 'transparent',
              }}
            >
              {ROUTE_CLASS_META[c].label} {compact(n)}
            </button>
          );
        })}
      </div>
      {/* Polling is on disk in full; it is only hidden from the counts. Saying so
          prevents "185 calls" being read as "Atlas received 185 requests". */}
      <p className="mt-2 text-[11px] text-faint">
        Everything is recorded. Unselected classes are excluded from the figures above, not
        discarded — <span className="font-mono">status</span> and{' '}
        <span className="font-mono">admin</span> are hidden by default because polling would
        otherwise dominate every count.
      </p>
    </section>
  );
}

/** Fills every calendar day in the window so idle days stay visible as gaps. */
function DailyBars({ byDay, days }: { byDay: UsageStats['byDay']; days: number }) {
  const stacked = useMemo(() => {
    const span = Math.min(days, 90);
    const out: { day: string; byClient: Record<string, number> }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ day, byClient: {} });
    }
    const index = new Map(out.map((d) => [d.day, d]));
    for (const row of byDay) {
      const slot = index.get(row.day);
      if (slot) slot.byClient[row.client] = (slot.byClient[row.client] ?? 0) + row.calls;
    }
    return out;
  }, [byDay, days]);

  const clients = [...new Set(byDay.map((d) => d.client))];

  return (
    <div>
      <Bars days={stacked} label={`Calls per day for the last ${days} days, stacked by client`} />
      <div className="mt-2 flex flex-wrap gap-3">
        {clients.length === 0 ? (
          <span className="font-mono text-[10px] text-faint">no traffic in this window</span>
        ) : (
          clients.map((c) => (
            <Swatch key={c} color={clientColor(c)}>
              {c}
            </Swatch>
          ))
        )}
      </div>
    </div>
  );
}

function ToolTable({ stats }: { stats: UsageStats }) {
  if (stats.byTool.length === 0) return <Empty title="No calls in this window." />;

  // Per-tool daily series for the sparklines. byDay is aggregated by client, not
  // by tool, so the shape shown is the client's — labelled as such rather than
  // implying a per-tool trend the API does not return.
  const series = new Map<string, number[]>();
  const dayKeys = [...new Set(stats.byDay.map((d) => d.day))].sort();
  for (const t of stats.byTool) {
    series.set(
      `${t.client}/${t.tool}`,
      dayKeys.map(
        (d) => stats.byDay.find((b) => b.day === d && b.client === t.client)?.calls ?? 0,
      ),
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px] border-collapse">
        <thead>
          <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-faint">
            <th className="py-1.5 pr-3 font-normal">Tool</th>
            <th className="py-1.5 pr-3 font-normal">Client</th>
            <th className="py-1.5 pr-3 font-normal text-right">Calls</th>
            <th className="py-1.5 pr-3 font-normal">Trend</th>
            <th className="py-1.5 pr-3 font-normal text-right">p50 / p95</th>
            <th className="py-1.5 pr-3 font-normal text-right">Max</th>
            <th className="py-1.5 pr-3 font-normal text-right">Errors</th>
            <th className="py-1.5 font-normal text-right">Last</th>
          </tr>
        </thead>
        <tbody>
          {stats.byTool.map((t) => (
            <tr key={`${t.client}/${t.tool}`} className="border-t border-line">
              <td className="py-1.5 pr-3 font-mono text-[11.5px]">{t.tool}</td>
              <td className="py-1.5 pr-3">
                <Swatch color={clientColor(t.client)}>{t.client}</Swatch>
              </td>
              <td className="py-1.5 pr-3 text-right font-mono" title={exact(t.calls)}>
                {compact(t.calls)}
              </td>
              <td className="py-1.5 pr-3">
                <Sparkline
                  values={series.get(`${t.client}/${t.tool}`) ?? []}
                  color={clientColor(t.client)}
                  label={`${t.client} daily call volume`}
                />
              </td>
              <td className="py-1.5 pr-3 text-right">
                <LatencyPair p50={t.p50Ms} p95={t.p95Ms} />
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-[11px] text-muted">
                {millis(t.maxMs)}
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                {t.errors > 0 ? (
                  <span style={{ color: 'var(--color-report)' }}>{exact(t.errors)}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="py-1.5 text-right text-[11px] text-muted" title={t.lastAt}>
                {relativeTime(t.lastAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Calls                                                                       */
/* -------------------------------------------------------------------------- */

function CallsTab({ days, classes, nonce }: { days: number; classes: RouteClass[]; nonce: number }) {
  const [q, setQ] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [onlyReplies, setOnlyReplies] = useState(false);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ calls: UsageCallRow[]; total: number } | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const pageSize = 100;

  // A filter change must reset paging: page 4 of a narrower result set is
  // usually empty, which reads as "no matches" for a filter that has plenty.
  useEffect(() => setPage(0), [q, onlyErrors, days, classes]);

  useEffect(() => {
    let live = true;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    api
      .usageCalls({
        since,
        class: classes.join(','),
        q: q.trim() || undefined,
        status: onlyErrors ? 'error' : undefined,
        limit: pageSize,
        offset: page * pageSize,
      })
      .then((d) => live && (setData(d), setError('')))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [days, classes, q, onlyErrors, page, nonce]);

  if (error) return <Empty title="Cannot load calls." hint={error} />;

  // Replies are filtered client-side: it is a display preference over the page
  // already fetched, and pushing it to SQL would make `total` disagree with the
  // rows on screen.
  const rows = (data?.calls ?? []).filter((c) => !onlyReplies || c.hasReply);
  const pages = Math.ceil((data?.total ?? 0) / pageSize);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the questions asked…"
          className="flex-1 min-w-56 bg-panel border border-line rounded-md px-3 py-1.5 text-[13px] placeholder:text-faint"
        />
        <Toggle on={onlyErrors} onClick={() => setOnlyErrors((v) => !v)}>
          errors only
        </Toggle>
        <Toggle on={onlyReplies} onClick={() => setOnlyReplies((v) => !v)}>
          with reply
        </Toggle>
      </div>

      {!data ? (
        <Spinner label="loading calls" />
      ) : rows.length === 0 ? (
        <Empty
          title="No calls match."
          hint={
            classes.length === 0
              ? 'No route classes are selected — pick at least one on the Overview tab.'
              : 'Try a wider window, or clear the filters.'
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] border-collapse">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-faint">
                  <th className="py-1.5 pr-3 font-normal">When</th>
                  <th className="py-1.5 pr-3 font-normal">Client</th>
                  <th className="py-1.5 pr-3 font-normal">Tool / path</th>
                  <th className="py-1.5 pr-3 font-normal">Query</th>
                  <th className="py-1.5 pr-3 font-normal text-right">Took</th>
                  <th className="py-1.5 font-normal text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setOpenId(c.id)}
                    className="border-t border-line cursor-pointer hover:bg-panel"
                  >
                    <td className="py-1.5 pr-3 text-[11px] text-muted whitespace-nowrap" title={c.at}>
                      {relativeTime(c.at)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Swatch color={clientColor(c.client)}>{c.client}</Swatch>
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[11.5px] whitespace-nowrap">
                      {c.tool ?? c.path}
                      {c.hasReply && (
                        <span className="ml-1.5 text-faint" title="A reply was recorded">
                          ⏎
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted max-w-md truncate" title={c.query}>
                      {c.query ?? <span className="text-faint">—</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-[11px]">
                      {millis(c.durationMs)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[11px]">
                      <StatusBadge status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between font-mono text-[11px] text-faint">
            <span>
              {exact(data.total)} call{data.total === 1 ? '' : 's'}
              {onlyReplies && rows.length !== data.calls.length
                ? ` · ${rows.length} with a reply on this page`
                : ''}
            </span>
            {pages > 1 && (
              <span className="flex items-center gap-2">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="px-2 py-0.5 rounded border border-line disabled:opacity-35 hover:text-ink"
                >
                  prev
                </button>
                <span>
                  {page + 1} / {pages}
                </span>
                <button
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-2 py-0.5 rounded border border-line disabled:opacity-35 hover:text-ink"
                >
                  next
                </button>
              </span>
            )}
          </div>
        </>
      )}

      {openId != null && <CallDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Toggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`px-2.5 py-1 rounded-md border font-mono text-[11px] ${
        on ? 'border-faint text-ink bg-panel-2' : 'border-line text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/** 499 is nginx's client-closed convention; show it as what it means. */
function StatusBadge({ status }: { status: number }) {
  if (status === 499)
    return (
      <span style={{ color: 'var(--color-report)' }} title="The caller gave up before the answer finished">
        aborted
      </span>
    );
  if (status >= 400) return <span style={{ color: 'var(--color-report)' }}>{status}</span>;
  return <span className="text-faint">{status}</span>;
}

/**
 * One call in full: the question, the answer, the sources cited, what it cost.
 * The point of the whole feature — an aggregate can say ask is slow, only this
 * can say whether the answer was worth the wait.
 */
function CallDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const [call, setCall] = useState<UsageCallDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setCall(null);
    api
      .usageCall(id)
      .then((c) => live && (setCall(c), setError('')))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reply = call?.reply;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <button className="flex-1 bg-black/40" aria-label="Close" onClick={onClose} />
      <div className="w-full max-w-2xl bg-panel border-l border-line overflow-y-auto rise">
        <div className="sticky top-0 bg-panel border-b border-line px-5 py-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="font-mono text-[11px] text-faint">call #{id}</div>
            <div className="font-display text-[15px] font-semibold truncate">
              {call?.tool ?? call?.path ?? '…'}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-6">
          {error && <Empty title="Cannot load this call." hint={error} />}
          {!call && !error && <Spinner label="loading call" />}

          {call && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
                <Field label="When">
                  <span title={call.at}>{relativeTime(call.at)}</span>
                </Field>
                <Field label="Client">
                  <Swatch color={clientColor(call.client)}>{call.client}</Swatch>
                </Field>
                <Field label="Route">
                  <span className="font-mono text-[11.5px]">
                    {call.method} {call.path}
                  </span>
                </Field>
                <Field label="Class">
                  <span className="font-mono text-[11.5px]" title={ROUTE_CLASS_META[call.routeClass]?.hint}>
                    {call.routeClass}
                  </span>
                </Field>
                <Field label="Took">{millis(call.durationMs)}</Field>
                <Field label="Status">
                  <StatusBadge status={call.status} />
                </Field>
                {reply?.model && <Field label="Model">{reply.model}</Field>}
                {reply?.ttftMs != null && <Field label="First token">{millis(reply.ttftMs)}</Field>}
                {reply?.promptTokens != null && (
                  <Field label="Tokens">
                    {compact(reply.promptTokens)} in
                    {reply.completionTokens != null ? ` · ${compact(reply.completionTokens)} out` : ''}
                  </Field>
                )}
                {reply?.resultCount != null && (
                  <Field label="Results">{plural(reply.resultCount, 'result')}</Field>
                )}
              </dl>

              {call.query && (
                <section>
                  <Eyebrow>Asked</Eyebrow>
                  <p className="text-[13.5px] whitespace-pre-wrap">{call.query}</p>
                </section>
              )}

              {reply?.degraded && (
                <p
                  className="rounded-md border px-3 py-2 text-[12px]"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--color-report) 45%, transparent)',
                    color: 'var(--color-report)',
                  }}
                >
                  Degraded answer — the LLM was unreachable, so Atlas returned the retrieved
                  sources with an explanation instead of a synthesis.
                </p>
              )}

              {reply?.error && (
                <section>
                  <Eyebrow>Failed with</Eyebrow>
                  <pre
                    className="text-[11.5px] font-mono whitespace-pre-wrap rounded-md border px-3 py-2"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--color-report) 40%, transparent)',
                      color: 'var(--color-report)',
                    }}
                  >
                    {reply.error}
                  </pre>
                </section>
              )}

              {reply?.answer && (
                <section>
                  <Eyebrow>Atlas answered</Eyebrow>
                  <div className="text-[13.5px] whitespace-pre-wrap leading-relaxed">
                    {reply.answer}
                  </div>
                </section>
              )}

              {reply?.topHits && reply.topHits.length > 0 && (
                <section>
                  <Eyebrow>Top sources</Eyebrow>
                  <ol className="space-y-1.5">
                    {reply.topHits.map((h, i) => (
                      <li key={`${h.entryId}-${i}`} className="flex items-baseline gap-2 text-[12.5px]">
                        <span className="font-mono text-[10px] text-faint w-4 shrink-0">
                          {i + 1}
                        </span>
                        <span className="flex-1 min-w-0 truncate" title={h.title}>
                          {h.title}
                        </span>
                        <span className="font-mono text-[10px] text-faint shrink-0">
                          {h.projectSlug}
                        </span>
                        {h.score != null && (
                          <span
                            className="font-mono text-[10px] shrink-0"
                            style={{ color: 'var(--color-kdb)' }}
                            title="Fused hybrid-search score"
                          >
                            {h.score.toFixed(3)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {!call.hasReply && (
                <p className="text-[12px] text-faint">
                  No reply was recorded for this call. Replies are kept for search and ask only,
                  and only for calls made after reply capture shipped.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Adoption                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether agents call Atlas when a documented trigger fires.
 *
 * A different question from usage: usage says what was called, this says what
 * *should* have been. Served from a cache the indexer fills — the analysis reads
 * every Claude transcript on the machine, which this API container cannot even
 * see.
 */
function AdoptionTab({ nonce }: { nonce: number }) {
  const [data, setData] = useState<CachedAdoption | null>(null);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .adoption()
      .then((d) => live && (setData(d), setError('')))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [nonce]);

  const refresh = async () => {
    setAsked(true);
    try {
      await api.refreshAdoption();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <Empty title="Cannot load adoption." hint={error} />;
  if (!data) return <Spinner label="loading adoption" />;

  if (!data.report) {
    return (
      <div>
        <Empty
          title="No adoption report yet."
          hint="The indexer computes this by scanning every Claude transcript on the machine. It runs daily, and you can ask for it now."
        />
        <div className="mt-3">
          <button
            onClick={() => void refresh()}
            disabled={asked}
            className="px-3 py-1.5 rounded-md border border-line font-mono text-[11px] text-muted hover:text-ink hover:border-faint disabled:opacity-50"
          >
            {asked ? 'queued — check back in a few minutes' : 'compute now'}
          </button>
        </div>
      </div>
    );
  }

  const r = data.report;

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <p className="text-[12px] text-muted max-w-2xl">
          Did agents call the tool when a documented trigger fired? Counted from tool calls in{' '}
          {plural(r.sessionsScanned, 'transcript')}; the misses are{' '}
          <strong className="font-medium">heuristic candidates</strong>, never verdicts.
        </p>
        <span className="font-mono text-[10px] text-faint whitespace-nowrap">
          computed {relativeTime(data.computedAt ?? undefined)}
          {data.tookMs ? ` in ${millis(data.tookMs)}` : ''}
          {' · '}
          <button onClick={() => void refresh()} disabled={asked} className="underline hover:text-ink disabled:opacity-50">
            {asked ? 'queued' : 'recompute'}
          </button>
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <AdoptionCard name="atlas" a={r.atlas} />
        <AdoptionCard name="assessor" a={r.assessor} />
      </div>

      {r.sessions.length > 0 && (
        <section>
          <Eyebrow>Sessions with candidate misses</Eyebrow>
          <div className="space-y-2.5">
            {r.sessions.slice(0, 25).map((s) => (
              <div key={s.sessionId} className="rounded-md border border-line bg-panel px-3.5 py-2.5">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="font-mono text-[11.5px]">{s.project}</span>
                  <span className="font-mono text-[10px] text-faint">
                    {plural(s.turns, 'turn')} · atlas {s.atlasCalls} · assessor {s.assessorCalls}
                    {s.startedAt ? ` · ${relativeTime(s.startedAt)}` : ''}
                  </span>
                </div>
                {s.admittedNotThoughtOf && (
                  <p className="mt-1 text-[11.5px]" style={{ color: 'var(--color-kdb)' }}>
                    The agent volunteered that it simply did not think of it — the most useful
                    signal here.
                  </p>
                )}
                <ul className="mt-1.5 space-y-1">
                  {[...s.missedAtlas, ...s.missedAssessor].slice(0, 4).map((t, i) => (
                    <li key={`${t.rule}-${i}`} className="text-[12px]">
                      <span
                        className="font-mono text-[10px] mr-1.5"
                        style={{ color: t.tool === 'atlas' ? 'var(--color-claude)' : 'var(--color-doc)' }}
                      >
                        {t.tool}/{t.rule}
                      </span>
                      <span className="text-muted">“{t.excerpt}”</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {r.sessions.length > 25 && (
            <p className="mt-2 font-mono text-[10px] text-faint">
              showing 25 of {exact(r.sessions.length)} — run `atlas adoption` for the full list
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function AdoptionCard({ name, a }: { name: string; a: ToolAdoption }) {
  const denom = a.sessionsUsed + a.sessionsMissed;
  return (
    <div className="rounded-md border border-line bg-panel px-4 py-3.5">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-[15px] font-semibold">{name}</span>
        <span className="font-mono text-[10px] text-faint">{plural(a.totalCalls, 'call')}</span>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        {/* null, not 0: "no opportunity arose" and "never fired" are different
            findings and must not render as the same number. */}
        <span className="font-display text-[26px] font-semibold">
          {a.fireRate == null ? '—' : `${Math.round(a.fireRate * 100)}%`}
        </span>
        <span className="text-[11.5px] text-muted">
          {a.fireRate == null ? 'no qualifying sessions' : `fire rate over ${denom} sessions`}
        </span>
      </div>

      <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-line)' }}>
        {a.fireRate != null && (
          <div
            className="h-full"
            style={{
              width: `${a.fireRate * 100}%`,
              background: a.fireRate >= 0.7 ? 'var(--color-git)' : 'var(--color-report)',
            }}
          />
        )}
      </div>

      <div className="mt-2 font-mono text-[10px] text-faint">
        used in {a.sessionsUsed} · missed in {a.sessionsMissed}
        {denom < 10 && denom > 0 && ' · sample too small to read a rate into'}
      </div>

      {a.topMissedRules.length > 0 && (
        <ul className="mt-2.5 space-y-0.5">
          {a.topMissedRules.slice(0, 4).map((m) => (
            <li key={m.rule} className="flex justify-between text-[11.5px]">
              <span className="font-mono text-[10.5px] text-muted">{m.rule}</span>
              <span className="font-mono text-[10.5px]">{m.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
