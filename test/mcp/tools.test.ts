import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS, SOURCE_TYPES, TOOLS } from '../../packages/mcp/src/tools.js';

describe('MCP tool registry', () => {
  it('exposes the expected tools', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'atlas_ask',
      'atlas_component_history',
      'atlas_components',
      'atlas_entry',
      'atlas_projects',
      'atlas_reindex',
      'atlas_search',
      'atlas_session',
      'atlas_status',
      'atlas_timeline',
    ]);
  });

  // The product is Atlas; "KDB" is one of the four things it indexes. Tools name
  // the product, source types name the data, and conflating them is exactly the
  // bug a well-meaning global rename introduces — silently, since a bad source
  // type just returns no hits. These two guard the boundary in both directions.
  it('every tool is atlas_*, never kdb_* (tools name the product)', () => {
    for (const t of TOOLS) {
      expect(t.name.startsWith('atlas_'), `${t.name} must be atlas_*`).toBe(true);
      expect(t.name.startsWith('kdb_'), `${t.name} must not be kdb_*`).toBe(false);
    }
  });

  it('the KDB source types keep their kdb_ prefix (they name the data)', () => {
    // Pinned against the exported enum, not against request() — request() just
    // serialises whatever it is handed, so it would happily pass a renamed type
    // straight through to an API that rejects it, and the search would return
    // nothing with no error anywhere.
    expect([...SOURCE_TYPES]).toEqual([
      'kdb_changelog', 'kdb_session', 'kdb_component', 'kdb_backlog',
      'kdb_report', 'claude_session', 'git_commit', 'doc',
    ]);
  });

  it('atlas_entry fetches one full entry by id', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_entry')!;
    expect(t.request({ entry_id: 2018 }).path).toBe('/api/entries/2018');
  });

  it('every tool has a description and a request mapper', () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(typeof t.request).toBe('function');
    }
  });

  it('atlas_search maps args to query string', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_search')!;
    const { path } = t.request({ query: 'video import bug', project: 'deepcast', limit: 5 });
    expect(path).toBe('/api/search?q=video+import+bug&project=deepcast&limit=5');
  });

  /** A silently dropped filter would give agents wrong answers, not an error. */
  it('atlas_search forwards the kind filter', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_search')!;
    expect(t.request({ query: 'qdrant', kind: 'insight' }).path).toBe(
      '/api/search?q=qdrant&kind=insight',
    );
  });

  it('atlas_search forwards doc_status as the docStatus param', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_search')!;
    expect(t.request({ query: 'auth flow', doc_status: 'active' }).path).toBe(
      '/api/search?q=auth+flow&docStatus=active',
    );
  });

  it('atlas_ask posts a JSON body', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_ask')!;
    const { path, init } = t.request({ question: 'what changed?' });
    expect(path).toBe('/api/ask');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'what changed?' });
  });

  it('atlas_component_history URL-encodes path params', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_component_history')!;
    const { path } = t.request({ project: 'deepcast', component: 'video import' });
    expect(path).toBe('/api/projects/deepcast/components/video%20import?limit=20&max_body=2000');
  });
});

/**
 * The session and component-history tools proxy endpoints that can serialise
 * to tens of thousands of tokens. The MCP layer is the context-budgeted
 * consumer, so IT must ask for the caps — the API defaults to full output.
 */
describe('context-budget defaults', () => {
  it('atlas_session asks for a bounded page unless told otherwise', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_session')!;
    expect(t.request({ session_id: 'abc' }).path).toBe('/api/sessions/abc?limit=50&max_body=1500');
  });

  it('atlas_session forwards explicit paging', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_session')!;
    expect(t.request({ session_id: 'abc', limit: 10, offset: 50, max_body: 500 }).path).toBe(
      '/api/sessions/abc?limit=10&offset=50&max_body=500',
    );
  });

  it('atlas_component_history bounds entries and bodies by default', () => {
    const t = TOOLS.find((t) => t.name === 'atlas_component_history')!;
    expect(t.request({ project: 'kdb', component: 'atlas' }).path).toBe(
      '/api/projects/kdb/components/atlas?limit=20&max_body=2000',
    );
  });
});

/**
 * Atlas is beta and its Ask answers come from a mid-size LLM. Agents must be
 * told to verify, and the only cross-tool channel for that is the server
 * instructions — pin the load-bearing phrases so a rewrite can't drop them.
 */
describe('server instructions', () => {
  it('carry the beta caveat and the verify guidance', () => {
    expect(SERVER_INSTRUCTIONS).toContain('BETA');
    expect(SERVER_INSTRUCTIONS).toMatch(/verify|read the cited source/i);
    expect(SERVER_INSTRUCTIONS).toContain('atlas_entry');
  });

  it('warn about wrong project scoping, the main false-negative source', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/UNSCOPED/);
  });
});

/** The user wants every agent to report its Atlas usage; pin the duty. */
it('server instructions require an Atlas-usage note in agent reports', () => {
  expect(SERVER_INSTRUCTIONS).toContain('Atlas usage');
  expect(SERVER_INSTRUCTIONS).toMatch(/1-5 usefulness rating/);
});
