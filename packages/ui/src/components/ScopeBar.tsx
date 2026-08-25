import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRow } from '../types';
import type { ScopeHandle } from '../useScope';
import { FilterInput, Highlight, matches } from './ui';
import { compact, exact } from '../format';

/**
 * What the current view is looking at, stated where it can't be missed.
 *
 * Scope used to live in the sidebar, beside the results. But placement encodes
 * authority: a filter that sits *above* its content says "I govern everything
 * below me", while one in a side rail reads as a peer of the navigation. The
 * selection was easy to lose for exactly that reason — and with ~50 projects, a
 * highlighted row scrolled out of the rail is simply invisible, whereas a chip
 * up here is always on screen.
 */
export function ScopeBar({
  scope,
  projects,
  favorites,
  onToggleFavorite,
  /** What a multi-selection means in the current view. Absent when it just works. */
  note,
}: {
  scope: ScopeHandle;
  projects: ProjectRow[];
  favorites: string[];
  onToggleFavorite: (slug: string) => void;
  note?: string;
}) {
  const byslug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);

  return (
    <div
      className="flex items-center gap-2 flex-wrap px-6 py-2.5 border-b border-line"
      style={{
        // A faint wash of the accent, so the bar reads as *chrome that governs*
        // rather than as the first row of content.
        background:
          'linear-gradient(180deg, color-mix(in srgb, var(--color-kdb) 5%, var(--color-panel)) 0%, var(--color-panel) 100%)',
      }}
    >
      <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint select-none">
        Scope
      </span>

      {scope.isAll ? (
        <span className="text-[13px] text-muted">all projects</span>
      ) : (
        scope.projects.map((slug) => (
          <Chip
            key={slug}
            slug={slug}
            count={byslug.get(slug)?.entryCount}
            onRemove={() => scope.remove(slug)}
          />
        ))
      )}

      <AddProject
        scope={scope}
        projects={projects}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
      />

      {!scope.isAll && (
        <button
          onClick={scope.clear}
          className="text-[12px] text-faint hover:text-ink px-1"
          title="Search every project"
        >
          clear
        </button>
      )}

      <div className="ml-auto flex items-center gap-3">
        {note && (
          <span className="font-mono text-[10px]" style={{ color: 'var(--color-report)' }}>
            {note}
          </span>
        )}
        <span className="font-mono text-[10px] text-faint whitespace-nowrap">
          {scope.isAll
            ? `${projects.length} projects`
            : `${scope.projects.length} of ${projects.length}`}
        </span>
      </div>
    </div>
  );
}

/** One selected project. The whole point is that this is impossible to overlook. */
function Chip({
  slug,
  count,
  onRemove,
}: {
  slug: string;
  count?: number;
  onRemove: () => void;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[12.5px] pl-2.5 pr-1.5 py-[3px] rounded-full rise"
      style={{
        background: 'color-mix(in srgb, var(--color-kdb) 14%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-kdb) 45%, transparent)',
      }}
    >
      {slug}
      {count !== undefined && (
        <span
          className="font-mono text-[9.5px] tabular-nums"
          style={{ color: 'var(--color-kdb)' }}
          title={`${exact(count)} entries`}
        >
          {compact(count)}
        </span>
      )}
      <button
        onClick={onRemove}
        aria-label={`Remove ${slug} from scope`}
        title={`Remove ${slug}`}
        className="text-faint hover:text-ink leading-none text-[13px] px-0.5"
      >
        ✕
      </button>
    </span>
  );
}

/**
 * The project picker. Favourites float to the top while browsing, but the
 * grouping flattens the moment you type — a pinned favourite must never outrank
 * a better match, or the filter breaks the one promise it makes.
 */
function AddProject({
  scope,
  projects,
  favorites,
  onToggleFavorite,
}: {
  scope: ScopeHandle;
  projects: ProjectRow[];
  favorites: string[];
  onToggleFavorite: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const shown = useMemo(
    () => projects.filter((p) => matches(p.slug, filter)),
    [projects, filter],
  );
  const filtering = filter.trim().length > 0;
  const favShown = filtering ? [] : shown.filter((p) => favSet.has(p.slug));
  const restShown = filtering ? shown : shown.filter((p) => !favSet.has(p.slug));

  const row = (p: ProjectRow) => {
    const on = scope.projects.includes(p.slug);
    return (
      <div
        key={p.slug}
        className={`group/row flex items-center gap-2 rounded text-[13px] ${
          on ? 'text-ink' : 'text-muted'
        } hover:bg-panel-2`}
      >
        <button
          onClick={() => scope.toggle(p.slug)}
          className="flex-1 min-w-0 flex items-center gap-2 text-left px-2 py-1.5"
          title={p.rootPath}
          aria-pressed={on}
        >
          <span
            className="size-3.5 rounded-[3px] shrink-0 grid place-items-center text-[9px]"
            style={{
              background: on ? 'var(--color-kdb)' : 'transparent',
              border: `1px solid ${on ? 'var(--color-kdb)' : 'var(--color-line)'}`,
              color: 'var(--color-bg)',
            }}
            aria-hidden
          >
            {on ? '✓' : ''}
          </span>
          <span className="truncate flex-1">
            <Highlight text={p.slug} needle={filter} />
          </span>
          <span
            className="font-mono text-[10px] text-faint tabular-nums"
            title={`${exact(p.entryCount)} entries`}
          >
            {compact(p.entryCount)}
          </span>
        </button>
        <button
          onClick={() => onToggleFavorite(p.slug)}
          className={`pr-2 text-[11px] leading-none ${
            favSet.has(p.slug)
              ? 'opacity-100'
              : 'opacity-0 group-hover/row:opacity-100 focus:opacity-100 text-faint hover:text-ink'
          }`}
          style={favSet.has(p.slug) ? { color: 'var(--color-kdb)' } : undefined}
          aria-label={
            favSet.has(p.slug) ? `Unfavourite ${p.slug}` : `Favourite ${p.slug}`
          }
          aria-pressed={favSet.has(p.slug)}
        >
          {favSet.has(p.slug) ? '★' : '☆'}
        </button>
      </div>
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Add a project to the scope"
        className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink px-2.5 py-[3px] rounded-full border border-dashed border-line hover:border-faint"
      >
        + add project
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-72 bg-panel border border-line rounded-md p-1.5 shadow-xl rise">
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter projects…"
            count={{ shown: shown.length, total: projects.length }}
          />
          <div className="max-h-72 overflow-y-auto">
            {favShown.length > 0 && (
              <>
                <div className="px-2 pt-1 pb-0.5 font-display uppercase tracking-[0.18em] text-[10px] text-faint">
                  ★ Favourites
                </div>
                {favShown.map(row)}
                <div className="my-1 border-t border-line" />
              </>
            )}
            {restShown.map(row)}
            {shown.length === 0 && (
              <p className="px-2 py-3 text-[12px] text-faint">No project matches “{filter}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
