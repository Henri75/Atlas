import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ActivityPoint, Dashboard, RunRow, SourceDetailRow, SourceType } from '../types';
import { SOURCE_META } from '../types';
import { Empty, Eyebrow, Spinner } from '../components/ui';
import { bytes, compact, duration, exact, plural, relativeTime } from '../format';

/**
 * The landing page: what is indexed, whether it is working, and what it costs.
 *
 * Numbers are shown compact (82k) with the exact value on hover — a compact
 * form is scannable but destroys precision, and a dashboard needs both. Sizes
 * that cannot be determined render as "—", never as 0: claiming "uses no disk"
 * is a lie, "cannot tell" is the truth.
 */
export function DashboardView({ onGoTo }: { onGoTo: (view: 'search') => void }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () =>
      api
        .dashboard()
        .then((d) => {
          setData(d);
          setError('');
        })
        .catch((e: Error) => setError(e.message));
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (error && !data) {
    return (
      <Empty
        title="Cannot reach the API."
        hint="The stack may still be starting. Check `make ps` and `make logs`."
      />
    );
  }
  if (!data) return <Spinner />;

  const stale = data.storage.collections.filter((c) => !c.active && c.bytes > 0);
  const staleBytes = stale.reduce((sum, c) => sum + c.bytes, 0);
  const indexing = (data.pending ?? 0) > 0 || data.backfill != null;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-xl font-semibold">Overview</h1>
        <span className="font-mono text-[11px] text-faint">
          indexed {relativeTime(data.lastRunAt)}
          {indexing && <span style={{ color: 'var(--color-kdb)' }}> · indexing…</span>}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Projects" value={data.projects} />
        <Stat label="Documents" value={data.entries} hint="indexed entries" />
        <Stat label="Chunks" value={data.chunks} hint="searchable pieces" />
        <Stat label="Sessions" value={data.sessions} hint="Claude Code transcripts" />
      </div>

      <div className="mt-8 grid md:grid-cols-2 gap-8">
        <section>
          <Eyebrow>Services</Eyebrow>
          <div className="space-y-1.5">
            {Object.entries(data.health).map(([name, up]) => (
              <div key={name} className="flex items-center gap-2 text-[13px]">
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ background: up ? 'var(--color-git)' : 'var(--color-report)' }}
                  aria-hidden
                />
                <span className="flex-1 text-muted">{name}</span>
                <span
                  className="font-mono text-[11px]"
                  style={{ color: up ? 'var(--color-git)' : 'var(--color-report)' }}
                >
                  {up ? 'running' : 'unreachable'}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-1 font-mono text-[11px] text-faint">
            <Row k="embedder" v={data.embedder} />
            {data.vectors && (
              <Row
                k="vectors"
                v={`${compact(data.vectors.points)} points · ${compact(data.vectors.vectors)} vectors`}
                title={`${exact(data.vectors.points)} points, ${exact(data.vectors.vectors)} vectors across ${data.vectors.segments} segments`}
              />
            )}
            <Row
              k="queue"
              v={data.pending == null ? '—' : `${exact(data.pending)} pending`}
            />
            <Row
              k="errors"
              v={
                data.recentErrors > 0
                  ? `${exact(data.recentErrors)} in the last hour`
                  : 'none in the last hour'
              }
              danger={data.recentErrors > 0}
              title={`${exact(data.errors)} lifetime`}
            />
          </div>
        </section>

        <section>
          <Eyebrow>Storage</Eyebrow>
          <div className="space-y-1 font-mono text-[11px] text-faint">
            <Row k="postgres (disk)" v={bytes(data.storage.postgresBytes)} />
            <Row k="qdrant (disk)" v={bytes(data.storage.qdrantBytes)} />
            <Row k="redis (memory)" v={bytes(data.storage.redisMemoryBytes)} />
          </div>

          {data.storage.collections.length > 0 && (
            <div className="mt-4">
              <Eyebrow>Vector collections</Eyebrow>
              <div className="space-y-1.5">
                {data.storage.collections.map((c) => (
                  <div key={c.name} className="text-[12px]">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11px] truncate flex-1" title={c.name}>
                        {c.name}
                      </span>
                      <span className="font-mono text-[11px] text-muted tabular-nums">
                        {bytes(c.bytes)}
                      </span>
                      <span
                        className="font-mono text-[10px] tracking-widest"
                        style={{ color: c.active ? 'var(--color-git)' : 'var(--color-faint)' }}
                      >
                        {c.active ? 'ACTIVE' : 'STALE'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {staleBytes > 0 && (
            <p
              className="mt-3 rounded-md border px-3 py-2 text-[12px] leading-relaxed"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-report) 40%, transparent)',
                background: 'color-mix(in srgb, var(--color-report) 8%, transparent)',
              }}
            >
              <span style={{ color: 'var(--color-report)' }}>{bytes(staleBytes)} of stale vectors.</span>{' '}
              <span className="text-muted">
                Left behind by an embedding-model change. Nothing reads them; reclaim with{' '}
                <code className="font-mono">docker compose down -v</code> and a reindex, or delete
                the collection in Qdrant.
              </span>
            </p>
          )}
        </section>
      </div>

      <section className="mt-8">
        <Eyebrow>Indexing activity — last 30 days</Eyebrow>
        <ActivityChart activity={data.activity ?? []} />
      </section>

      <section className="mt-8">
        <Eyebrow>What is indexed</Eyebrow>
        <SourceBreakdown
          bySource={data.bySource}
          total={data.entries}
          detail={data.sourceDetail ?? []}
          archivedDocs={data.archivedDocs ?? 0}
        />
      </section>

      {(data.runs ?? []).length > 0 && (
        <section className="mt-8">
          <Eyebrow>Recent index runs</Eyebrow>
          <RecentRuns runs={data.runs} />
        </section>
      )}

      <button
        onClick={() => onGoTo('search')}
        className="mt-8 w-full py-2.5 rounded-md border text-sm"
        style={{
          borderColor: 'var(--color-kdb)',
          color: 'var(--color-kdb)',
          background: 'color-mix(in srgb, var(--color-kdb) 8%, transparent)',
        }}
      >
        Search & Ask →
      </button>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="bg-panel border border-line rounded-md px-4 py-3">
      <div className="font-display text-2xl font-semibold tabular-nums" title={exact(value)}>
        {compact(value)}
      </div>
      <div className="mt-0.5 text-[12px] text-muted">{label}</div>
      {hint && <div className="font-mono text-[10px] text-faint">{hint}</div>}
    </div>
  );
}

function Row({
  k,
  v,
  title,
  danger,
}: {
  k: string;
  v: string;
  title?: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2" title={title}>
      <span className="flex-1">{k}</span>
      <span
        className="text-muted tabular-nums"
        style={danger ? { color: 'var(--color-report)' } : undefined}
      >
        {v}
      </span>
    </div>
  );
}

/**
 * Proportional bars, largest first, now with the inventory behind each bar:
 * distinct files, raw content volume and when this source last saw new data.
 * Zero-count sources are simply absent.
 */
function SourceBreakdown({
  bySource,
  total,
  detail,
  archivedDocs,
}: {
  bySource: Record<string, number>;
  total: number;
  detail: SourceDetailRow[];
  archivedDocs: number;
}) {
  const byType = new Map(detail.map((d) => [d.sourceType, d]));
  const rows = Object.entries(bySource)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!rows.length) return <Empty title="Nothing indexed yet." />;

  const max = rows[0]![1];
  return (
    <div className="space-y-1.5">
      {rows.map(([source, n]) => {
        const meta = SOURCE_META[source as SourceType];
        const d = byType.get(source as SourceType);
        const pct = total > 0 ? Math.round((n / total) * 100) : 0;
        return (
          <div key={source} className="flex items-center gap-3 text-[12px]">
            <span className="font-mono text-[10px] tracking-widest w-28 shrink-0" style={{ color: meta?.color }}>
              {meta?.label ?? source}
            </span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-line)' }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${(n / max) * 100}%`, background: meta?.color ?? 'var(--color-muted)' }}
              />
            </div>
            <span className="font-mono text-[11px] text-muted tabular-nums w-14 text-right" title={exact(n)}>
              {compact(n)}
            </span>
            <span className="font-mono text-[10px] text-faint tabular-nums w-9 text-right">{pct}%</span>
            <span
              className="font-mono text-[10px] text-faint tabular-nums w-40 text-right hidden md:inline"
              title={
                d
                  ? `${plural(d.files, 'file')} · ${exact(d.volumeChars)} chars of content · last new data ${relativeTime(d.lastIndexedAt)}`
                  : undefined
              }
            >
              {d ? `${compact(d.files)} files · ${bytes(d.volumeChars)}` : ''}
            </span>
          </div>
        );
      })}
      {archivedDocs > 0 && (
        <p className="font-mono text-[10px] text-faint pt-1">
          {exact(archivedDocs)} doc sections live under archive-style paths — indexed and
          searchable, downranked in results.
        </p>
      )}
    </div>
  );
}

/**
 * Daily stacked bars of entries indexed (created_at), grouped into the app's
 * source color families. Identity keeps the same colors used everywhere else;
 * exact per-source counts ride in each bar's title. All-zero days still render
 * a hairline so gaps read as "idle", not "missing data".
 */
const ACTIVITY_FAMILIES: { key: string; label: string; color: string; types: SourceType[] }[] = [
  { key: 'kdb', label: 'KDB', color: 'var(--color-kdb)', types: ['kdb_changelog', 'kdb_session', 'kdb_component', 'kdb_backlog'] },
  { key: 'report', label: 'REPORT', color: 'var(--color-report)', types: ['kdb_report'] },
  { key: 'claude', label: 'CLAUDE', color: 'var(--color-claude)', types: ['claude_session'] },
  { key: 'git', label: 'COMMIT', color: 'var(--color-git)', types: ['git_commit'] },
  { key: 'doc', label: 'DOC', color: 'var(--color-doc)', types: ['doc'] },
];

function ActivityChart({ activity }: { activity: ActivityPoint[] }) {
  // Fill the last 30 calendar days so idle days show as gaps, not silence.
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  const perDay = new Map<string, Map<string, number>>();
  for (const p of activity) {
    const fam = ACTIVITY_FAMILIES.find((f) => f.types.includes(p.sourceType))?.key ?? 'doc';
    const m = perDay.get(p.day) ?? new Map<string, number>();
    m.set(fam, (m.get(fam) ?? 0) + p.count);
    perDay.set(p.day, m);
  }
  const totals = days.map((d) => [...(perDay.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  const seen = new Set(activity.map((p) => p.day));
  const anything = seen.size > 0;

  if (!anything) return <Empty title="No indexing activity in the last 30 days." />;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-24" role="img" aria-label="Entries indexed per day, last 30 days">
        {days.map((day, i) => {
          const m = perDay.get(day);
          const total = totals[i]!;
          const breakdown = m
            ? ACTIVITY_FAMILIES.filter((f) => m.has(f.key))
                .map((f) => `${f.label.toLowerCase()} ${exact(m.get(f.key)!)}`)
                .join(', ')
            : 'nothing indexed';
          return (
            <div
              key={day}
              className="flex-1 flex flex-col justify-end h-full"
              title={`${day} — ${plural(total, 'entry', 'entries')}${m ? ` (${breakdown})` : ''}`}
            >
              {total === 0 ? (
                <div className="h-px" style={{ background: 'var(--color-line)' }} />
              ) : (
                ACTIVITY_FAMILIES.filter((f) => m!.has(f.key)).map((f) => (
                  <div
                    key={f.key}
                    className="w-full first:rounded-t-sm"
                    style={{
                      height: `${Math.max((m!.get(f.key)! / max) * 100, 2)}%`,
                      background: f.color,
                      marginTop: 1,
                    }}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
        <span>{days[0]}</span>
        <span title="Peak day">max {exact(max)}/day</span>
        <span>{days.at(-1)}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        {ACTIVITY_FAMILIES.map((f) => (
          <span key={f.key} className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
            <span className="size-2 rounded-sm" style={{ background: f.color }} aria-hidden />
            {f.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Scheduler ticks and manual reindexes: when, how long, how much enqueued. */
function RecentRuns({ runs }: { runs: RunRow[] }) {
  return (
    <div className="space-y-1 font-mono text-[11px] text-faint">
      {runs.slice(0, 6).map((r) => {
        const secs =
          r.startedAt && r.finishedAt
            ? (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000
            : null;
        return (
          <div key={r.id} className="flex items-baseline gap-2">
            <span className="w-24 shrink-0">{r.kind}</span>
            <span className="text-muted">{relativeTime(r.startedAt)}</span>
            <span className="flex-1" />
            {r.stats?.enqueued != null && (
              <span className="tabular-nums">{plural(Number(r.stats.enqueued), 'job')}</span>
            )}
            <span className="tabular-nums w-14 text-right">
              {r.finishedAt ? duration(secs) : 'running…'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
