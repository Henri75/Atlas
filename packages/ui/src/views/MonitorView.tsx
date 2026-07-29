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
import { DEFAULT_RANGE, rangeDays, rangeLabel, type DateRange } from '../dateRange';
import { Filters, RangePicker, type FilterState } from './monitor/Filters';
import { CallsTab } from './monitor/CallsTab';
import { StatsTab } from './monitor/StatsTab';

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

type Tab = 'overview' | 'calls' | 'stats' | 'adoption';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'calls', label: 'Calls' },
  { key: 'stats', label: 'Stats' },
  { key: 'adoption', label: 'Adoption' },
];

/** Filters start with the noise hidden: it is traffic, and it dwarfs the signal. */
const DEFAULT_FILTERS: FilterState = {
  range: DEFAULT_RANGE,
  q: '',
  hideNoise: true,
};

/** Classes shown by default: everything the classification does not call noise. */
const SIGNAL_CLASSES = (Object.keys(ROUTE_CLASS_META) as RouteClass[]).filter(
  (c) => !ROUTE_CLASS_META[c].noise,
);

export function MonitorView() {
  const [tab, setTab] = useState<Tab>('overview');
  const [classes, setClasses] = usePersistentState<RouteClass[]>(
    'atlas.monitor.classes',
    SIGNAL_CLASSES,
  );
  const [filters, setFilters] = usePersistentState<FilterState>(
    'atlas.monitor.filters',
    DEFAULT_FILTERS,
  );
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // One window governs every tab, so the Overview, Stats and Calls numbers are
  // always about the same slice of time. Derived rather than stored twice.
  const days = useMemo(() => rangeDays(filters.range), [filters.range]);
  const setRange = useCallback(
    (range: DateRange) => setFilters((f) => ({ ...f, range })),
    [setFilters],
  );

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
            Who calls Atlas, what they asked, and what it answered ·{' '}
            <span className="font-mono text-[11px]">{rangeLabel(filters.range)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RangePicker range={filters.range} onChange={setRange} />
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
        {tab === 'calls' && (
          <CallsTab
            classes={classes}
            filters={filters}
            onFilters={setFilters}
            nonce={nonce}
          />
        )}
        {tab === 'stats' && <StatsTab days={days} nonce={nonce} />}
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
