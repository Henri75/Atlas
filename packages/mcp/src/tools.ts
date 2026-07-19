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

CALL ATLAS FIRST when the task involves what happened BEFORE. These are observable
conditions in your own work, not judgment calls — if one is true, query Atlas before
reading code to infer the answer:
- You are about to state why a change was made, why a bug happened, or why something
  was built a certain way.
- You are about to explain or reconstruct what a past session did or concluded.
- You are investigating a report about past behavior ("X was rated poorly", "this
  regressed", "we tried this before").
- You are about to write "presumably", "likely because", "this was probably", or
  "I could not verify" about anything historical.

Code shows you the current state. It cannot tell you why someone made a decision, what
was tried and abandoned, or why a tool behaved a way someone reacted to. Inferring
history from a current snapshot produces confident, plausible, unverifiable answers —
exactly the failure Atlas exists to prevent. Reading the code first and calling Atlas
only to confirm is backwards: by then you have already anchored on a guess.

Not every task needs Atlas. But deciding to skip it must be a decision you make
visibly, not one you drift past — see the reporting duty below.

Atlas is BETA. Treat its output as leads, not ground truth: search ranking may miss things, and atlas_ask answers are synthesized by a mid-size LLM from retrieved snippets — they can be non-exhaustive or wrong, though every claim carries a [n] citation. Before relying on an answer for real work, read the cited source (atlas_entry with the source's entryId, or the hostPath file directly).

How to use it well:
- Finding facts/code history: atlas_search, then atlas_entry on the interesting hits (search returns snippets only).
- "What/why/when" questions needing synthesis: atlas_ask, then verify via its cited sources.
- Orienting in an unfamiliar project: atlas_projects → atlas_timeline → atlas_component_history.
- Prefer UNSCOPED search/ask first. A feature often lives under a different project slug than you expect; a wrong 'project' filter is the main reason a real answer looks missing.
- Slugs that look like flattened absolute paths (e.g. "users-nasta-documents-…") with an empty rootPath are ghost duplicates from moved checkouts; prefer the clean slug for the same project.
- Large results are paginated/truncated for context safety (bodyTruncated: true, totalEntries); fetch the full text of a specific entry with atlas_entry.

If Atlas becomes unreachable mid-task (connection error, server down): any conclusion
you reach afterwards about past events is UNVERIFIED. Say so explicitly in your summary
and name what you could not check — do not let an unavailable tool quietly downgrade a
verifiable claim into a confident guess. If it comes back, revisit what you deferred.

Beta feedback duty: your final report/summary to the user MUST include a short "Atlas usage" note. If you used it: which tools you called and for what, a 1-5 usefulness rating, and any issues hit (wrong or missing answers, errors, slowness). If you did NOT use it on a task that touched project history, say that instead and why in one line ("skipped — the answer was in the working diff", "unavailable — server down", "did not think of it"). A silent omission is the one outcome that teaches nobody anything: an agent that must name its skip notices the choice, and "did not think of it" is the single most useful signal for fixing these instructions. This feedback is how Atlas gets fixed.`;

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
      doc_status: z
        .enum(['active', 'archived'])
        .optional()
        .describe('active = exclude archived docs entirely; archived = only them'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    request: (a) => ({
      path: `/api/search${qs({ q: a.query, project: a.project, source: a.source, component: a.component, kind: a.kind, docStatus: a.doc_status, limit: a.limit })}`,
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
      k: z.number().int().min(1).max(30).optional().describe('Context blocks to retrieve (default 12)'),
    },
    request: (a) => ({ path: '/api/ask', init: jsonPost(a) }),
  },
  {
    name: 'atlas_projects',
    description:
      'List all indexed projects with entry counts. Use it to find the right slug before scoping any other tool. Slugs that look like flattened absolute paths ("users-nasta-documents-…") with an empty rootPath are ghost duplicates of moved checkouts — prefer the clean slug.',
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
    description: 'Index health: project/entry/chunk counts, per-source breakdown, last run time, recent errors count.',
    schema: {},
    request: () => ({ path: '/api/stats' }),
  },
];
