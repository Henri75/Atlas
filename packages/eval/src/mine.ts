import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Catalog, type SearchFilters } from '@atlas/core';
import { queryId } from './pools.js';
import type { EvalQuery, QueryClass } from './types.js';

/**
 * Pool A: the questions agents actually asked Atlas.
 *
 * Two sources, because neither is complete. `usage_log` records every agent HTTP
 * call but historically dropped ask questions (they arrive in a POST body, and
 * only the URL was read — now fixed, so this source grows from here). Claude
 * transcripts hold the MCP tool calls themselves, including those lost asks, but
 * only for sessions still on disk.
 */

/**
 * A query text repeated this many times modulo its digits is a load test, not
 * traffic.
 *
 * The log is 60% `burst 1`…`burst 60` and 21 × `qdrant quantization concurrency
 * N` — throughput probes from earlier performance work. Excluding them by
 * literal name would be a hand-maintained blocklist that silently rots; the
 * *shape* (many near-identical texts differing only in a number) is what
 * actually identifies them, and it keeps working for the next probe.
 */
const LOAD_TEST_REPEATS = 5;

/** `burst 44` and `burst 17` share this template. */
const template = (text: string) => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export interface MinedQuery {
  text: string;
  filters: SearchFilters;
  source: 'usage_log' | 'transcript';
  at?: string;
  ref?: string;
}

export interface MineReport {
  fromUsageLog: number;
  fromTranscripts: number;
  /** Templates dropped as load tests, with their repeat counts. Never silent. */
  droppedLoadTests: { template: string; count: number }[];
  distinct: number;
}

/**
 * Parse a `usage_log.query` value.
 *
 * GET rows hold a URL query string; POST /api/ask rows hold the question itself
 * (there is no `q=` to find). Distinguishing on the path rather than by sniffing
 * the text keeps a question that happens to contain "q=" from being parsed as a
 * query string.
 */
export function parseUsageRow(row: {
  path: string;
  query: string;
  at?: Date | string;
  id?: number;
}): MinedQuery | null {
  const at = row.at instanceof Date ? row.at.toISOString() : row.at;
  const ref = row.id != null ? `usage_log#${row.id}` : undefined;

  if (row.path.startsWith('/api/ask')) {
    const text = row.query.trim();
    if (!text) return null;
    // Ask filters are not recorded, so an ask query is replayed unfiltered —
    // which is what the default MCP call does anyway.
    return { text, filters: {}, source: 'usage_log', at, ref };
  }

  const params = new URLSearchParams(row.query);
  const text = params.get('q')?.trim();
  if (!text) return null;
  const projects = params.get('project')?.split(',').filter(Boolean) ?? [];
  const sources = params.get('source')?.split(',').filter(Boolean) ?? [];
  const filters: SearchFilters = {
    ...(projects.length === 1 ? { project: projects[0] } : {}),
    ...(projects.length > 1 ? { projects } : {}),
    ...(sources.length === 1 ? { sourceType: sources[0] as never } : {}),
    ...(sources.length > 1 ? { sourceTypes: sources as never } : {}),
    ...(params.get('component') ? { component: params.get('component')! } : {}),
    ...(params.get('kind') ? { kind: params.get('kind') as never } : {}),
    ...(params.get('since') ? { since: params.get('since')! } : {}),
    ...(params.get('until') ? { until: params.get('until')! } : {}),
  };
  return { text, filters, source: 'usage_log', at, ref };
}

/** Pull every recorded agent query out of the catalog. */
export async function fromUsageLog(catalog: Catalog): Promise<MinedQuery[]> {
  const r = await catalog.pool.query(
    `SELECT id, at, path, query FROM usage_log
      WHERE query IS NOT NULL AND query <> ''
      ORDER BY at ASC`,
  );
  return r.rows.map(parseUsageRow).filter((q): q is MinedQuery => q !== null);
}

/**
 * Extract Atlas MCP calls from one transcript line.
 *
 * Transcripts are JSONL where an assistant message holds a content array; a tool
 * call is a `tool_use` block. Exported for its own test because the shape is
 * external and undocumented — the parser has to fail soft on anything unexpected
 * rather than abort a 12 GB scan.
 */
export function parseTranscriptLine(line: string, ref: string): MinedQuery[] {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  const content = msg?.message?.content ?? msg?.content;
  if (!Array.isArray(content)) return [];
  const out: MinedQuery[] = [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    const name = String(block.name ?? '');
    if (name !== 'mcp__atlas__atlas_ask' && name !== 'mcp__atlas__atlas_search') continue;
    const input = block.input ?? {};
    const text = String(input.question ?? input.query ?? '').trim();
    if (!text) continue;
    const projects = typeof input.project === 'string' ? [input.project] : [];
    out.push({
      text,
      filters: {
        ...(projects.length ? { project: projects[0] } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.source ? { sourceType: input.source } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.until ? { until: input.until } : {}),
      },
      source: 'transcript',
      at: typeof msg.timestamp === 'string' ? msg.timestamp : undefined,
      ref,
    });
  }
  return out;
}

/**
 * Scan transcripts for Atlas tool calls.
 *
 * Streamed line by line with a substring pre-filter, so only the handful of lines
 * that mention an Atlas tool are ever JSON-parsed. The corpus is ~12 GB; parsing
 * every line would take minutes to find a few dozen calls. Note that most files
 * match the marker because the tool *schemas* appear in system prompts — the
 * `tool_use` check in the parser is what separates a call from a definition.
 */
export async function fromTranscripts(dir: string): Promise<MinedQuery[]> {
  const out: MinedQuery[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(dir);
  } catch {
    // No transcripts on this host: mining still works from usage_log alone.
    return out;
  }
  for (const project of projectDirs) {
    const projectPath = join(dir, project);
    if (!(await stat(projectPath).catch(() => null))?.isDirectory()) continue;
    for (const file of await readdir(projectPath).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(projectPath, file);
      const rl = createInterface({
        input: createReadStream(path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.includes('mcp__atlas__atlas_')) continue;
        out.push(...parseTranscriptLine(line, `${project}/${file}`));
      }
    }
  }
  return out;
}

/**
 * Heuristic first-pass class, corrected by hand in the committed fixture.
 *
 * Deliberately not an LLM call: 21 queries are faster to read than to prompt
 * for, and a classifier that could change its mind between runs would silently
 * move queries between the per-class numbers a decision rests on. `mergeQueries`
 * never overwrites, so a hand correction is permanent.
 */
export function classify(text: string): QueryClass {
  const t = text.toLowerCase();
  if (/\b(20\d\d-\d\d-\d\d|yesterday|last (week|month)|on july|what happened on)\b/.test(t)) {
    return 'temporal';
  }
  if (/\b(root cause|crash|failed|failure|spike|incident|bug|broke|starv)/.test(t)) return 'incident';
  if (/\b(why|rationale|deliberate|instead of|decided)\b/.test(t)) return 'intent';
  if (/\b(how (to|do|should)|procedure|safely|steps)\b/.test(t)) return 'procedural';
  return 'definitional';
}

/**
 * Drop load-test templates and collapse duplicates, reporting what was removed.
 *
 * A harness that silently discarded part of its input would report a full
 * evaluation over a set it had quietly trimmed — so the counts come back with
 * the queries.
 */
export function consolidate(mined: MinedQuery[]): { queries: EvalQuery[]; report: MineReport } {
  const byTemplate = new Map<string, number>();
  for (const m of mined) byTemplate.set(template(m.text), (byTemplate.get(template(m.text)) ?? 0) + 1);

  const droppedLoadTests = [...byTemplate.entries()]
    .filter(([, count]) => count >= LOAD_TEST_REPEATS)
    .map(([tpl, count]) => ({ template: tpl, count }))
    .sort((a, b) => b.count - a.count);
  const dropped = new Set(droppedLoadTests.map((d) => d.template));

  const byId = new Map<string, EvalQuery>();
  let fromUsage = 0;
  let fromTranscript = 0;
  for (const m of mined) {
    if (dropped.has(template(m.text))) continue;
    if (m.source === 'usage_log') fromUsage++;
    else fromTranscript++;
    const id = queryId(m.text, m.filters);
    // First sighting wins, so provenance points at when a question was first
    // asked rather than the most recent replay of it.
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      pool: 'A',
      text: m.text,
      class: classify(m.text),
      filters: m.filters,
      provenance: {
        source: m.source,
        ...(m.at ? { at: m.at } : {}),
        ...(m.ref ? { ref: m.ref } : {}),
      },
    });
  }

  return {
    queries: [...byId.values()],
    report: {
      fromUsageLog: fromUsage,
      fromTranscripts: fromTranscript,
      droppedLoadTests,
      distinct: byId.size,
    },
  };
}
