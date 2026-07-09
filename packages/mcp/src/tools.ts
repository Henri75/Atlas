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

const SOURCE_TYPES = [
  'kdb_changelog', 'kdb_session', 'kdb_component', 'kdb_backlog',
  'kdb_report', 'claude_session', 'git_commit', 'doc',
] as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'kdb_search',
    description:
      'Hybrid semantic+keyword search across all indexed projects: kdb logs, Claude Code sessions, git commits, docs. Returns ranked snippets, each with an entryId (pass to kdb_entry for the full text) and a hostPath.',
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
      limit: z.number().int().min(1).max(100).optional(),
    },
    request: (a) => ({
      path: `/api/search${qs({ q: a.query, project: a.project, source: a.source, component: a.component, kind: a.kind, limit: a.limit })}`,
    }),
  },
  {
    name: 'kdb_ask',
    description:
      'Ask a question about what happened across projects ("what were the bug fixes in the video import microservice?"). Retrieves relevant history and synthesizes a cited answer with an LLM.',
    schema: {
      question: z.string(),
      project: z.string().optional(),
      k: z.number().int().min(1).max(30).optional().describe('Context blocks to retrieve (default 12)'),
    },
    request: (a) => ({ path: '/api/ask', init: jsonPost(a) }),
  },
  {
    name: 'kdb_projects',
    description: 'List all indexed projects with entry counts.',
    schema: {},
    request: () => ({ path: '/api/projects' }),
  },
  {
    name: 'kdb_timeline',
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
    name: 'kdb_components',
    description: 'List a project’s components (from kdb component logs) with activity counts.',
    schema: { project: z.string() },
    request: (a) => ({ path: `/api/projects/${encodeURIComponent(a.project)}/components` }),
  },
  {
    name: 'kdb_component_history',
    description: 'Full recorded history of one component: objectives, decisions, outcomes, bug fixes.',
    schema: { project: z.string(), component: z.string() },
    request: (a) => ({
      path: `/api/projects/${encodeURIComponent(a.project)}/components/${encodeURIComponent(a.component)}`,
    }),
  },
  {
    name: 'kdb_entry',
    description:
      'Read one indexed entry in full. Search returns short snippets; this returns the entire recorded body plus the source file path (hostPath) and an editor link. Use it after kdb_search or kdb_ask to read a result properly.',
    schema: { entry_id: z.number().int().describe('entryId from a search hit or ask source') },
    request: (a) => ({ path: `/api/entries/${encodeURIComponent(String(a.entry_id))}` }),
  },
  {
    name: 'kdb_session',
    description: 'Reconstruct one Claude Code session: prompts, substantial responses, files touched.',
    schema: { session_id: z.string() },
    request: (a) => ({ path: `/api/sessions/${encodeURIComponent(a.session_id)}` }),
  },
  {
    name: 'kdb_reindex',
    description: 'Trigger an incremental (or full) reindex, optionally scoped to one project.',
    schema: {
      project: z.string().optional(),
      full: z.boolean().optional(),
    },
    request: (a) => ({ path: '/api/admin/reindex', init: jsonPost(a) }),
  },
  {
    name: 'kdb_status',
    description: 'Index health: project/entry/chunk counts, per-source breakdown, last run time, recent errors count.',
    schema: {},
    request: () => ({ path: '/api/stats' }),
  },
];
