import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fnv1a, tokenize, type SearchFilters, type SearchHit } from '@atlas/core';
import type { EvalQuery, JudgementFile, QueryFile } from './types.js';

/**
 * Fixture handling: identity, merging, leakage control and gold-set expansion.
 *
 * The fixtures are the harness's memory. Everything here exists so that running
 * a step twice cannot quietly change what a past number meant.
 */

/**
 * Stable query id from text plus filters.
 *
 * Filters are part of the identity, not decoration: the same words scoped to
 * `deepcast` and scoped to nothing are two different retrieval problems with
 * two different candidate universes, and merging them would silently apply one
 * query's judgements to the other's results.
 */
export function queryId(text: string, filters: SearchFilters = {}): string {
  const norm = text.trim().replace(/\s+/g, ' ').toLowerCase();
  // Sorted keys so an equivalent filter object written in a different order is
  // the same query, not a new one.
  const f = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? [...v].sort().join(',') : String(v)}`)
    .join('&');
  return fnv1a(`${norm}|${f}`).toString(16).padStart(8, '0');
}

/**
 * Merge newly mined queries into the committed set without overwriting.
 *
 * Mining is re-run as traffic accumulates. Hand-assigned classes and everything
 * downstream of them (judgements keyed by query id) must survive that, or every
 * mining pass would silently reset the labelling work.
 */
export function mergeQueries(
  existing: EvalQuery[],
  incoming: EvalQuery[],
): { queries: EvalQuery[]; added: number; kept: number } {
  const byId = new Map(existing.map((q) => [q.id, q]));
  let added = 0;
  for (const q of incoming) {
    if (byId.has(q.id)) continue;
    byId.set(q.id, q);
    added++;
  }
  return { queries: [...byId.values()], added, kept: existing.length };
}

/**
 * Fraction of the question's content terms that also appear in the entry it was
 * generated from.
 *
 * Reuses the sparse encoder's own tokeniser, so "leakage" is measured in exactly
 * the vocabulary the keyword branch of retrieval sees — a question could look
 * freshly worded to a human while sharing every term the BM25 branch cares about.
 */
export function leakage(question: string, entryText: string): number {
  const q = new Set(tokenize(question));
  if (!q.size) return 0;
  const e = new Set(tokenize(entryText));
  let shared = 0;
  for (const t of q) if (e.has(t)) shared++;
  return shared / q.size;
}

/**
 * Questions above this share too much of their source entry's wording: the
 * keyword branch would find them regardless of ranking, which both inflates
 * every score and biases the harness against changes that improve semantic
 * matching.
 *
 * Not asserted — validated. The fixture build measures Pool B's hit@30 under
 * sparse-only retrieval and commits it; a value near 1.0 means leakage survived
 * and this number has to come down.
 */
export const LEAKAGE_THRESHOLD = 0.6;

/**
 * Same key `rerankForContext` collapses duplicates on.
 *
 * Duplicated here rather than exported from core because core's is private to
 * its reranking pass; the two must agree, which the eval tests assert against
 * real reranker output rather than by reading both.
 */
export function dedupeKeyOf(h: Pick<SearchHit, 'projectSlug' | 'sourceType' | 'title' | 'occurredAt'>): string {
  return `${h.projectSlug}|${h.sourceType}|${h.title}|${h.occurredAt ?? ''}`;
}

/**
 * Expand a known-item gold entry to every entry that is the same content.
 *
 * Reranking keeps the best-scoring member of a duplicate group, which need not
 * be the row the question was written from. Without this, Pool B would score a
 * successful retrieval as a miss and the near-duplicate collapse shipped in
 * Phase 3 would look like a regression.
 */
export function expandGold(
  target: { entryId: number } & Parameters<typeof dedupeKeyOf>[0],
  candidates: ({ entryId: number } & Parameters<typeof dedupeKeyOf>[0])[],
): number[] {
  const key = dedupeKeyOf(target);
  const ids = new Set<number>([target.entryId]);
  for (const c of candidates) if (dedupeKeyOf(c) === key) ids.add(c.entryId);
  return [...ids].sort((a, b) => a - b);
}

/** Stable hash of the judgement labels, so relabelling invalidates a baseline. */
export function hashJudgements(j: JudgementFile): string {
  const canonical = [...j.labels]
    .sort((a, b) => a.queryId.localeCompare(b.queryId) || a.entryId - b.entryId)
    .map((l) => `${l.queryId}:${l.entryId}:${l.grade}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Relevant-entry set per query, at the configured grade cutoff. */
export function relevantByQuery(j: JudgementFile, minGrade: number): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const l of j.labels) {
    if (l.grade < minGrade) continue;
    let set = out.get(l.queryId);
    if (!set) out.set(l.queryId, (set = new Set()));
    set.add(l.entryId);
  }
  return out;
}

/**
 * Every grade recorded for a query, needed for the ideal DCG denominator.
 *
 * A pair can carry up to three labels: the primary judge, the second judge (for
 * the agreement subsample), and a human arbitration. Precedence is explicit —
 * human, then the primary judge, then anything else — because file order cannot
 * be relied on to express it. The labels are sorted by judge name when written,
 * and `cline-pass/glm-5.2` sorts *before* `cline-pass/kimi-k3`, so a
 * first-one-wins rule would silently promote the second judge's opinion to
 * authoritative for every double-labelled pair.
 */
export function gradesByQuery(j: JudgementFile): Map<string, Map<number, number>> {
  const rank = (judge: string) => (judge === 'human' ? 2 : judge === j.primaryJudge ? 1 : 0);
  const out = new Map<string, Map<number, number>>();
  const chosen = new Map<string, number>();
  for (const l of j.labels) {
    let m = out.get(l.queryId);
    if (!m) out.set(l.queryId, (m = new Map()));
    const key = `${l.queryId}:${l.entryId}`;
    const best = chosen.get(key);
    if (best === undefined || rank(l.judge) > best) {
      chosen.set(key, rank(l.judge));
      m.set(l.entryId, l.grade);
    }
  }
  return out;
}

/** Written with two-space indent and sorted queries so diffs stay readable. */
export async function saveQueries(path: string, file: QueryFile): Promise<void> {
  const sorted: QueryFile = {
    ...file,
    queries: [...file.queries].sort((a, b) => a.pool.localeCompare(b.pool) || a.id.localeCompare(b.id)),
  };
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

export async function loadQueries(path: string): Promise<QueryFile> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as QueryFile;
  validateQueries(raw);
  return raw;
}

export async function saveJudgements(path: string, file: JudgementFile): Promise<void> {
  const sorted: JudgementFile = {
    ...file,
    labels: [...file.labels].sort(
      (a, b) => a.queryId.localeCompare(b.queryId) || a.entryId - b.entryId || a.judge.localeCompare(b.judge),
    ),
  };
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

export async function loadJudgements(path: string): Promise<JudgementFile> {
  return JSON.parse(await readFile(path, 'utf8')) as JudgementFile;
}

/**
 * Fail loudly on a malformed fixture.
 *
 * A silently-skipped query would shrink the query set without shrinking any
 * reported n, which is the most dangerous shape of error this harness can have:
 * the numbers would still look like a full evaluation.
 */
export function validateQueries(file: QueryFile): void {
  if (file.version !== 1) throw new Error(`unsupported query fixture version ${file.version}`);
  const seen = new Set<string>();
  for (const q of file.queries) {
    const expected = queryId(q.text, q.filters);
    if (q.id !== expected) {
      throw new Error(`query ${q.id} ("${q.text.slice(0, 40)}…") has id ${q.id}, expected ${expected}`);
    }
    if (seen.has(q.id)) throw new Error(`duplicate query id ${q.id}`);
    seen.add(q.id);
    if (q.pool === 'B' && !q.gold?.length) {
      throw new Error(`pool B query ${q.id} has no gold entries — it cannot be scored`);
    }
    if (q.pool === 'N' && q.gold?.length) {
      throw new Error(`pool N query ${q.id} has gold entries — it is not a negative`);
    }
  }
}
