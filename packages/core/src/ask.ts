import type { AppConfig } from './config.js';
import { chatComplete, chatStream, type ChatMessage, type StreamMeta } from './llm.js';
import type { SearchService } from './search.js';
import type { Catalog } from './catalog.js';
import { extractDateWindow, paddedWindow } from './questionDates.js';
import {
  selectedProjects,
  type AskResult,
  type AskSource,
  type ProjectCoverage,
  type RetrievalReport,
  type ScopeFallback,
  type SearchFilters,
  type SearchHit,
  type WindowCoverage,
} from './types.js';

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
2. If the blocks do not answer the question, say so plainly and name exactly what is missing — but scope that statement to THE BLOCKS: "the retrieved sources don't say X". A short honest answer beats a padded guess.
2b. NEVER state or imply what the index as a whole does or does not contain — no claim about coverage, date ranges, or "history ending" — except by repeating a figure from the INDEX COVERAGE block. You see only a handful of retrieved blocks out of hundreds of thousands of entries, so the newest date among them tells you NOTHING about the newest date indexed. "Retrieval didn't surface it" and "it isn't indexed" are different claims; you can only ever support the first.
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
 * Gentle recency multiplier, by age in days.
 *
 * Ranking had no time term at all, so "what broke last week" competed against
 * two years of history on similarity alone. The range is deliberately narrow —
 * a ~12% spread end to end — because `20260710-docs-staleness-query-time.md`
 * decided that old-but-current docs must keep ranking well ("an old runbook that
 * simply never needed edits must not be buried"), and a strong recency boost
 * would silently reverse that. This breaks near-ties toward fresh material and
 * nothing more; a clearly better old match still wins.
 */
const RECENCY_HALF_LIFE_DAYS = 180;
const RECENCY_MAX_BOOST = 0.12;

function recencyFactor(occurredAt: string | undefined, nowMs: number): number {
  // Undated entries sit at the floor of the curve — factor 1.0, the limit a very
  // old entry approaches — so they rank as maximally old rather than being
  // docked for the missing timestamp. Absence of a date says nothing about age,
  // and several source types routinely lack one.
  if (!occurredAt) return 1;
  const ageMs = nowMs - Date.parse(occurredAt);
  if (!Number.isFinite(ageMs)) return 1;
  const days = Math.max(0, ageMs / 864e5);
  return 1 + RECENCY_MAX_BOOST * Math.exp(-days / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Collapse entries that are the same content recorded more than once.
 *
 * Distinct entry ids, identical title and timestamp: in the 2026-07-15 incident
 * three of fourteen context blocks were the same session summary, eating a fifth
 * of the window to say one thing. Keyed on title+timestamp rather than body
 * similarity — cheap, and it targets the actual duplication mechanism (the same
 * event distilled into several rows) without risking the collapse of two
 * genuinely different entries that merely discuss the same subject.
 */
function dedupeKey(h: SearchHit): string {
  return `${h.projectSlug}|${h.sourceType}|${h.title}|${h.occurredAt ?? ''}`;
}

/**
 * Rerank an over-fetched pool into the final k: source weight × recency, then
 * near-duplicate collapse, then the session cap. Weighting alone is not enough —
 * near-duplicate sessions can still crowd the window on raw score — so both the
 * dedupe and the cap are enforced structurally.
 */
export function rerankForContext(pool: SearchHit[], k: number): SearchHit[] {
  const nowMs = Date.now();
  const seen = new Set<string>();
  const weighted = pool
    .map((h) => ({
      h,
      s: h.score * (SOURCE_WEIGHT[h.sourceType] ?? 1) * recencyFactor(h.occurredAt, nowMs),
    }))
    .sort((a, b) => b.s - a.s)
    // After sorting, so the survivor of a duplicate group is its best-scoring
    // member rather than whichever happened to arrive first.
    .filter(({ h }) => {
      const key = dedupeKey(h);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

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

/**
 * Age past which a non-doc block is labelled in the prompt. Below this, the
 * header date is enough; above it, the model needs telling that "recent" and
 * "in the context" are not the same thing.
 */
const OLD_BLOCK_MONTHS = 6;

const NO_MATCH =
  'No indexed content matched this question. Try a broader query or trigger a reindex.';

/** The measured facts injected ahead of the retrieved blocks. */
export interface CoverageContext {
  coverage: ProjectCoverage[];
  window?: WindowCoverage;
}

const day = (iso?: string) => iso?.slice(0, 10) ?? '?';

/**
 * Render what the index actually holds, as a labelled, uncitable preamble.
 *
 * Deliberately *not* a numbered `[n]` block: those are evidence about the
 * subject, and a model that can cite this would start attributing claims about
 * the world to a row count. It answers exactly one question — "what does Atlas
 * have?" — which the model previously answered by guessing from its sample.
 */
export function buildCoverageBlock(ctx: CoverageContext): string {
  const lines = ctx.coverage.map(
    (c) =>
      `- ${c.projectSlug}: ${c.entries.toLocaleString('en-US')} entries indexed, ` +
      `spanning ${day(c.oldest)} to ${day(c.newest)}`,
  );

  let windowLine = '';
  if (ctx.window) {
    const w = ctx.window;
    // Both counts, always. "0 on the day" alone reads as "nothing happened",
    // when the write-up of a 21st incident is usually dated the 22nd or later.
    windowLine =
      `\nEntries timestamped in the range you asked about (${day(w.since)} to ${day(w.until)}): ${w.exact}.\n` +
      `Entries timestamped in the surrounding period (${day(w.paddedSince)} to ${day(w.paddedUntil)}): ${w.padded}.\n` +
      'A count of 0 means nothing carries a timestamp in that range — it does NOT mean the ' +
      'event did not happen, because activity is usually recorded after the fact.';
  }

  return (
    'INDEX COVERAGE (measured just now, not retrieved — do NOT cite this as a source):\n' +
    `${lines.join('\n')}${windowLine}\n`
  );
}

export function buildAskPrompt(
  question: string,
  hits: SearchHit[],
  bodies: Map<number, string>,
  ctx?: CoverageContext,
): string {
  const coverageBlock = ctx?.coverage.length ? `${buildCoverageBlock(ctx)}\n` : '';
  // A follow-up may retrieve nothing; say so plainly rather than handing the
  // model an empty "Context blocks:" header it might try to fill in. Coverage
  // still goes in: "nothing matched" plus a measured span is a real answer.
  if (!hits.length) {
    return `${coverageBlock}No new context was retrieved for this question; rely on the conversation above.\n\nQuestion: ${question}`;
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
      // Docs carry a status word (ARCHIVED/AGING); everything else gets a bare
      // age once it is genuinely old. The date is already in the header, but a
      // mid-size model reasons about "14 mo old" far more reliably than it
      // subtracts one date from another — and getting that wrong is how a 2025
      // transcript ends up quoted as current.
      const stale = h.docStatus
        ? ` [${h.docStatus.toUpperCase()}${age}]`
        : h.ageMonths != null && h.ageMonths >= OLD_BLOCK_MONTHS
          ? ` [${h.ageMonths} mo old]`
          : '';
      return `[${i + 1}] ${h.projectSlug} / ${h.sourceType}${h.component ? ` / ${h.component}` : ''}${date}${stale}\n${h.title}\n${body}`;
    })
    .join('\n\n---\n\n');
  return `${coverageBlock}Context blocks:\n\n${blocks}\n\nQuestion: ${question}`;
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
  | {
      type: 'sources';
      sources: AskSource[];
      scopeFallback?: ScopeFallback;
      retrieval?: RetrievalReport;
    }
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
  retrieval?: RetrievalReport;
}

/**
 * Days either side of an asked-about date to also count.
 *
 * Three covers "it happened Friday, someone wrote it up Monday", which is the
 * common shape, without widening so far that the neighbourhood count stops
 * meaning anything.
 */
const WINDOW_PAD_DAYS = 3;

export class AskService {
  constructor(
    private searchService: SearchService,
    private catalog: Catalog,
    private llmConfig: AppConfig['llm'],
    /**
     * Deployment identity for G2P stats (`X-G2P-Client-Id`). Optional so the
     * chat helpers fall back to the shared default; pass `cfg.g2pClientId` to
     * honour an operator override.
     */
    private g2pClientId?: string,
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
  ): Promise<{ hits: SearchHit[]; scopeFallback?: ScopeFallback; mode: string; degraded: boolean }> {
    // Over-fetch so rerankForContext has authoritative hits to promote into the
    // window; the raw top-k is often all sessions.
    const pool = Math.min(Math.max(k * 3, 24), 60);
    // `mode`/`degraded` are carried out of here rather than dropped: search
    // silently falls back (hybrid → sparse-only when the embedder is down → FTS
    // when Qdrant is down), and an answer built on degraded retrieval that
    // reports itself healthy is exactly the kind of unearned confidence this
    // service must not project.
    const { hits, mode, degraded } = await this.searchService.search(question, filters, pool);
    // Any hit at all means the scope worked. With several projects selected, the
    // ones that returned nothing simply had nothing to say — that is a *partial
    // match*, not an empty scope, and widening it would be wrong. Only a total
    // miss across every selected project is a scope problem.
    if (hits.length) return { hits: rerankForContext(hits, k), mode, degraded };

    const requested = selectedProjects(filters);
    if (!requested.length) return { hits, mode, degraded };

    const {
      hits: wide,
      mode: wideMode,
      degraded: wideDegraded,
    } = await this.searchService.search(
      question,
      // BOTH must be cleared. Dropping only `project` would leave `projects`
      // in place and the "widened" search would still be scoped — a silent no-op.
      { ...filters, project: undefined, projects: undefined },
      pool,
    );
    // Only report a fallback if widening actually surfaced something; an
    // all-projects miss is a genuine dead end, not a scope problem.
    if (!wide.length) return { hits, mode, degraded };
    return {
      hits: rerankForContext(wide, k),
      scopeFallback: { requested, usedAllProjects: true },
      mode: wideMode,
      degraded: wideDegraded,
    };
  }

  /**
   * Measure what the index holds for the scope actually searched.
   *
   * Per project, never index-wide: an unscoped ask is the recommended default,
   * and "the index is current to 2026-07-25" says nothing about whether the
   * project in question is covered. Best-effort — a failed count must not cost
   * the user their answer, it only costs the preamble.
   */
  private async measure(
    question: string,
    filters: SearchFilters,
    hits: SearchHit[],
    scopeFallback?: ScopeFallback,
  ): Promise<CoverageContext | undefined> {
    const requested = selectedProjects(filters);
    // After a widening the requested scope is not what was searched, so describe
    // where the answer actually came from.
    const projects =
      !scopeFallback && requested.length
        ? requested
        : [...new Set(hits.map((h) => h.projectSlug))];
    if (!projects.length) return undefined;

    try {
      // Same widening search applies, so coverage describes what was actually
      // searched rather than a narrower scope the caller merely asked for.
      const scope = await this.catalog.expandProjectScope(projects);
      const coverage = await this.catalog.coverage(scope);
      if (!coverage.length) return undefined;

      const asked = extractDateWindow(question);
      if (!asked) return { coverage };

      const around = paddedWindow(asked, WINDOW_PAD_DAYS);
      const [exact, padded] = await Promise.all([
        this.catalog.countInWindow(scope, asked.since, asked.until),
        this.catalog.countInWindow(scope, around.since, around.until),
      ]);
      return {
        coverage,
        window: {
          since: asked.since,
          until: asked.until,
          exact,
          paddedSince: around.since,
          paddedUntil: around.until,
          padded,
        },
      };
    } catch (e) {
      // Best-effort, but never silent. Swallowing this hid a missing import
      // during development: coverage simply vanished from every answer while
      // everything still looked healthy — the same shape of failure this whole
      // service is being hardened against.
      console.warn(`[ask] coverage measurement failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Shared retrieval: both ask() and askStream() build their prompt here. */
  private async prepare(
    question: string,
    filters: SearchFilters,
    k: number,
    history: AskTurn[] = [],
  ): Promise<Prepared> {
    const { hits, scopeFallback, mode, degraded } = await this.retrieve(question, filters, k);
    const measured = await this.measure(question, filters, hits, scopeFallback);
    const retrieval: RetrievalReport = {
      mode,
      degraded,
      coverage: measured?.coverage ?? [],
      ...(measured?.window ? { window: measured.window } : {}),
    };
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
    if (!hits.length && !history.length) return { sources: [], messages: null, retrieval };

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
      retrieval,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recent.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
        { role: 'user', content: buildAskPrompt(question, hits, bodies, measured) + scopeNote },
      ],
    };
  }

  async ask(
    question: string,
    filters: SearchFilters = {},
    k = 12,
    history: AskTurn[] = [],
  ): Promise<AskResult> {
    const { sources, messages, scopeFallback, retrieval } = await this.prepare(
      question,
      filters,
      k,
      history,
    );
    if (!messages) {
      return {
        answer: NO_MATCH,
        sources: [],
        model: this.llmConfig.model,
        degraded: false,
        ...(retrieval ? { retrieval } : {}),
      };
    }
    try {
      const answer = await chatComplete(this.llmConfig, messages, {
        clientId: this.g2pClientId,
      });
      return { answer, sources, model: this.llmConfig.model, degraded: false, scopeFallback, retrieval };
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
        retrieval,
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
      ...(prepared.retrieval ? { retrieval: prepared.retrieval } : {}),
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
        clientId: this.g2pClientId,
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
