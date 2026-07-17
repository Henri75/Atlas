import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SOURCE_META, type SourceType } from '../types';

/** Small shared pieces: source badge, spine row, date stamp, empty state. */

/**
 * Checkbox popover for picking a subset of options: all, one, or several —
 * the single-select dropdown could only do all-or-one. The trigger summarizes
 * the selection ("all sources" / "doc" / "3 sources") so the current filter is
 * always legible without opening it.
 */
export function MultiSelect<T extends string>({
  options,
  selected,
  onChange,
  allLabel,
  label,
  render,
}: {
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
  /** Shown on the trigger and as the "select all/none" row when empty = all. */
  allLabel: string;
  /** aria-label for the trigger. */
  label: string;
  /** Optional per-option label; defaults to the raw value. */
  render?: (v: T) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-away closes it; a popover left open on scroll/navigation is noise.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (render?.(selected[0]) ?? selected[0])
        : `${selected.length} selected`;

  const toggle = (v: T) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        className="bg-panel border border-line rounded-md px-2 py-3 text-sm text-muted font-mono hover:border-faint whitespace-nowrap"
      >
        {summary} <span className="text-faint">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 min-w-[12rem] max-h-72 overflow-auto bg-panel border border-line rounded-md p-1 shadow-lg">
          <button
            type="button"
            onClick={() => onChange([])}
            className={`w-full text-left px-2 py-1.5 rounded text-sm font-mono hover:bg-panel-2 ${
              selected.length === 0 ? 'text-ink' : 'text-muted'
            }`}
          >
            {selected.length === 0 ? '● ' : '○ '}
            {allLabel}
          </button>
          <div className="my-1 border-t border-line" />
          {options.map((v) => {
            const on = selected.includes(v);
            return (
              <button
                key={v}
                type="button"
                onClick={() => toggle(v)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm font-mono hover:bg-panel-2 ${
                  on ? 'text-ink' : 'text-muted'
                }`}
              >
                {on ? '☑ ' : '☐ '}
                {render?.(v) ?? v}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Search and Ask are not two actions on one box — they are two *modes* of one
 * instrument, producing two different surfaces: a browsable list of records, or
 * a synthesized answer that opens a conversation.
 *
 * As twin submit buttons they read as peers and forced the user to learn a
 * secret handshake (⌘Enter) to reach the second one. As a segmented control they
 * announce that a choice exists, show which one is armed, and let Enter mean the
 * same thing in both.
 */
export function ModeSwitch<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: string; accent?: boolean }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex bg-panel border border-line rounded-lg p-0.5 gap-0.5"
    >
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] transition-colors ${
              on ? 'text-ink' : 'text-muted hover:text-ink'
            }`}
            style={
              on
                ? o.accent
                  ? {
                      // Ask is the generative mode; it carries the accent so the
                      // armed state is unmistakable before you type a word.
                      background: 'color-mix(in srgb, var(--color-kdb) 12%, transparent)',
                      boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-kdb) 45%, transparent)',
                      color: 'var(--color-kdb)',
                    }
                  : { background: 'var(--color-panel-2)' }
                : undefined
            }
          >
            {o.icon && (
              <span className="text-[11px]" aria-hidden>
                {o.icon}
              </span>
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Where a record came from. Shown only when the scope spans more than one
 * project — in a single-project view it would be noise on every row.
 */
export function ProjectTag({ slug }: { slug?: string }) {
  // A row from an older API payload may not carry its slug; an empty tag
  // would render as a stray bordered pill.
  if (!slug) return null;
  return (
    <span className="font-mono text-[9.5px] text-muted bg-panel-2 border border-line rounded-sm px-1.5 py-px whitespace-nowrap">
      {slug}
    </span>
  );
}

/**
 * Copy `text` to the clipboard, flashing a check for confirmation. Kept tiny
 * and unstyled-by-default (className passthrough) so it drops into a reply
 * header or a source row alike.
 */
export function CopyButton({
  text,
  title = 'Copy',
  className = '',
}: {
  text: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        // Source rows are themselves buttons; don't also open the entry.
        e.stopPropagation();
        // clipboard API needs a secure context; the app runs on localhost which
        // qualifies. Fail silently rather than throwing into the render tree.
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title={title}
      aria-label={title}
      className={`text-muted hover:text-ink text-[13px] leading-none px-1 ${className}`}
    >
      {copied ? <span style={{ color: 'var(--color-git)' }}>✓</span> : '⧉'}
    </button>
  );
}

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
        hint="The first scan may still be running — check the footer, or run `atlas status`."
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

/**
 * The one "we are working" signal, used by search, ask and retry alike.
 *
 * Static text ("querying…") cannot distinguish a slow request from a hung one:
 * both look identical. A moving indicator says the request is still alive, which
 * is the actual question a waiting user is asking. Motion is CSS-only and is
 * dropped entirely under prefers-reduced-motion (see styles.css).
 */
export function Pulse({ label = 'querying' }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-sm text-faint"
      role="status"
      aria-live="polite"
    >
      <span className="dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {label}…
    </span>
  );
}

/** Block-level wait state for a whole panel (search results, a view). */
export function Spinner({ label = 'querying' }: { label?: string }) {
  return (
    <div className="py-8 text-center">
      <Pulse label={label} />
    </div>
  );
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
