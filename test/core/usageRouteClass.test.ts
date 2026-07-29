import { describe, expect, it } from 'vitest';
import { ROUTE_CLASSES, routeClass } from '@atlas/core';

/**
 * Table-driven over every route the API actually defines. The point of this
 * test is coverage of the real surface: a route added to app.ts without a
 * classification silently lands in `other`, and `other` growing is the signal
 * that this function has fallen behind.
 */
describe('routeClass', () => {
  it.each([
    // Consumes the index, and sometimes the LLM — the traffic worth watching.
    ['/api/search', 'query'],
    ['/api/ask', 'query'],
    ['/api/ask/stream', 'query'],
    ['/api/projects/atlas/backlog/review', 'query'],

    // Cheap catalog reads: navigation and follow-up.
    ['/api/projects', 'read'],
    ['/api/timeline', 'read'],
    ['/api/projects/atlas/timeline', 'read'],
    ['/api/projects/atlas/components', 'read'],
    ['/api/projects/atlas/components/indexer', 'read'],
    ['/api/projects/atlas/sessions', 'read'],
    ['/api/projects/atlas/backlog', 'read'],
    ['/api/sessions/9fff7d2a-1111-2222-3333-444455556666', 'read'],
    ['/api/entries/12345', 'read'],

    // Mutates durable state.
    ['/api/projects/atlas/backlog/verdict', 'write'],

    // Health and polling — the noise this classification exists to separate.
    ['/api/health', 'status'],
    ['/api/stats', 'status'],
    ['/api/dashboard', 'status'],

    // Operational, including the monitor observing itself.
    ['/api/admin/reindex', 'admin'],
    ['/api/admin/errors', 'admin'],
    ['/api/admin/usage', 'admin'],
    ['/api/admin/usage/calls', 'admin'],
    ['/api/admin/usage/calls/42', 'admin'],
    ['/api/admin/adoption', 'admin'],
    ['/api/admin/adoption/refresh', 'admin'],
  ])('classifies %s as %s', (path, expected) => {
    expect(routeClass(path)).toBe(expected);
  });

  it('files an unrecognised path under "other" rather than guessing', () => {
    expect(routeClass('/api/something-new')).toBe('other');
    expect(routeClass('/not-the-api')).toBe('other');
    expect(routeClass('')).toBe('other');
  });

  /**
   * A trailing slash is the same route. Letting it fall to `other` would split
   * one route's traffic across two buckets and quietly understate it.
   */
  it('ignores a trailing slash', () => {
    expect(routeClass('/api/search/')).toBe('query');
    expect(routeClass('/api/projects/')).toBe('read');
  });

  /**
   * A slug is user-controlled. It must never be able to reclassify the route
   * it appears in — otherwise a project literally named "admin" would file its
   * ordinary reads under operational traffic.
   */
  it('is not fooled by a slug that looks like a route segment', () => {
    expect(routeClass('/api/projects/admin/sessions')).toBe('read');
    expect(routeClass('/api/projects/search/timeline')).toBe('read');
    expect(routeClass('/api/projects/stats/backlog')).toBe('read');
  });

  it('exposes every class it can return', () => {
    const produced = new Set(
      [
        '/api/search',
        '/api/projects',
        '/api/projects/atlas/backlog/verdict',
        '/api/stats',
        '/api/admin/usage',
        '/api/nope',
      ].map(routeClass),
    );
    expect(new Set(ROUTE_CLASSES)).toEqual(produced);
  });
});
