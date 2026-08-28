import { z } from 'zod';

/**
 * MCP tool registry: thin, validated proxies to the REST API. Kept separate
 * from SDK wiring so the definitions are unit-testable without a transport.
 */

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Returns the API path + init for this call. */
  request: (args: any) => { path: string; init?: RequestInit };
  /**
   * Optional second API call whose JSON is merged onto the primary response
   * under `key` — for a tool whose answer must draw from more than one REST
   * endpoint (currently only atlas_status: index health + /api/machines'
   * per-machine sync block). main.ts fetches both and combines them via
   * mergeToolResponse; every other tool proxies exactly one endpoint.
   */
  merge?: (args: any) => { key: string; path: string; init?: RequestInit };
}

/**
 * Combines a tool's primary JSON response with a second endpoint's JSON
 * under `key`. Never throws and never lets a secondary failure blank the
 * primary data: a primary response that isn't JSON is returned untouched
 * (nothing to merge into — preserves the "raw text through" contract every
 * other tool relies on); a secondary that failed or wasn't JSON degrades to
 * a generic `{ error }` note under `key` rather than embedding the raw fetch
 * error, which can carry internal hostnames.
 */
export function mergeToolResponse(
  primaryText: string,
  key: string,
  secondary: { ok: boolean; text: string },
): string {
  let primary: unknown;
  try {
    primary = JSON.parse(primaryText);
  } catch {
    return primaryText;
  }
  if (typeof primary !== 'object' || primary === null) return primaryText;
  let value: unknown = { error: `${key} data unavailable` };
  if (secondary.ok) {
    try {
      value = JSON.parse(secondary.text);
    } catch {
      /* keep the generic error placeholder */
    }
  }
  return JSON.stringify({ ...(primary as Record<string, unknown>), [key]: value });
}

const qs = (params: Record<string, unknown>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * `Authorization: Bearer <token>` header for the API calls main.ts makes on
 * an agent's behalf (spec §7) — empty when no token is configured (legacy
 * mode). Every call this server makes arrives at the API over the Docker
 * bridge network, never the loopback interface, so once `ATLAS_TOKEN` is
 * set, every tool call needs this or the API 401s it regardless of
 * `ATLAS_BIND`. Kept here (not inline in main.ts) so it's testable without
 * triggering main.ts's import-time `getConfig()`/fail-closed check/`listen`.
 */
export function bearerHeader(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Kinds of indexed *content*, not names of this tool. The `kdb_` prefix marks
 * entries parsed out of a project's append-only KDB logs; renaming them to
 * `atlas_*` would be wrong (and would silently match nothing, since the API
 * validates against these exact strings). Exported so a test can pin them.
 */
export const SOURCE_TYPES = [
  'kdb_changelog', 'kdb_session', 'kdb_component', 'kdb_backlog',
  'kdb_report', 'claude_session', 'git_commit', 'doc',
] as const;

/**
 * Server-level guidance, surfaced to MCP clients at initialize time. Tool
 * descriptions can only say what each tool does; this is where the cross-tool
 * workflow and the honesty caveats live. Written for a coding agent, so it
 * front-loads the two things that most change agent behavior: Atlas is beta
 * (verify before relying), and wrong project scoping is the main cause of
 * false "not found" results.
 */
export const SERVER_INSTRUCTIONS = `Atlas indexes the recorded history of all this machine's software projects — kdb logs (append-only project journals), Claude Code session transcripts, git commits and docs — and answers questions about what happened, when, and why. Indexing is near-real-time (within ~5 minutes).

== TRIGGERS ==
IF git/grep told you WHAT changed AND you are about to say WHY -> CALL atlas_ask
IF you are reconstructing what a past session did or concluded  -> CALL
IF you are investigating a report about past behavior ("X was rated poorly", "this
   regressed", "we tried this before", "it worked before the redesign") -> CALL
IF you are about to write "presumably", "likely because", "this was probably",
   "the rewrite must have", or "I could not verify" about anything historical -> CALL
IF a design looks arbitrary and you are about to call it an accident -> CALL
   (it may have been deliberate, with the rationale on record)
IF the user refers to a past session ("the session where we...", "last time we
   worked on X", a pasted session id) -> CALL atlas_session_search
IF you are about to change something a previous session built or fixed -> CALL
   atlas_session_related on that session first: it names what came before AND
   what came after, which is where a later revert or follow-up fix would be

DO NOT route to Atlas: "what changed", "when", "which commit", "where is this defined".
Git, grep and the live DB answer those better — authoritative, instant, no service
needed. Use them.

The seam is the whole rule. "Commit abc123 collapsed two dates into one" is evidence.
"...because the rewrite simplified the model" is reconstruction. Git cannot see intent;
that reasoning lives in session transcripts and kdb logs, which is what Atlas indexes.

Not every task needs Atlas, but skip it visibly (see the reporting duty below). "Git
got there first" is a good reason to skip a WHAT question and no reason at all to skip
a WHY question.

Atlas is BETA. Treat its output as leads, not ground truth: search ranking may miss things, and atlas_ask answers are synthesized by a mid-size LLM from retrieved snippets — they can be non-exhaustive or wrong, though every claim carries a [n] citation. Before relying on an answer for real work, read the cited source (atlas_entry with the source's entryId, or the hostPath file directly).

How to use it well:
- Finding facts/code history: atlas_search, then atlas_entry on the interesting hits (search returns snippets only).
- "What/why/when" questions needing synthesis: atlas_ask, then verify via its cited sources.
- Orienting in an unfamiliar project: atlas_projects → atlas_timeline → atlas_component_history.
- Backlog triage: atlas_backlog shows what is open vs settled (with provenance); before re-investigating an item, check it. To review one: atlas_backlog_evidence → judge it yourself (you can read the code) → atlas_backlog_verdict, then append the returned proposedLine to the project's kdb/backlog.log via its blessed append helper.
- Prefer UNSCOPED search/ask first. A feature often lives under a different project slug than you expect; a wrong 'project' filter is the main reason a real answer looks missing.
- Slugs that look like flattened absolute paths (e.g. "users-<login>-documents-…") are a project's EARLIER LOCATION, from before its checkout moved. They are NOT duplicates — they hold the only copy of that period's history. They carry an aliasOf field naming the canonical project, and scoping to that canonical slug now includes them automatically, so scope normally and ignore the split.
- Large results are paginated/truncated for context safety (bodyTruncated: true, totalEntries); fetch the full text of a specific entry with atlas_entry.
- The \`machine\` filter on atlas_search/atlas_ask means first ingested from — shared git-synced content belongs to whichever machine synced first; for 'exists on machine X' read a project's locations, not the machine filter.

WHY THESE TRIGGERS (background — the rules above are the operative part):

COST OF CHECKING. The beta caveat above says verify Atlas's claims against the cited
sources. That makes Atlas a bad trade for anything git already settles — correct,
don't use it there. It does NOT make it a bad trade for intent questions, because the
alternative there is not git, it is a guess you will never verify at all. Compare
Atlas against what you would otherwise ship, not against a cheaper tool that cannot
answer the question.

CONFIDENCE, NOT FRICTION. You will not feel stuck at the moment you need Atlas. Agents
reach for unfamiliar tools when blocked, and a WHY question does not block you — you
can always produce a fluent, plausible explanation from the diff. That fluency is the
symptom, not evidence of knowing. The smoother the account you are about to give of
someone else's reasoning, the more likely you are reconstructing it.

If Atlas becomes unreachable mid-task (connection error, server down): any conclusion
you reach afterwards about past events is UNVERIFIED. Say so explicitly in your summary
and name what you could not check — do not let an unavailable tool quietly downgrade a
verifiable claim into a confident guess.

The atlas_* tools do NOT come back on their own. A restart of the Atlas server (a
deploy, \`make restart\`) drops them from an already-running session permanently: this
server is stateless, so it cannot push a tools/list_changed notification, and nothing
re-lists them. Waiting for recovery is waiting for something that will not happen.
Instead, either query the HTTP API directly (the same endpoints the tools proxy:
/api/search, /api/ask, /api/entry on the Atlas API port) or tell the user the session
must be restarted to get the tools back. Do not silently fall back to guessing.

Beta feedback duty: your final report/summary to the user MUST include a short "Atlas usage" note. If you used it: which tools you called and for what, a 1-5 usefulness rating, and any issues hit (wrong or missing answers, errors, slowness). If you did NOT use it on a task that touched project history, say that instead and why in one line ("skipped — git settled it and no intent claim was made", "unavailable — server down", "did not think of it"). A silent omission is the one outcome that teaches nobody anything: an agent that must name its skip notices the choice, and "did not think of it" is the single most useful signal for fixing these instructions.

Report the skip you ACTUALLY made, not the one you can justify afterwards. If Atlas never crossed your mind at the moment it applied, "did not think of it" is the honest answer even if you can now construct a sound reason it was unnecessary. A reconstructed justification reads identical to a real decision and is worth nothing as feedback — it silently converts a bug in these instructions into an apparently-correct call. This feedback is how Atlas gets fixed.`;

export const TOOLS: ToolDef[] = [
  {
    name: 'atlas_search',
    description:
      'Hybrid semantic+keyword search across all indexed projects: kdb logs, Claude Code sessions, git commits, docs. Returns ranked snippets, each with an entryId (pass to atlas_entry for the full text) and a hostPath. Docs under archive-style paths are downranked and labeled docStatus=archived (aging = old but active); treat those hits as historical context, not current truth.',
    schema: {
      query: z.string().describe('Natural-language or keyword query'),
      project: z.string().optional().describe('Project slug filter, e.g. "deepcast"'),
      source: z.enum(SOURCE_TYPES).optional().describe('Restrict to one source type'),
      component: z.string().optional().describe('Component name filter'),
      kind: z
        .enum(['prompt', 'plan', 'insight', 'summary', 'action', 'response'])
        .optional()
        .describe(
          'Narrow to how a Claude session message was classified. "insight" and "summary" are often more useful than a keyword search.',
        ),
      machine: z
        .string()
        .optional()
        .describe(
          'Machine name filter (see atlas_status for known names). Semantics: first ingested from — shared git-synced content belongs to whichever machine synced first; for \'exists on machine X\' read a project\'s locations.',
        ),
      doc_status: z
        .enum(['active', 'archived'])
        .optional()
        .describe('active = exclude archived docs entirely; archived = only them'),
      since: z
        .string()
        .optional()
        .describe(
          'Only entries timestamped at or after this ISO date/datetime, e.g. "2026-07-18". Ranking is semantic and has no notion of time, so a question about a specific day will otherwise return whatever is most similar regardless of when it happened.',
        ),
      until: z
        .string()
        .optional()
        .describe(
          'Only entries timestamped at or before this ISO date/datetime. Pair with `since` to scope to a window. Prefer a few days either side of the date you care about: work is usually recorded after it happens, so an incident on the 21st is often written up on the 22nd or later.',
        ),
      limit: z.number().int().min(1).max(100).optional(),
    },
    request: (a) => ({
      path: `/api/search${qs({ q: a.query, project: a.project, source: a.source, component: a.component, kind: a.kind, machine: a.machine, docStatus: a.doc_status, since: a.since, until: a.until, limit: a.limit })}`,
    }),
  },
  {
    name: 'atlas_ask',
    description:
      'Ask a question about what happened across projects ("what were the bug fixes in the video import microservice?", "why was this built this way?", "what did the last session conclude?"). Retrieves relevant history and synthesizes a cited answer with a mid-size LLM (beta: answers can be non-exhaustive or wrong — verify important claims via the cited sources, e.g. atlas_entry on a source\'s entryId). START HERE for any "why/what happened/when did" question about past work — before reading code to infer it. Code shows the current state; only the recorded history explains the reasoning behind it, and a guess reconstructed from a snapshot reads exactly like a real answer. Prefer leaving `project` unset: a feature may be indexed under a different slug than you expect (e.g. G2P lives under "google-gemini-pool", not "deepcast"), and a wrong scope is the main reason a real answer looks missing. When `project` is set but nothing matches there, the search widens to all projects and the response carries a `scopeFallback` marker naming the scope that was empty — if you see it, the results are NOT from the project you asked for, so say so rather than presenting them as scoped.',
    schema: {
      question: z.string(),
      project: z
        .string()
        .optional()
        .describe('Optional project slug. Omit unless you are sure of the slug; a wrong scope hides answers that live in a sibling project.'),
      machine: z
        .string()
        .optional()
        .describe(
          'Machine name filter (see atlas_status for known names). Semantics: first ingested from — shared git-synced content belongs to whichever machine synced first; for \'exists on machine X\' read a project\'s locations.',
        ),
      since: z
        .string()
        .optional()
        .describe(
          'Restrict retrieval to entries timestamped at or after this ISO date. Use for a question about a particular period — ranking is semantic and time-blind, so without this the context blocks may all come from a different era than the one you asked about.',
        ),
      until: z
        .string()
        .optional()
        .describe(
          'Restrict retrieval to entries timestamped at or before this ISO date. Leave both unset unless the question is genuinely period-specific: the answer already reports measured coverage and per-window entry counts, so scoping is rarely needed to establish what exists.',
        ),
      k: z.number().int().min(1).max(30).optional().describe('Context blocks to retrieve (default 12)'),
    },
    request: (a) => ({ path: '/api/ask', init: jsonPost(a) }),
  },
  {
    name: 'atlas_projects',
    description:
      'List all indexed projects with entry counts. Use it to find the right slug before scoping any other tool. A row carrying `aliasOf` is a project\'s earlier location (its checkout moved); its entries are unique history, not duplicates, and are already included when you scope to the canonical slug it names.',
    schema: {},
    request: () => ({ path: '/api/projects' }),
  },
  {
    name: 'atlas_timeline',
    description: 'Chronological activity feed for a project: changelog entries, sessions, commits, merged and sorted (newest first).',
    schema: {
      project: z.string(),
      before: z.string().optional().describe('ISO timestamp cursor for pagination'),
      sources: z.string().optional().describe('Comma-separated source types to include'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    request: (a) => ({
      path: `/api/projects/${encodeURIComponent(a.project)}/timeline${qs({ before: a.before, sources: a.sources, limit: a.limit })}`,
    }),
  },
  {
    name: 'atlas_components',
    description:
      'List a project’s components (from kdb component logs) with activity counts. An unknown project slug returns a 404 rather than an empty list — check atlas_projects for valid slugs.',
    schema: { project: z.string() },
    request: (a) => ({ path: `/api/projects/${encodeURIComponent(a.project)}/components` }),
  },
  {
    name: 'atlas_component_history',
    description:
      'Recorded history of one component (newest first): objectives, decisions, outcomes, bug fixes. Long bodies are cut at max_body chars and flagged bodyTruncated: true — fetch a flagged entry in full with atlas_entry(id). Unknown project slugs return a 404 (check atlas_projects).',
    schema: {
      project: z.string(),
      component: z.string(),
      limit: z.number().int().min(1).max(100).optional().describe('Max entries, newest first (default 20)'),
      max_body: z.number().int().min(200).optional().describe('Chars kept per entry body (default 2000)'),
    },
    request: (a) => ({
      path: `/api/projects/${encodeURIComponent(a.project)}/components/${encodeURIComponent(a.component)}${qs({ limit: a.limit ?? 20, max_body: a.max_body ?? 2000 })}`,
    }),
  },
  {
    name: 'atlas_entry',
    description:
      'Read one indexed entry in full. Search returns short snippets; this returns the entire recorded body plus the source file path (hostPath) and an editor link. Use it after atlas_search or atlas_ask to read a result properly.',
    schema: { entry_id: z.number().int().describe('entryId from a search hit or ask source') },
    request: (a) => ({ path: `/api/entries/${encodeURIComponent(String(a.entry_id))}` }),
  },
  {
    name: 'atlas_session',
    description:
      'Reconstruct one Claude Code session: prompts, substantial responses, files touched. Paginated for context safety: returns up to `limit` entries from `offset` plus totalEntries (page again with offset=limit if totalEntries is larger). Bodies are cut at max_body chars and flagged bodyTruncated: true; fetch a flagged entry in full with atlas_entry(id).',
    schema: {
      session_id: z.string(),
      limit: z.number().int().min(1).max(1000).optional().describe('Max entries per page (default 50)'),
      offset: z.number().int().min(0).optional().describe('Entries to skip, for paging (default 0)'),
      max_body: z.number().int().min(200).optional().describe('Chars kept per entry body (default 1500)'),
    },
    request: (a) => ({
      path: `/api/sessions/${encodeURIComponent(a.session_id)}${qs({ limit: a.limit ?? 50, offset: a.offset, max_body: a.max_body ?? 1500 })}`,
    }),
  },
  {
    name: 'atlas_session_search',
    description:
      'Find a Claude Code SESSION by what you remember about it — a phrase from the conversation, a file it touched, a project name, or a session id (8+ hex characters is an exact hit). Ranks whole conversations rather than individual messages, and every result carries a `why` array naming what matched, so you can pick the right one without a further call. Prefer this over atlas_search when the question is "which session was that" rather than "what was said about X". Results are weighted by substance: the corpus median session is 3 messages long, so a bare keyword match would otherwise bury the session that did the work.',
    schema: {
      query: z.string().describe('What you remember: words, a file path, a project, or a session id'),
      project: z.string().optional().describe('Comma-separated project slugs; omit to search every project'),
      machine: z.string().optional().describe('Machine name filter (first ingested from)'),
      since: z.string().optional().describe('ISO date floor. An explicit date inside `query` is also honoured and reported back as `interpreted`.'),
      until: z.string().optional().describe('ISO date ceiling'),
      limit: z.number().int().min(1).max(50).optional().describe('Sessions to return (default 15)'),
      threads: z
        .boolean()
        .optional()
        .describe(
          'Fold contiguous runs of the same work into one row (default true). Claude Code splits long work across resumed sessions; without this you get five near-identical results for one afternoon.',
        ),
    },
    request: (a) => ({
      path: `/api/sessions/search${qs({ q: a.query, projects: a.project, machine: a.machine, since: a.since, until: a.until, limit: a.limit ?? 15, thread: a.threads === false ? 'false' : undefined })}`,
    }),
  },
  {
    name: 'atlas_session_insights',
    description:
      'A structured report on ONE session: what was asked, what was done (files edited, commands run, agents used), the insights and plans it recorded, what it decided, what broke, and — most usefully — what it left OPEN. Cheaper and far more readable than paging the whole transcript with atlas_session. `facts` is derived from the index and is always trustworthy; `narrative` is written by a mid-size LLM from that evidence and can be wrong — the `llm.status` field says which you got. Set llm:false for the deterministic layer alone (no model call, no cost). Reports are cached, so asking twice is free.',
    schema: {
      session_id: z.string(),
      sections: z
        .string()
        .optional()
        .describe(
          'Comma-separated subset of: overview, goals, did, highlights, decisions, problems, followups, backlog, trail. Default: all. Narrowing saves tokens on both sides.',
        ),
      llm: z
        .boolean()
        .optional()
        .describe('Include the LLM narrative layer (default true). false = recorded facts only, no model call.'),
      refresh: z.boolean().optional().describe('Regenerate instead of serving the cached report'),
    },
    request: (a) => ({
      path: `/api/sessions/${encodeURIComponent(a.session_id)}/insights${qs({ sections: a.sections, llm: a.llm === false ? 'false' : undefined, refresh: a.refresh ? '1' : undefined })}`,
    }),
  },
  {
    name: 'atlas_session_related',
    description:
      'Sessions BEFORE and AFTER this one that worked on the same thing — the history of a piece of work rather than of a conversation. Use it before changing something a past session touched: it surfaces the earlier attempt and whatever followed. Scored from three independent signals (shared files, subject similarity, timing) and every result reports which ones fired, in `basis` and per-result `why`. READ `basis`: if it is `["temporal"]` the results are merely things that happened nearby, NOT related work, and the response says so. `contextEvents` additionally lists commits and kdb log entries that touched the same files — work on a thing is often recorded there rather than in another session.',
    schema: {
      session_id: z.string(),
      direction: z.enum(['before', 'after', 'both']).optional().describe('Default both'),
      cross_project: z
        .boolean()
        .optional()
        .describe('Allow neighbours from other projects (default true) — a fix often spans repos'),
      context: z.boolean().optional().describe('Include commits/kdb entries touching the same files (default true)'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    request: (a) => ({
      path: `/api/sessions/${encodeURIComponent(a.session_id)}/related${qs({ direction: a.direction === 'both' ? undefined : a.direction, crossProject: a.cross_project === false ? 'false' : undefined, context: a.context === false ? 'false' : undefined, limit: a.limit })}`,
    }),
  },
  {
    name: 'atlas_backlog',
    description:
      "A project's backlog with derived statuses (open / resolved / dropped), computed from the append-only kdb/backlog.log: structured RESOLVED/DROPPED/REOPENED [L<n>#<hash>] markers link exactly; legacy DONE:/RESOLVED: lines link by fuzzy match (provenance: heuristic — weaker); recorded review verdicts overlay (provenance: reviewed). Items carry lints (unstructured, stale-review, not-written-back, broken-link…) and an `unlinked` bucket lists resolution markers with no confident target. Use this before re-investigating an item that may already be settled.",
    schema: { project: z.string() },
    request: (a) => ({ path: `/api/projects/${encodeURIComponent(a.project)}/backlog` }),
  },
  {
    name: 'atlas_backlog_evidence',
    description:
      'Evidence bundle for ONE backlog item (by its line number from atlas_backlog): scoped hybrid search over the project\'s changelogs, component/session logs, commits and docs. YOU judge whether the item is resolved — you can read the actual code, which Atlas cannot. After judging, record your conclusion with atlas_backlog_verdict. Set judge:true to also get Atlas\'s own LLM verdict as a second opinion (slower, one LLM call).',
    schema: {
      project: z.string(),
      line: z.number().int().min(1).describe('The item line number from atlas_backlog'),
      k: z.number().int().min(1).max(20).optional().describe('Evidence hits (default 8)'),
      judge: z.boolean().optional().describe('Also ask the Atlas LLM to judge (default false)'),
    },
    request: (a) => ({
      path: `/api/projects/${encodeURIComponent(a.project)}/backlog/review`,
      init: jsonPost({ line: a.line, k: a.k, judge: a.judge === true }),
    }),
  },
  {
    name: 'atlas_backlog_verdict',
    description:
      "Record your judgment on a backlog item after weighing the evidence (and, ideally, the code). Statuses: confirmed-resolved, confirmed-open, likely-resolved, inconclusive. The response's proposedLine is the exact marker line that makes the verdict durable — append it to the project's kdb/backlog.log via the project's own blessed append helper (bin/kdb_append or equivalent; NEVER direct file writes). Atlas never writes project files itself. Set propose to force a specific marker kind (e.g. 'dropped' for an obsolete item).",
    schema: {
      project: z.string(),
      line: z.number().int().min(1).describe('The item line number from atlas_backlog'),
      status: z.enum(['confirmed-open', 'likely-resolved', 'confirmed-resolved', 'inconclusive']),
      confidence: z.number().min(0).max(1).optional().describe('Your confidence (default 0.5)'),
      note: z.string().optional().describe('One-line reasoning; becomes the marker summary for propose'),
      evidence: z.string().optional().describe('Short pointer for the marker line, e.g. "commit abc123"'),
      citations: z.array(z.number().int()).optional().describe('entryIds you relied on'),
      propose: z.enum(['resolved', 'dropped', 'reopened']).optional().describe('Force this marker kind in proposedLine'),
    },
    request: (a) => ({
      path: `/api/projects/${encodeURIComponent(a.project)}/backlog/verdict`,
      init: jsonPost({
        line: a.line,
        status: a.status,
        confidence: a.confidence,
        note: a.note,
        evidence: a.evidence,
        citations: a.citations,
        propose: a.propose,
      }),
    }),
  },
  {
    name: 'atlas_reindex',
    description: 'Trigger an incremental (or full) reindex, optionally scoped to one project.',
    schema: {
      project: z.string().optional(),
      full: z.boolean().optional(),
    },
    request: (a) => ({ path: '/api/admin/reindex', init: jsonPost(a) }),
  },
  {
    name: 'atlas_status',
    description:
      'Index health: project/entry/chunk counts, per-source breakdown, last run time, recent errors count, ' +
      'and unsearchableEntries — entries that are indexed but have no vectors yet, so search cannot return them. ' +
      'A non-zero unsearchableEntries that is not falling means results may be incomplete for reasons unrelated to your query. ' +
      "Also carries a `machines` block (per-machine sync status, last success, bytes) when multi-machine is configured; empty in single-machine mode.",
    schema: {},
    request: () => ({ path: '/api/stats' }),
    merge: () => ({ key: 'machines', path: '/api/machines' }),
  },
];
