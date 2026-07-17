import type { AppConfig } from './config.js';
import { chatComplete, chatStream, type ChatMessage, type StreamMeta } from './llm.js';
import type { SearchService } from './search.js';
import type { Catalog } from './catalog.js';
import { selectedProjects, type AskResult, type AskSource, type ScopeFallback, type SearchFilters, type SearchHit } from './types.js';

/**
 * Ask mode: retrieve → synthesize with citations. The LLM sees numbered
 * context blocks and must cite [n]; sources map back to entries.
 */

/**
 * Written for the mid-size models that actually serve Ask (gemini flash, glm
 * flash tier), which follow short numbered rules far more reliably than one
 * dense paragraph. Grounding and citation discipline come first because those
 * are the failure modes that matter: a fabricated file name or date in a
 * confident answer is worse than "the context doesn't say".
 */
const SYSTEM_PROMPT = `You are Atlas, an assistant that answers questions about the recorded history of the user's software projects. Your ONLY knowledge is the numbered context blocks in the user message (kdb logs, Claude Code session transcripts, git commits, docs) plus, in a follow-up, the earlier turns of this conversation.

Rules, in priority order:
1. Ground every claim in the context blocks and cite the supporting block inline as [n] immediately after the claim. Never invent facts, file names, dates, version numbers or events that are not in a block, and never cite a block for something it does not say.
2. If the blocks do not answer the question, say so plainly and name exactly what is missing. A short honest "the indexed history doesn't cover X" beats a padded guess.
3. Lead with the direct answer. If the question is "what is X", the first sentence must define X and what it does — background, history and caveats come after.
4. Be concrete: name components, dates, files and root causes rather than paraphrasing around them.
5. Prefer blocks that describe the subject (docs, kdb component logs, changelogs) over session transcripts that merely mention it in passing.
6. Blocks labeled [ARCHIVED — …] or [AGING — …] are historical. Prefer active, recent sources; say explicitly when your answer relies on labeled material; when blocks conflict, trust the newer one.
7. Answer in the language of the question.
8. On a follow-up question, the context blocks are freshly retrieved for that newest question — its [n] citations refer only to the blocks below, not to blocks from earlier turns.`;

/** One prior exchange, replayed so a follow-up keeps its context. */
export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Older turns are dropped rather than blowing the model's context window. */
const MAX_HISTORY_TURNS = 12;

/**
 * Context-quality reranking for Ask.
 *
 * Raw relevance ranks by lexical/semantic match, which a tool that indexes its
 * own operators' conversations gets badly wrong: a debugging transcript about
 * "the drain feature" matches a question about the drain feature far more
 * strongly than the doc that *explains* draining (the doc says "stops routing
 * new traffic", never echoing the question's words). So the answer ends up
 * synthesized from chatter, not documentation.
 *
 * Two levers fix this without a reindex:
 *  - a per-type score multiplier that lifts authoritative sources (docs, kdb
 *    component/changelog logs) above raw session/commit noise, and
 *  - a hard cap on how many claude_session blocks may fill the context window,
 *    so even when sessions dominate the pool, explanatory sources still land.
 */
const SOURCE_WEIGHT: Partial<Record<string, number>> = {
  doc: 1.35,
  kdb_component: 1.3,
  kdb_changelog: 1.15,
  kdb_report: 1.15,
  kdb_backlog: 1.05,
  git_commit: 1.0,
  kdb_session: 0.95,
  claude_session: 0.8,
};

/**
 * At most this fraction of the k context blocks may be claude_session. A
 * question whose only matches are sessions still fills up (the cap only bites
 * when better-typed hits exist to take the freed slots).
 */
const MAX_SESSION_FRACTION = 0.5;

/**
 * Rerank an over-fetched pool into the final k, applying the source weights and
 * the session cap. Weighting alone is not enough — near-duplicate sessions can
 * still crowd the window on raw score — so the cap is enforced structurally.
 */
export function rerankForContext(pool: SearchHit[], k: number): SearchHit[] {
  const weighted = pool
    .map((h) => ({ h, s: h.score * (SOURCE_WEIGHT[h.sourceType] ?? 1) }))
    .sort((a, b) => b.s - a.s);

  const maxSessions = Math.max(1, Math.floor(k * MAX_SESSION_FRACTION));
  const picked: SearchHit[] = [];
  const overflow: SearchHit[] = [];
  let sessions = 0;
  for (const { h } of weighted) {
    if (picked.length >= k) break;
    if (h.sourceType === 'claude_session') {
      // Hold sessions past the cap in reserve rather than dropping them: if
      // nothing else fills k (a genuinely session-only answer), they return.
      if (sessions >= maxSessions) {
        overflow.push(h);
        continue;
      }
      sessions++;
    }
    picked.push(h);
  }
  // Backfill any remaining slots from the held-over sessions.
  for (const h of overflow) {
    if (picked.length >= k) break;
    picked.push(h);
  }
  return picked;
}

const NO_MATCH =
  'No indexed content matched this question. Try a broader query or trigger a reindex.';

export function buildAskPrompt(question: string, hits: SearchHit[], bodies: Map<number, string>): string {
  // A follow-up may retrieve nothing; say so plainly rather than handing the
  // model an empty "Context blocks:" header it might try to fill in.
  if (!hits.length) {
    return `No new context was retrieved for this question; rely on the conversation above.\n\nQuestion: ${question}`;
  }
  const blocks = hits
    .map((h, i) => {
      const raw = bodies.get(h.entryId) ?? h.snippet;
      // Mark the cut: a mid-size model treats a silently clipped block as
      // complete and may present the truncated half-sentence as the outcome.
      const body = raw.length > 1500 ? `${raw.slice(0, 1500)} …[truncated]` : raw;
      const date = h.occurredAt ? ` (${h.occurredAt.slice(0, 10)})` : '';
      // In-band staleness signal: retrieval already downranked archived docs,
      // but whatever still lands in context must arrive labeled.
      const age = h.ageMonths != null ? ` — ${h.ageMonths} mo old` : '';
      const stale = h.docStatus ? ` [${h.docStatus.toUpperCase()}${age}]` : '';
      return `[${i + 1}] ${h.projectSlug} / ${h.sourceType}${h.component ? ` / ${h.component}` : ''}${date}${stale}\n${h.title}\n${body}`;
    })
    .join('\n\n---\n\n');
  return `Context blocks:\n\n${blocks}\n\nQuestion: ${question}`;
}

/**
 * What it cost to produce an answer, measured rather than estimated.
 *
 * Optional throughout: when the LLM is unreachable the request never returns
 * headers or a usage frame, so a degraded answer carries no metrics at all.
 * Consumers must render nothing rather than render zeroes.
 */
export interface AskMetrics {
  /** The model that actually answered (gateways substitute by routing policy). */
  model: string;
  /** True when the gateway served a different model than the one configured. */
  substituted: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  ttftMs?: number;
  /** Wall-clock for the whole completion. */
  totalMs?: number;
  /** Completion tokens per second of generation (excludes the wait for token 1). */
  tokensPerSec?: number;
  /** > 1 means the gateway failed over internally before it succeeded. */
  attempts?: number;
  requestId?: string;
}

/** Events emitted by the streaming Ask pipeline, in order. */
export type AskEvent =
  | { type: 'sources'; sources: AskSource[]; scopeFallback?: ScopeFallback }
  | { type: 'delta'; text: string }
  | { type: 'done'; model: string; degraded: boolean; metrics?: AskMetrics }
  | { type: 'error'; message: string };

/**
 * Fold raw stream telemetry into what the UI shows.
 *
 * tok/s divides by generation time (total − ttft), not total time: including the
 * wait for the first token would report a slow *queue* as a slow *model*. The
 * denominator is guarded — a sub-millisecond reply would otherwise yield
 * Infinity, and "∞ tok/s" is worse than saying nothing.
 */
function toMetrics(meta: StreamMeta, requestedModel: string, totalMs: number): AskMetrics {
  const served = meta.servedModel ?? requestedModel;
  const genMs = meta.ttftMs !== undefined ? totalMs - meta.ttftMs : totalMs;
  const completion = meta.usage?.completionTokens;
  const tokensPerSec =
    completion && completion > 0 && genMs > 0
      ? Math.round((completion / (genMs / 1000)) * 10) / 10
      : undefined;

  return {
    model: served,
    // Compared on the bare name: the gateway answers `google/gemma-4-31b-it`
    // for a configured `gemma-4-31b-it`, and that is the same model, not a swap.
    substituted: bareModel(served) !== bareModel(requestedModel),
    promptTokens: meta.usage?.promptTokens,
    completionTokens: completion,
    totalTokens: meta.usage?.totalTokens,
    ttftMs: meta.ttftMs,
    totalMs,
    tokensPerSec,
    attempts: meta.attempts,
    requestId: meta.requestId,
  };
}

/** `google/gemma-4-31b-it` → `gemma-4-31b-it`. Vendor prefixes are noise here. */
function bareModel(m: string): string {
  return m.split('/').pop()!.toLowerCase();
}

/** `[a]` → `project "a"`; `[a,b,c]` → `projects "a", "b" and "c"`. */
export function namedProjects(slugs: string[]): string {
  const q = slugs.map((s) => `"${s}"`);
  if (q.length === 1) return `project ${q[0]}`;
  return `projects ${q.slice(0, -1).join(', ')} and ${q.at(-1)}`;
}

interface Prepared {
  sources: AskSource[];
  messages: ChatMessage[] | null;
  scopeFallback?: ScopeFallback;
}

export class AskService {
  constructor(
    private searchService: SearchService,
    private catalog: Catalog,
    private llmConfig: AppConfig['llm'],
  ) {}

  /**
   * Retrieve for the question, honoring the project scope but never letting it
   * hide an answer that lives elsewhere.
   *
   * A hard project filter is the right default — a scoped question usually
   * wants scoped results. But when it matches *nothing* in that project, the
   * honest empty result reads as "this feature does not exist" even when it was
   * built in a sibling project (the real bug: asking about G2P's NEXUS drain
   * while scoped to `deepcast`, where it was indexed under `google-gemini-pool`).
   * So on an empty scoped result we widen to all projects and flag it, rather
   * than returning a confident non-answer.
   */
  private async retrieve(
    question: string,
    filters: SearchFilters,
    k: number,
  ): Promise<{ hits: SearchHit[]; scopeFallback?: ScopeFallback }> {
    // Over-fetch so rerankForContext has authoritative hits to promote into the
    // window; the raw top-k is often all sessions.
    const pool = Math.min(Math.max(k * 3, 24), 60);
    const { hits } = await this.searchService.search(question, filters, pool);
    // Any hit at all means the scope worked. With several projects selected, the
    // ones that returned nothing simply had nothing to say — that is a *partial
    // match*, not an empty scope, and widening it would be wrong. Only a total
    // miss across every selected project is a scope problem.
    if (hits.length) return { hits: rerankForContext(hits, k) };

    const requested = selectedProjects(filters);
    if (!requested.length) return { hits };

    const { hits: wide } = await this.searchService.search(
      question,
      // BOTH must be cleared. Dropping only `project` would leave `projects`
      // in place and the "widened" search would still be scoped — a silent no-op.
      { ...filters, project: undefined, projects: undefined },
      pool,
    );
    // Only report a fallback if widening actually surfaced something; an
    // all-projects miss is a genuine dead end, not a scope problem.
    if (!wide.length) return { hits };
    return {
      hits: rerankForContext(wide, k),
      scopeFallback: { requested, usedAllProjects: true },
    };
  }

  /** Shared retrieval: both ask() and askStream() build their prompt here. */
  private async prepare(
    question: string,
    filters: SearchFilters,
    k: number,
    history: AskTurn[] = [],
  ): Promise<Prepared> {
    const { hits, scopeFallback } = await this.retrieve(question, filters, k);
    const sources: AskSource[] = hits.map((h, i) => ({
      n: i + 1,
      entryId: h.entryId,
      title: h.title,
      projectSlug: h.projectSlug,
      sourceType: h.sourceType,
      sourcePath: h.sourcePath,
      occurredAt: h.occurredAt,
    }));

    // A follow-up like "why?" carries no search signal and retrieves nothing —
    // but the conversation above it holds the answer. Only a *first* question
    // with no hits is a genuine dead end.
    if (!hits.length && !history.length) return { sources: [], messages: null };

    const rows = await this.catalog.getEntries(hits.map((h) => h.entryId));
    const bodies = new Map<number, string>(
      [...rows.entries()].map(([id, row]) => [id, String(row.body)]),
    );
    // When the scope was widened, tell the model so the answer opens by naming
    // the empty scope and where the answer actually came from — otherwise the
    // user never learns their scope was wrong.
    // A scope can hold several projects, so name them all: "nothing matched in
    // a,b" would read as one oddly-named project.
    const scopeNote = scopeFallback
      ? `\n\nNote: nothing matched in ${namedProjects(scopeFallback.requested)}, so this ` +
        'searched all projects instead. Say so briefly at the start of your answer ' +
        'and name which project(s) the answer comes from.'
      : '';
    // Prior turns come *before* the fresh context, so the model reads
    // "conversation so far" then "here is what I found for the newest
    // question" — the [n] citations always refer to the block below them.
    const recent = history.slice(-MAX_HISTORY_TURNS);
    return {
      sources,
      scopeFallback,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recent.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
        { role: 'user', content: buildAskPrompt(question, hits, bodies) + scopeNote },
      ],
    };
  }

  async ask(
    question: string,
    filters: SearchFilters = {},
    k = 12,
    history: AskTurn[] = [],
  ): Promise<AskResult> {
    const { sources, messages, scopeFallback } = await this.prepare(question, filters, k, history);
    if (!messages) {
      return { answer: NO_MATCH, sources: [], model: this.llmConfig.model, degraded: false };
    }
    try {
      const answer = await chatComplete(this.llmConfig, messages);
      return { answer, sources, model: this.llmConfig.model, degraded: false, scopeFallback };
    } catch (e) {
      // LLM down: still useful — return the retrieved sources with an explanation.
      return {
        answer:
          `LLM unavailable (${(e as Error).message.slice(0, 200)}). ` +
          'Here are the most relevant indexed sources for your question instead.',
        sources,
        model: this.llmConfig.model,
        degraded: true,
        scopeFallback,
      };
    }
  }

  /**
   * Streaming variant. Sources are emitted first so the UI can render
   * citations before any prose arrives, then answer deltas, then `done`.
   */
  async *askStream(
    question: string,
    filters: SearchFilters = {},
    k = 12,
    history: AskTurn[] = [],
  ): AsyncGenerator<AskEvent, void, unknown> {
    let prepared: Prepared;
    try {
      prepared = await this.prepare(question, filters, k, history);
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
      return;
    }

    yield {
      type: 'sources',
      sources: prepared.sources,
      ...(prepared.scopeFallback ? { scopeFallback: prepared.scopeFallback } : {}),
    };

    if (!prepared.messages) {
      yield { type: 'delta', text: NO_MATCH };
      yield { type: 'done', model: this.llmConfig.model, degraded: false };
      return;
    }

    // Telemetry accrues as the stream progresses (headers, then first token,
    // then usage), so even a stream that dies half-way still reports which
    // model was answering when it broke.
    let meta: StreamMeta = {};
    const startedAt = Date.now();

    try {
      for await (const delta of chatStream(this.llmConfig, prepared.messages, {
        onMeta: (m) => {
          meta = m;
        },
      })) {
        yield { type: 'delta', text: delta };
      }
      yield {
        type: 'done',
        model: this.llmConfig.model,
        degraded: false,
        metrics: toMetrics(meta, this.llmConfig.model, Date.now() - startedAt),
      };
    } catch (e) {
      yield {
        type: 'delta',
        text:
          `\n\n_LLM unavailable (${(e as Error).message.slice(0, 200)}). ` +
          'The sources above are the most relevant indexed results._',
      };
      // No metrics on a failed call: chatStream throws before yielding, so there
      // are no headers and no usage. Reporting zeroes would be a fabrication.
      yield { type: 'done', model: this.llmConfig.model, degraded: true };
    }
  }
}
