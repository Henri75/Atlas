import type { ReactNode } from 'react';
import { CLIENT_COLORS, clientColor, compact, exact, millis } from '@atlas/shared';

/**
 * Chart primitives, hand-rolled from flex/SVG and CSS custom properties.
 *
 * No charting library, for the same reason the existing ActivityChart has none:
 * Atlas binds each hue to a data meaning (--color-kdb is KDB, --color-claude is
 * Claude, and so on), so a library would have to be themed back to a palette it
 * knows nothing about. Hand-rolled marks *are* the design system rather than an
 * approximation of it, and at these volumes — dozens of buckets, not millions of
 * points — nothing is being bought by the dependency.
 *
 * Every chart here must read correctly at three sizes of nothing: no data at
 * all, a single point, and one non-zero value among many zeroes. A monitoring
 * chart that looks broken when nothing has happened teaches you to distrust it
 * when something has.
 *
 * The client→color mapping lives in @atlas/shared so the native charts label
 * identical clients with identical hues.
 */
export { CLIENT_COLORS, clientColor };

/** A zero-height rule, so an empty bucket is visibly empty rather than missing. */
function EmptyRule() {
  return <div className="h-px w-full" style={{ background: 'var(--color-line)' }} />;
}

export interface StackedDay {
  /** ISO date, YYYY-MM-DD. */
  day: string;
  /** Calls per client on that day. */
  byClient: Record<string, number>;
}

/**
 * Daily stacked bars. Fills every calendar day in the window so an idle day
 * shows as a gap in a continuous axis — omitting it would compress the timeline
 * and make sporadic use look regular.
 */
export function Bars({
  days,
  height = 'h-28',
  label,
}: {
  days: StackedDay[];
  height?: string;
  label: string;
}) {
  const totals = days.map((d) => Object.values(d.byClient).reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  const anything = totals.some((t) => t > 0);

  return (
    <div>
      <div className={`flex items-end gap-[3px] ${height}`} role="img" aria-label={label}>
        {days.map((d, i) => {
          const total = totals[i]!;
          const clients = Object.entries(d.byClient).filter(([, n]) => n > 0);
          const breakdown = clients.length
            ? clients.map(([c, n]) => `${c} ${exact(n)}`).join(', ')
            : 'nothing';
          return (
            <div
              key={d.day}
              className="flex-1 flex flex-col justify-end h-full min-w-0"
              title={`${d.day} — ${exact(total)} call${total === 1 ? '' : 's'} (${breakdown})`}
            >
              {total === 0 ? (
                <EmptyRule />
              ) : (
                clients.map(([client, n]) => (
                  <div
                    key={client}
                    className="w-full first:rounded-t-sm"
                    style={{
                      // A 2% floor: a single call among thousands still has to be
                      // visible, or the chart quietly reports it as zero.
                      height: `${Math.max((n / max) * 100, 2)}%`,
                      background: clientColor(client),
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
        <span>{days[0]?.day ?? ''}</span>
        {anything ? <span title="Busiest day">peak {exact(max)}/day</span> : <span>no calls</span>}
        <span>{days.at(-1)?.day ?? ''}</span>
      </div>
    </div>
  );
}

/**
 * Inline trend for one table row. Deliberately axis-less and label-less: at
 * ~60px wide it can only honestly convey shape, and the precise numbers are in
 * the columns beside it.
 */
export function Sparkline({
  values,
  color = 'var(--color-kdb)',
  label,
}: {
  values: number[];
  color?: string;
  label: string;
}) {
  const w = 64;
  const h = 18;
  if (values.length === 0) return <span className="text-faint font-mono text-[10px]">—</span>;

  const max = Math.max(...values, 1);
  // A single point has no line to draw; render it as a dot rather than an
  // invisible zero-length path.
  if (values.length === 1) {
    return (
      <svg width={w} height={h} role="img" aria-label={label}>
        <circle cx={w / 2} cy={h - (values[0]! / max) * (h - 2) - 1} r={2} fill={color} />
      </svg>
    );
  }

  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${i * step},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg width={w} height={h} role="img" aria-label={label} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Calls by hour of day, 24 cells.
 *
 * This replaced an hour×weekday heatmap. 168 cells against a few hundred calls a
 * month averages roughly one call per cell, which renders as scattered noise
 * rather than a pattern — a chart the data cannot fill. Collapsing the weekday
 * axis puts enough in each cell to actually read.
 */
export function HourStrip({ byHour }: { byHour: { hour: number; calls: number }[] }) {
  const counts = Array.from({ length: 24 }, (_, h) => byHour.find((b) => b.hour === h)?.calls ?? 0);
  const max = Math.max(...counts, 1);
  const total = counts.reduce((a, b) => a + b, 0);

  return (
    <div>
      <div className="flex gap-[2px]" role="img" aria-label="Calls by hour of day, UTC">
        {counts.map((n, h) => (
          <div
            key={h}
            className="flex-1 h-7 rounded-sm"
            title={`${String(h).padStart(2, '0')}:00 UTC — ${exact(n)} call${n === 1 ? '' : 's'}`}
            style={{
              // Opacity rather than hue: this is one quantity, and a rainbow
              // scale would imply categories that do not exist.
              background:
                n === 0
                  ? 'var(--color-line)'
                  : `color-mix(in srgb, var(--color-kdb) ${Math.max(12, (n / max) * 100)}%, var(--color-panel-2))`,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
        <span>00h</span>
        <span>{total > 0 ? `busiest ${exact(max)}/h · UTC` : 'no calls'}</span>
        <span>23h</span>
      </div>
    </div>
  );
}

/**
 * A headline number. Named StatTile, not Stat: DashboardView has its own local
 * `Stat` with a different contract (numeric value, inverted label/value order),
 * and two components called the same thing with different shapes is worse than
 * two names. `hint` carries the unit or caveat, `title` the exact value —
 * compact forms are scannable but lossy, so both are always available.
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</div>
      <div className="font-display text-[22px] font-semibold mt-0.5" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

/** Latency shown as median with the tail beside it — the mean alone hides both. */
export function LatencyPair({ p50, p95 }: { p50: number; p95: number }) {
  return (
    <span className="font-mono text-[11px]" title={`median ${exact(p50)}ms · p95 ${exact(p95)}ms`}>
      {millis(p50)}
      <span className="text-faint"> / {millis(p95)}</span>
    </span>
  );
}

/** Horizontal share bar for a categorical breakdown (route classes). */
export function ShareBar({ parts }: { parts: { key: string; calls: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.calls, 0);
  if (total === 0) return <EmptyRule />;
  return (
    <div className="flex h-2 rounded-full overflow-hidden" role="img" aria-label="Share of calls by route class">
      {parts
        .filter((p) => p.calls > 0)
        .map((p) => (
          <div
            key={p.key}
            style={{ width: `${(p.calls / total) * 100}%`, background: p.color }}
            title={`${p.key} — ${exact(p.calls)} (${Math.round((p.calls / total) * 100)}%)`}
          />
        ))}
    </div>
  );
}

/**
 * Ranked horizontal bars — the right form for "which things, in what
 * proportion" when the labels are words rather than dates.
 *
 * Vertical bars would force the labels to rotate, and a pie would make the
 * comparison that matters (2nd vs 3rd place) the hardest one to read.
 */
export function BarList({
  items,
  max,
  emptyLabel = 'nothing recorded',
}: {
  items: { key: string; calls: number; color?: string; hint?: string }[];
  max?: number;
  emptyLabel?: string;
}) {
  if (items.length === 0) return <p className="text-[12px] text-faint">{emptyLabel}</p>;
  const top = max ?? Math.max(...items.map((i) => i.calls), 1);
  return (
    <div className="space-y-1">
      {items.map((i) => (
        <div key={i.key} className="flex items-center gap-2 text-[12px]" title={i.hint}>
          <span className="w-40 shrink-0 truncate font-mono text-[11px]" title={i.key}>
            {i.key}
          </span>
          <span className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'var(--color-line)' }}>
            <span
              className="block h-full rounded-sm"
              style={{
                // 2px floor rather than a percentage: at the bottom of a ranked
                // list the true width rounds to nothing, and a bar you cannot
                // see reads as a zero.
                width: `max(2px, ${(i.calls / top) * 100}%)`,
                background: i.color ?? 'var(--color-kdb)',
              }}
            />
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-[11px]" title={exact(i.calls)}>
            {compact(i.calls)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Latency distribution over fixed buckets.
 *
 * Buckets are log-ish and supplied by the caller in display order, because
 * latency here spans 1ms to 95s: equal-width buckets would put essentially
 * everything in the first one and report a flat line.
 */
export function Histogram({ buckets }: { buckets: { bucket: string; calls: number }[] }) {
  const max = Math.max(...buckets.map((b) => b.calls), 1);
  const total = buckets.reduce((a, b) => a + b.calls, 0);
  if (total === 0) return <p className="text-[12px] text-faint">no calls in this window</p>;

  return (
    <div>
      <div className="flex items-end gap-1 h-24" role="img" aria-label="Latency distribution">
        {buckets.map((b) => (
          <div key={b.bucket} className="flex-1 flex flex-col justify-end h-full min-w-0">
            <div
              title={`${b.bucket} — ${exact(b.calls)} call${b.calls === 1 ? '' : 's'} (${Math.round((b.calls / total) * 100)}%)`}
              className="w-full rounded-t-sm"
              style={{
                height: b.calls === 0 ? '1px' : `max(3%, ${(b.calls / max) * 100}%)`,
                background: b.calls === 0 ? 'var(--color-line)' : 'var(--color-kdb)',
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {buckets.map((b) => (
          <span key={b.bucket} className="flex-1 min-w-0 text-center font-mono text-[9px] text-faint truncate">
            {b.bucket}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * A single proportion, stated as a number with the bar underneath.
 *
 * `tone` is the caller's judgment, not this component's: a high zero-result rate
 * is bad, a high completion rate is good, and the same 40% means opposite things
 * in the two.
 */
export function Rate({
  label,
  value,
  of,
  hint,
  tone,
}: {
  label: string;
  value: number;
  of: number;
  hint?: string;
  tone?: string;
}) {
  const pct = of > 0 ? value / of : 0;
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className="font-display text-[20px] font-semibold" style={tone ? { color: tone } : undefined}>
          {of > 0 ? `${Math.round(pct * 100)}%` : '—'}
        </span>
        <span className="font-mono text-[10px] text-faint">
          {exact(value)}/{exact(of)}
        </span>
      </div>
      <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-line)' }}>
        <div
          className="h-full"
          style={{ width: `${pct * 100}%`, background: tone ?? 'var(--color-kdb)' }}
        />
      </div>
      {hint && <div className="text-[11px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

/** Shared legend swatch, so every chart labels its colours the same way. */
export function Swatch({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted">
      <span className="size-2 rounded-sm" style={{ background: color }} aria-hidden />
      {children}
    </span>
  );
}
