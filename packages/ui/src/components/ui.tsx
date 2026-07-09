import type { ReactNode } from 'react';
import { SOURCE_META, type SourceType } from '../types';

/** Small shared pieces: source badge, spine row, date stamp, empty state. */

export function Badge({ source }: { source: SourceType }) {
  const m = SOURCE_META[source] ?? { label: source, color: 'var(--color-muted)' };
  return (
    <span
      className="font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm"
      style={{ color: m.color, background: `color-mix(in srgb, ${m.color} 12%, transparent)` }}
    >
      {m.label}
    </span>
  );
}

/** The signature element: every record carries a spine in its source color. */
export function SpineRow({
  source,
  children,
  onClick,
}: {
  source: SourceType;
  children: ReactNode;
  onClick?: () => void;
}) {
  const color = SOURCE_META[source]?.color ?? 'var(--color-muted)';
  return (
    <div
      className={`rise border-l-[3px] bg-panel hover:bg-panel-2 transition-colors px-3 py-2.5 rounded-r-md ${onClick ? 'cursor-pointer' : ''}`}
      style={{ borderLeftColor: color }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
    >
      {children}
    </div>
  );
}

export function Stamp({ iso }: { iso?: string }) {
  if (!iso) return null;
  return (
    <time className="font-mono text-[11px] text-faint whitespace-nowrap">
      {iso.slice(0, 16).replace('T', ' ')}
    </time>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-display uppercase tracking-[0.18em] text-[11px] text-muted mb-2">
      {children}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="text-center py-16">
      <p className="text-muted">{title}</p>
      {hint && <p className="text-faint text-sm mt-1">{hint}</p>}
    </div>
  );
}

/**
 * Empty state for the views that need a project. Telling someone to "pick a
 * project" without offering the choice right here is a dead end — the sidebar
 * is easy to miss, and it scrolls.
 */
export function PickProject({
  what,
  projects,
  onProject,
}: {
  what: string;
  projects: { slug: string; entryCount: number }[];
  onProject: (slug: string) => void;
}) {
  if (!projects.length) {
    return (
      <Empty
        title="No projects indexed yet."
        hint="The first scan may still be running — check the footer, or run `kdbs status`."
      />
    );
  }
  return (
    <div className="max-w-3xl mx-auto py-12">
      <p className="text-muted text-center">Choose a project to see its {what}.</p>
      <div className="mt-6 flex flex-wrap gap-2 justify-center">
        {projects.slice(0, 24).map((p) => (
          <button
            key={p.slug}
            onClick={() => onProject(p.slug)}
            className="rounded-md border border-line bg-panel px-3 py-1.5 text-[13px] text-muted hover:text-ink hover:border-faint"
          >
            {p.slug}
            <span className="ml-2 font-mono text-[10px] text-faint">{p.entryCount}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Spinner() {
  return <div className="text-faint font-mono text-sm py-8 text-center">querying…</div>;
}

/** Client-side filter box. Lists here are small and already in memory. */
export function FilterInput({
  value,
  onChange,
  placeholder,
  count,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** "showing N of M" — silence about what a filter hid is its own bug. */
  count?: { shown: number; total: number };
}) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="flex-1 bg-panel border border-line rounded-md px-3 py-1.5 text-[13px] placeholder:text-faint"
      />
      {value && (
        <button onClick={() => onChange('')} className="text-[12px] text-muted hover:text-ink">
          clear
        </button>
      )}
      {count && (
        <span className="font-mono text-[11px] text-faint whitespace-nowrap">
          {count.shown === count.total
            ? `${count.total}`
            : `${count.shown} of ${count.total}`}
        </span>
      )}
    </div>
  );
}

/** Case-insensitive substring match, safe for empty needles. */
export function matches(haystack: string | undefined, needle: string): boolean {
  if (!needle) return true;
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

/** Highlight every occurrence of `needle` without interpreting it as regex. */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const at = lower.indexOf(target, i);
    if (at === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (at > i) parts.push(text.slice(i, at));
    parts.push(
      <mark
        key={key++}
        className="rounded-sm px-0.5"
        style={{ background: 'color-mix(in srgb, var(--color-kdb) 30%, transparent)', color: 'inherit' }}
      >
        {text.slice(at, at + target.length)}
      </mark>,
    );
    i = at + target.length;
  }
  return <>{parts}</>;
}

/**
 * Search degrades silently by design (hybrid → sparse-only → Postgres FTS), so
 * the only sign is result quality. Say what broke and what it costs, at the
 * weight of a warning — a grey footnote next to the timing goes unread.
 */
const DEGRADED: Record<string, { what: string; cost: string }> = {
  'sparse-only': {
    what: 'The embedding provider is unreachable',
    cost: 'Keyword matching only — semantically similar wording will be missed.',
  },
  fts: {
    what: 'The vector index is unreachable',
    cost: 'Falling back to Postgres text search — ranking and recall are weaker.',
  },
};

export function DegradedBanner({ mode }: { mode: string }) {
  const info = DEGRADED[mode];
  if (!info) return null;
  return (
    <div
      role="status"
      className="mb-3 rounded-md border px-3 py-2 text-[12px] leading-relaxed"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-report) 40%, transparent)',
        background: 'color-mix(in srgb, var(--color-report) 8%, transparent)',
      }}
    >
      <span style={{ color: 'var(--color-report)' }}>Degraded search · {info.what}.</span>{' '}
      <span className="text-muted">{info.cost}</span>
    </div>
  );
}
