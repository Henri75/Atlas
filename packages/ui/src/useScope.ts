import { useCallback, useMemo } from 'react';
import { removeSlug, scopeOf, toggleSlug, type Scope } from '@atlas/shared';
import { usePersistentState } from './usePersistentState';

export type { Scope };

/** The full handle the hook returns: shared read semantics + web mutators. */
export type ScopeHandle = ReturnType<typeof useScope>;

/**
 * The selected projects — the app's one answer to "what am I looking at?".
 *
 * Project usage in Atlas has two shapes, and this hook serves both without
 * forcing either to change:
 *
 *  - **A filter.** Search, Ask and Timeline narrow their results to *any of*
 *    the selected projects. They read `projects`.
 *  - **A resource.** Components and Sessions *browse* one project — a component
 *    named `ui` in two projects is two different things, and merging them would
 *    be a lie. They read `project`, which is non-null only when exactly one is
 *    selected, and otherwise show their existing "pick a project" state.
 *
 * The pure semantics live in @atlas/shared (`scopeOf` et al.); this hook adds
 * the web's persistence layer.
 */
export function useScope(): Scope & {
  toggle: (slug: string) => void;
  remove: (slug: string) => void;
  set: (slugs: string[]) => void;
  clear: () => void;
} {
  const [projects, setProjects] = usePersistentState<string[]>('atlas.scope.projects', []);

  const toggle = useCallback(
    (slug: string) => setProjects((prev) => toggleSlug(prev, slug)),
    [setProjects],
  );

  const remove = useCallback(
    (slug: string) => setProjects((prev) => removeSlug(prev, slug)),
    [setProjects],
  );

  const clear = useCallback(() => setProjects([]), [setProjects]);

  return useMemo(
    () => ({
      ...scopeOf(projects),
      toggle,
      remove,
      set: setProjects,
      clear,
    }),
    [projects, toggle, remove, setProjects, clear],
  );
}

/** The wire format for the project filter: a list, or undefined for "all". */
export { scopeParam } from '@atlas/shared';
