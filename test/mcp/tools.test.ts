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

  /**
   * Observed failure (2026-07-19): an agent investigating why a tool had been
   * rated poorly — a question about recorded past behavior — inferred a root
   * cause from the current code and never queried Atlas, then flagged its own
   * conclusion as unverified. "Use it before re-deriving history" described a
   * state the agent had to notice it was in; these lines describe observable
   * conditions instead. Pin them so a rewrite can't quietly revert to the
   * softer phrasing.
   */
  it('tell agents to query history rather than infer it', () => {
    // The headline has changed twice; what must survive any rewrite is the
    // evidence-vs-reconstruction distinction and where the reasoning lives.
    expect(SERVER_INSTRUCTIONS).toMatch(/Git cannot see intent/);
    expect(SERVER_INSTRUCTIONS).toMatch(/is reconstruction/);
    expect(SERVER_INSTRUCTIONS).toMatch(/session transcripts/);
  });

  it('name the hedging phrases that signal a missing Atlas call', () => {
    for (const tell of ['presumably', 'likely because', 'could not verify']) {
      expect(SERVER_INSTRUCTIONS).toContain(tell);
    }
  });

  /**
   * Agent feedback (2026-07-19, second round): an agent reached for `git log -S`,
   * got the exact commit, and never called Atlas — then guessed at WHY the change
   * was made and shipped that guess unverified. Its own proposed fix was sharper
   * than the abstract "before re-deriving history": key the trigger on the seam
   * where git stops answering. Pin it — this is the single most discriminating
   * line in these instructions.
   */
  it('key the primary trigger on the git WHAT -> WHY seam', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/told you WHAT changed AND you are about to say WHY/);
    // It must also concede git's superiority, or agents correctly ignore it.
    expect(SERVER_INSTRUCTIONS).toMatch(/DO NOT route to Atlas/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Git, grep and the live DB answer those better/);
  });

  /**
   * The beta caveat ("verify everything") makes Atlas a bad trade against git —
   * correctly. Left unqualified it also suppresses use on intent questions, where
   * the real alternative is an unverified guess rather than a cheaper tool.
   */
  it('scope the verification-cost argument to what git can settle', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/it is a guess you will never verify at all/);
    expect(SERVER_INSTRUCTIONS).toMatch(/not against a cheaper tool that cannot/);
  });

  /** Agents reach for tools when blocked; a WHY question never blocks. */
  it('name confidence, not friction, as the moment it applies', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/CONFIDENCE, NOT FRICTION/);
    expect(SERVER_INSTRUCTIONS).toMatch(/will not feel stuck/);
  });

  /**
   * Assessor's review of these instructions (session eb99ff9d, 2026-07-19):
   * dense prose buries executable triggers, so restructure rather than cut —
   * IF/THEN rules first, rationale demoted to a labeled background section.
   * Pin the shape, since it is the fix, not the wording.
   */
  it('put executable triggers above the rationale', () => {
    const triggers = SERVER_INSTRUCTIONS.indexOf('== TRIGGERS ==');
    const why = SERVER_INSTRUCTIONS.indexOf('WHY THESE TRIGGERS');
    expect(triggers).toBeGreaterThan(-1);
    expect(why).toBeGreaterThan(triggers);
    expect(SERVER_INSTRUCTIONS).toMatch(/the rules above are the operative part/);
    // IF/THEN form, not prose the agent has to parse into conditions. Counted
    // as IF-openers and -> CALL arrows separately: longer triggers wrap onto a
    // continuation line, so the pair is not always on one line.
    expect(SERVER_INSTRUCTIONS.match(/^IF /gm)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(SERVER_INSTRUCTIONS.match(/-> CALL/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  /** A justification built after the fact hides the gap that caused the skip. */
  it('demand the honest skip rather than a defensible one', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Report the skip you ACTUALLY made/);
    expect(SERVER_INSTRUCTIONS).toMatch(/reconstructed justification/);
  });

  /** An unreachable tool must not silently downgrade a claim to a guess. */
  it('handle mid-task disconnection explicitly', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/unreachable mid-task/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/UNVERIFIED/);
  });

  /**
   * Observed 2026-07-19: an agent lost the atlas_* tools when `make restart`
   * recreated the mcp container mid-session, and they never returned — the
   * server is stateless (sessionIdGenerator: undefined in main.ts), so it holds
   * no client reference to push tools/list_changed down. The instructions used
   * to say "if it comes back, revisit what you deferred", which promises a
   * recovery that cannot happen and leaves the agent waiting instead of using
   * the HTTP API. Pin the correction: no self-recovery, name the fallback.
   */
  it('state that dropped tools do not return, and give the fallback', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/do NOT come back on their own/);
    expect(SERVER_INSTRUCTIONS).toMatch(/stateless/i);
    // The actionable half: an agent without tools still has the REST API.
    expect(SERVER_INSTRUCTIONS).toMatch(/query the HTTP API directly/i);
    // The false promise must not creep back in a rewrite.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/If it comes back, revisit/);
  });
});

/** The user wants every agent to report its Atlas usage; pin the duty. */
it('server instructions require an Atlas-usage note in agent reports', () => {
  expect(SERVER_INSTRUCTIONS).toContain('Atlas usage');
  expect(SERVER_INSTRUCTIONS).toMatch(/1-5 usefulness rating/);
});

/**
 * The duty used to fire only "if you used Atlas", so not using it was the one
 * outcome that produced no signal — and silence is indistinguishable from
 * "correctly skipped". Reporting the skip is what surfaces "did not think of
 * it", the case these instructions exist to fix.
 */
it('server instructions require reporting a SKIP, not just a use', () => {
  expect(SERVER_INSTRUCTIONS).toMatch(/did NOT use it/);
  expect(SERVER_INSTRUCTIONS).toMatch(/did not think of it/);
  expect(SERVER_INSTRUCTIONS).toMatch(/silent omission/i);
});

/** atlas_ask is the right first call for "why/what happened" questions. */
it('atlas_ask description points agents at it before code-reading', () => {
  const ask = TOOLS.find((t) => t.name === 'atlas_ask')!;
  expect(ask.description).toMatch(/START HERE/);
  expect(ask.description).toMatch(/before reading code to infer/i);
  // scopeFallback results are not from the requested project; agents must say so.
  expect(ask.description).toMatch(/NOT from the project you asked for/);
});
