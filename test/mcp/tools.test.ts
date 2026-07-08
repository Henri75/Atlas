import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../packages/mcp/src/tools.js';

describe('MCP tool registry', () => {
  it('exposes the 9 tools from the design spec', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'kdb_ask',
      'kdb_component_history',
      'kdb_components',
      'kdb_projects',
      'kdb_reindex',
      'kdb_search',
      'kdb_session',
      'kdb_status',
      'kdb_timeline',
    ]);
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
