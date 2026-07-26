import { sparseVector, type SearchHit } from '@atlas/core';
import type { EvalConfig } from './config.js';
import type { Stack } from './services.js';
import type { EvalQuery } from './types.js';
import type { Variant } from './variants.js';

/**
 * Running retrieval for an eval query.
 *
 * Everything here goes through `AskService.retrieveForContext`, which is the
 * product's own path — pool size, scope widening, degradation flags and all.
 */

export interface Measured {
  /** Retrieval stage: the over-fetched pool, before any rerank knob applies. */
  pool: SearchHit[];
  /** Context stage: the k blocks Ask would synthesise from. */
  context: SearchHit[];
  mode: string;
  degraded: boolean;
  tookMs: number;
  scopeWidened: boolean;
}

export async function runVariant(
  stack: Stack,
  cfg: EvalConfig,
  query: EvalQuery,
  variant: Variant,
  nowMs: number,
): Promise<Measured> {
  const t0 = Date.now();
  const r = await stack.ask.retrieveForContext(
    query.text,
    query.filters,
    cfg.k,
    variant.options(query, nowMs),
  );
  return {
    pool: r.pool,
    context: r.hits,
    mode: r.mode,
    degraded: r.degraded,
    tookMs: Date.now() - t0,
    scopeWidened: r.scopeFallback !== undefined,
  };
}

export interface CandidateSources {
  hybrid: number[];
  fts: number[];
  dense: number[];
}

/**
 * The candidate set to be judged, pooled across retrieval *mechanisms*.
 *
 * Not across variants: every variant in this harness overrides `RerankOptions`,
 * which only affects context selection — the retrieval pool comes from
 * `SearchService.search()` and is byte-identical for all of them. Unioning
 * variant pools would therefore add nothing while looking thorough.
 *
 * What genuinely widens the pool is a different mechanism. Three are used:
 * hybrid RRF (what the product serves), Postgres FTS (pure lexical, the
 * degraded path, and blind in different places), and dense-only (pure semantic).
 * A judged pool drawn from one mechanism inherits its blind spots and would
 * quietly score every variant against the same incomplete ground truth.
 */
export async function candidatePool(
  stack: Stack,
  cfg: EvalConfig,
  query: EvalQuery,
): Promise<{ ids: number[]; sources: CandidateSources }> {
  const cutoff = cfg.poolCutoff;

  const hybrid = await stack.search.search(query.text, query.filters, cutoff);
  const fts = await stack.catalog
    .ftsSearch(query.text, query.filters, cutoff)
    .catch(() => [] as SearchHit[]);

  let dense: { entryId: number }[] = [];
  try {
    const vec = (await stack.embedder.embed([query.text]))[0]!;
    dense = await stack.vectors.queryDense({ dense: vec, filters: query.filters, limit: cutoff });
  } catch {
    // Dense-only is a pooling aid, not the measurement. Losing it narrows the
    // judged set slightly; failing the whole judging pass over it would be worse.
  }

  const sources: CandidateSources = {
    hybrid: hybrid.hits.map((h) => h.entryId),
    fts: fts.map((h) => h.entryId),
    dense: dense.map((d) => d.entryId),
  };
  const ids = [...new Set([...sources.hybrid, ...sources.fts, ...sources.dense])];
  return { ids, sources };
}

export interface SignalRow {
  queryId: string;
  pool: EvalQuery['pool'];
  class: EvalQuery['class'];
  /** Fused RRF score at rank 1 and rank 5 — expected to be uninformative. */
  rrf1: number | null;
  rrf5: number | null;
  /** Ratio of top-1 to the median of the pool: the score-gap heuristic. */
  rrfGap: number | null;
  /** Raw cosine of the best dense hit — comparable across queries. */
  cosine1: number | null;
  cosine5: number | null;
  /** Mean fraction of query terms present in each of the top 5 hits. */
  lexicalOverlap: number | null;
  hits: number;
  mode: string;
}

/**
 * Candidate relevance signals, recorded without interpreting them.
 *
 * This is calibration data for B4, not B4: no band, no threshold, and nothing
 * reaches `RetrievalReport`. The question it answers is empirical — does any of
 * these numbers separate Pool N (verified unanswerable) from Pools A and B? A
 * signal that does not cannot support a "nothing relevant" state, and proving
 * that about RRF is as valuable as finding one that works.
 */
export async function measureSignals(
  stack: Stack,
  cfg: EvalConfig,
  query: EvalQuery,
): Promise<SignalRow> {
  const hybrid = await stack.search.search(query.text, query.filters, cfg.poolCutoff);
  const scores = hybrid.hits.map((h) => h.score);
  const sorted = [...scores].sort((a, b) => b - a);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;

  let cosines: number[] = [];
  try {
    const vec = (await stack.embedder.embed([query.text]))[0]!;
    const dense = await stack.vectors.queryDense({
      dense: vec,
      filters: query.filters,
      limit: cfg.poolCutoff,
    });
    cosines = dense.map((d) => d.score);
  } catch {
    cosines = [];
  }

  // Lexical overlap over the top 5, using the sparse encoder's own tokeniser so
  // "overlap" is measured in the vocabulary the keyword branch actually sees.
  const queryTerms = new Set(sparseVector(query.text).indices);
  const top5 = hybrid.hits.slice(0, 5);
  const overlaps = top5.map((h) => {
    if (!queryTerms.size) return 0;
    const hitTerms = new Set(sparseVector(`${h.title} ${h.snippet}`).indices);
    let shared = 0;
    for (const t of queryTerms) if (hitTerms.has(t)) shared++;
    return shared / queryTerms.size;
  });

  return {
    queryId: query.id,
    pool: query.pool,
    class: query.class,
    rrf1: scores[0] ?? null,
    rrf5: scores[4] ?? null,
    rrfGap: scores[0] != null && median ? scores[0] / median : null,
    cosine1: cosines[0] ?? null,
    cosine5: cosines[4] ?? null,
    lexicalOverlap: overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : null,
    hits: hybrid.hits.length,
    mode: hybrid.mode,
  };
}
