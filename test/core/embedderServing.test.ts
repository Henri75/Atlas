import { describe, expect, it } from 'vitest';
import { collectionNameFor, embedderServesCollection } from '@atlas/core';

/**
 * The half of the 2026-07-29 downgrade the indexer's refusal does not cover.
 *
 * `embedderDowngrade` protects the *index*: it stops a fallback embedder moving
 * `active_collection` and reclaiming the good one. Nothing protected the *API*,
 * which resolves its own embedder from the same `auto` config, in its own
 * process, racing the same loaded host. A 384-dim API against the published
 * 768-dim collection is not an error anyone sees: Qdrant rejects the dense
 * query, `SearchService` catches it, and every search falls through to the
 * Postgres FTS path — ~12s a query, `degraded: true`, and a dashboard still
 * reporting `ollama/768` because `embedderHealth` reads the setting the
 * *indexer* wrote.
 *
 * The test is collection identity, not dimension: two different models can
 * share a dimension and produce vectors in unrelated spaces, which Qdrant would
 * accept and answer with nonsense. Nonsense that returns 200 is worse than an
 * error.
 */
describe('embedderServesCollection', () => {
  const ollama = { name: 'ollama', model: 'nomic-embed-text', dim: 768 };
  const bundled = { name: 'bundled', model: 'Xenova/all-MiniLM-L6-v2', dim: 384 };
  const active = collectionNameFor(ollama.name, ollama.model, ollama.dim);

  it('serves when the embedder produced the active collection', () => {
    expect(embedderServesCollection(ollama, active)).toMatchObject({ serves: true });
  });

  /** The regression. */
  it('refuses a fallback embedder against a collection it cannot query', () => {
    const v = embedderServesCollection(bundled, active);
    expect(v.serves).toBe(false);
    expect(v.reason).toContain('bundled');
    expect(v.reason).toContain(active);
  });

  it('refuses a same-dimension embedder from a different model', () => {
    // 768 both sides, unrelated vector spaces: Qdrant answers, with nonsense.
    const other = { name: 'openai', model: 'text-embedding-3-small', dim: 768 };
    expect(embedderServesCollection(other, active).serves).toBe(false);
  });

  it('serves when the indexer has not published a collection yet', () => {
    // First boot: the API derives the collection from its own embedder, and
    // whatever it resolved is by definition the one that will be used.
    expect(embedderServesCollection(bundled, null).serves).toBe(true);
  });

  it('reports no embedder as not serving, without inventing a reason to panic', () => {
    const v = embedderServesCollection(null, active);
    expect(v.serves).toBe(false);
    expect(v.reason).toMatch(/no embedder/i);
  });

  it('serves a genuine bundled-everywhere deployment', () => {
    // Asking for bundled and getting bundled is the system working; the guard
    // must not fire just because the model is the slow one.
    const bundledCollection = collectionNameFor(bundled.name, bundled.model, bundled.dim);
    expect(embedderServesCollection(bundled, bundledCollection).serves).toBe(true);
  });
});
