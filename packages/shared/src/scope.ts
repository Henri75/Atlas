/**
 * The selected projects — the app's one answer to "what am I looking at?".
 *
 * Project usage in Atlas has two shapes:
 *
 *  - **A filter.** Search, Ask and Timeline narrow their results to *any of*
 *    the selected projects.
 *  - **A resource.** Components and Sessions *browse* one project — a
 *    component named `ui` in two projects is two different things. They need
 *    `project`, which is non-null only when exactly one is selected.
 *
 * The pure semantics live here (shared by web and native); each platform's
 * hook adds its own persistence layer on top.
 */

/** Every selected project. Empty means *all projects*, not *none*. */
export type ScopeProjects = string[];

export interface Scope {
  /** Every selected project. Empty means *all projects*, not *none*. */
  projects: string[];
  /** The single selected project, or null at 0 or 2+. */
  project: string | null;
  /** True when nothing is selected — i.e. the scope spans everything. */
  isAll: boolean;
  /** True when results can span projects, so rows need a project tag. */
  isMulti: boolean;
}

/** Derive the read-only view of a selection. Pure; identical on every platform. */
export function scopeOf(projects: string[]): Scope {
  return {
    projects,
    // Exactly one, or nothing. Two selected projects do not "mean" the first.
    project: projects.length === 1 ? projects[0]! : null,
    isAll: projects.length === 0,
    // An unscoped search also spans projects, so it needs the tag just as much
    // as an explicit multi-selection does.
    isMulti: projects.length !== 1,
  };
}

/** Toggle one slug in a selection (pure — returns the next array). */
export function toggleSlug(prev: string[], slug: string): string[] {
  return prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
}

/** Remove one slug from a selection (pure). */
export function removeSlug(prev: string[], slug: string): string[] {
  return prev.filter((s) => s !== slug);
}

/** The wire format for the project filter: a list, or undefined for "all". */
export function scopeParam(projects: string[]): string | undefined {
  return projects.length ? projects.join(',') : undefined;
}
