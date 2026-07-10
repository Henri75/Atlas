import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../packages/mcp/src/tools.js';

describe('MCP tool registry', () => {
  it('exposes the expected tools', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'kdb_ask',
      'kdb_component_history',
      'kdb_components',
      'kdb_entry',
      'kdb_projects',
      'kdb_reindex',
      'kdb_search',
      'kdb_session',
      'kdb_status',
      'kdb_timeline',
    ]);
  });

  it('kdb_entry fetches one full entry by id', () => {
    const t = TOOLS.find((t) => t.name === 'kdb_entry')!;
    expect(t.request({ entry_id: 2018 }).path).toBe('/api/entries/2018');
  });

  it('every tool has a description and a request mapper', () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(typeof t.request).toBe('function');
    }
  });

  it('kdb_search maps args to query string', () => {
    const t = TOOLS.find((t) => t.name === 'kdb_search')!;
    const { path } = t.request({ query: 'video import bug', project: 'deepcast', limit: 5 });
    expect(path).toBe('/api/search?q=video+import+bug&project=deepcast&limit=5');
  });

  /** A silently dropped filter would give agents wrong answers, not an error. */
  it('kdb_search forwards the kind filter', () => {
    const t = TOOLS.find((t) => t.name === 'kdb_search')!;
    expect(t.request({ query: 'qdrant', kind: 'insight' }).path).toBe(
      '/api/search?q=qdrant&kind=insight',
    );
  });

  it('kdb_search forwards doc_status as the docStatus param', () => {
    const t = TOOLS.find((t) => t.name === 'kdb_search')!;
    expect(t.request({ query: 'auth flow', doc_status: 'active' }).path).toBe(
      '/api/search?q=auth+flow&docStatus=active',
    );
  });

  it('kdb_ask posts a JSON body', () => {
    const t = TOOLS.find((t) => t.name === 'kdb_ask')!;
    const { path, init } = t.request({ question: 'what changed?' });
    expect(path).toBe('/api/ask');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'what changed?' });
  });

  it('kdb_component_history URL-encodes path params', () => {
    const t = TOOLS.find((t) => t.name === 'kdb_component_history')!;
    const { path } = t.request({ project: 'deepcast', component: 'video import' });
    expect(path).toBe('/api/projects/deepcast/components/video%20import');
  });
});
