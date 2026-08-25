import { useCallback, useMemo } from 'react';
import { removeSlug, scopeOf, toggleSlug, type Scope } from '@atlas/shared';
import { usePersistentState } from '../state/prefs';

export type { Scope };

/** The full handle: shared read semantics + mutators (the web hook's shape). */
export type ScopeHandle = ReturnType<typeof useScope>;

/**
 * The selected projects, persisted like the web's ('atlas.scope.projects').
 * Pure semantics come from @atlas/shared; only the storage layer is native.
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
    () => ({ ...scopeOf(projects), toggle, remove, set: setProjects, clear }),
    [projects, toggle, remove, setProjects, clear],
  );
}

/** The wire format for the project filter: a list, or undefined for "all". */
export { scopeParam } from '@atlas/shared';
