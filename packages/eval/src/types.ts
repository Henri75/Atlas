import type { SearchFilters } from '@atlas/core';
import type { AgreementReport, Grade } from './metrics.js';

/**
 * Fixture shapes.
 *
 * All three pools live in one file because they are one query set with three
 * provenances, and splitting them invites a run that silently evaluates two of
 * the three. They are never *averaged* together — see report.ts.
 */

/**
 * Question shapes that pull ranking in different directions.
 *
 * Derived by reading the 21 real queries rather than assumed: the parent spec
 * proposed a "what did session X conclude" class, and real traffic contains none
 * of those, while it is full of incident post-mortems.
 */
export type QueryClass = 'definitional' | 'intent' | 'temporal' | 'incident' | 'procedural';

export const QUERY_CLASSES: QueryClass[] = [
  'definitional',
  'intent',
  'temporal',
  'incident',
  'procedural',
];

/**
 * A — real agent traffic, graded by a judge.
 * B — generated from a known entry, so the gold answer needs no judge.
 * N — verified to have no answer in the corpus; the only pool that can calibrate
 *     a "found nothing relevant" signal.
 */
/**
 * A — mined from real traffic. B — generated from a known entry, gold needs no
 * judge. N — verified negatives. L — generated like B but built *around* a
 * literal quoted verbatim from the entry (a size, version, sha, column name).
 *
 * L exists because neither A nor B can produce that shape: A is thin, and B's
 * generator is explicitly told not to reuse identifiers or verbatim phrases,
 * since for B that is leakage. The consequence was measured on 2026-07-29 — the
 * tokeniser shredded every measurement in the corpus (`6.8MB` → `["8mb"]`),
 * costing a real question all five of its answers, and every harness number
 * stayed exactly the same.
 */
export type PoolId = 'A' | 'B' | 'N' | 'L';

export interface QueryProvenance {
  /** Where the text came from. `generated` covers pools B and N. */
  source: 'usage_log' | 'transcript' | 'generated';
  /** When the agent asked it, or when it was generated. */
  at?: string;
  /** Transcript path or usage_log id, so a query can be traced back. */
  ref?: string;
  /** Pool B: the entry the question was written from. */
  fromEntryId?: number;
  /** Pool B: source type of that entry, for stratified reporting. */
  fromSourceType?: string;
  /** The model that wrote it, for pools B and N. */
  generator?: string;
}

export interface EvalQuery {
  /** Stable, derived from text + filters, so mining twice cannot duplicate. */
  id: string;
  pool: PoolId;
  text: string;
  class: QueryClass;
  /**
   * Filters the agent actually passed, replayed on every run.
   *
   * Four of the mined queries were scoped to a project or a message kind, and
   * relevance was judged under that scope. Evaluating them unfiltered would score
   * them against a candidate universe the agent never saw.
   */
  filters: SearchFilters;
  provenance: QueryProvenance;
  /**
   * Pool B: the entry the question was written from, plus its near-duplicate
   * siblings (same project/type/title/timestamp). Siblings are included because
   * reranking keeps the best-scoring member of a duplicate group.
   */
  gold?: number[];
  /** Pool B/L: measured question↔entry term overlap; high means leakage. */
  leakage?: number;
  /**
   * Pool L: the literal the question was built around, and what kind it is.
   *
   * Recorded so a regression can be read at a glance — "every measurement query
   * lost recall, identifiers were fine" is a diagnosis; "pool L dropped" is not.
   */
  literal?: string;
  literalShape?: string;
}

export interface QueryFile {
  version: 1;
  generatedAt: string;
  /** Leakage threshold Pool B was filtered at, and what it cost. */
  poolB?: {
    leakageThreshold: number;
    rejected: number;
    accepted: number;
    /**
     * Pool B's hit@30 under sparse-only retrieval, measured at build time.
     *
     * The validation for the threshold rather than a claim about it: if the
     * accepted questions were still echoing their source entries, keyword search
     * alone would find nearly all of them and this number would sit near 1.0.
     */
    sparseOnlyHitAt30?: number;
  };
  queries: EvalQuery[];
}

export interface JudgeLabel {
  queryId: string;
  entryId: number;
  grade: Grade;
  why: string;
  /** Model that produced this label, or 'human' after arbitration. */
  judge: string;
}

export interface JudgementFile {
  version: 1;
  generatedAt: string;
  primaryJudge: string;
  secondJudge?: string;
  /** Seed the candidate order was shuffled with, so a pass is reproducible. */
  shuffleSeed: number;
  labels: JudgeLabel[];
  /** Inter-judge agreement over the double-labelled subsample. */
  agreement?: AgreementReport & { subsampleFraction: number };
  /**
   * Candidates the judge could not label after every retry.
   *
   * Kept as a first-class list rather than defaulted to grade 0: an unlabelled
   * candidate scored as irrelevant is a fabricated label, and metrics computed
   * over fabricated labels are exactly the unearned confidence this harness
   * exists to prevent. They bound the metric instead (see report.ts).
   */
  unjudged: { queryId: string; entryId: number; reason: string }[];
}

/**
 * What the index looked like when a run happened.
 *
 * The corpus grows every five minutes, so two runs on different days are not
 * comparable by default. A recorded baseline without this is a number whose
 * meaning has quietly expired.
 */
export interface CorpusFingerprint {
  entries: number;
  newestOccurredAt: string | null;
  collection: string;
  embedder: string;
  embedderDim: number;
  /** Hash of the judgement fixture, so relabelling invalidates a baseline. */
  judgementsHash: string;
}

export interface BaselineFile {
  version: 1;
  recordedAt: string;
  fingerprint: CorpusFingerprint;
  /** variant → pool → class → metric → value. */
  metrics: Record<string, unknown>;
}
