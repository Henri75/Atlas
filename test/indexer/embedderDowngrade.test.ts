import { describe, expect, it } from 'vitest';
import { embedderDowngrade } from '../../packages/indexer/src/pipeline.js';

/**
 * The guard between a transient probe failure and losing the index.
 *
 * The collection name encodes the embedding dimension, so resolving a different
 * embedder means a different collection. The boot sequence then re-embeds every
 * entry into it, publishes it as active, and reclaims the previous one as an
 * orphan. That chain is correct when an operator deliberately switches models
 * and catastrophic when `auto` merely lost a race with a loaded host — which is
 * what happened on 2026-07-29.
 *
 * The distinction is not "did the collection change" but "did anyone ask for
 * this". An explicit provider is an instruction; `auto` falling back is a guess.
 */
const base = {
  configuredProvider: 'auto',
  resolvedName: 'bundled',
  targetCollection: 'kdbscope_bundled_384',
  activeCollection: 'kdbscope_ollama_768',
  populatedEntries: 326_000,
  allowDowngrade: false,
};

describe('embedderDowngrade', () => {
  it('refuses when auto falls back and the active collection is populated', () => {
    expect(embedderDowngrade(base).refuse).toBe(true);
  });

  it('names what to do about it', () => {
    // A refusal nobody can act on is just a crash.
    const r = embedderDowngrade(base);
    expect(r.reason).toMatch(/EMBEDDINGS_PROVIDER/);
    expect(r.reason).toContain('kdbscope_ollama_768');
  });

  it('allows an explicitly configured provider, however different', () => {
    // Setting EMBEDDINGS_PROVIDER=bundled is an instruction, not an accident.
    expect(embedderDowngrade({ ...base, configuredProvider: 'bundled' }).refuse).toBe(false);
  });

  it('allows auto when it resolved to its preferred provider', () => {
    expect(
      embedderDowngrade({
        ...base,
        resolvedName: 'ollama',
        targetCollection: 'kdbscope_ollama_768',
      }).refuse,
    ).toBe(false);
  });

  it('allows the first boot, when there is nothing to lose', () => {
    expect(embedderDowngrade({ ...base, activeCollection: null }).refuse).toBe(false);
  });

  it('allows a switch away from a collection that holds nothing', () => {
    // An empty active collection is not an index worth protecting.
    expect(embedderDowngrade({ ...base, populatedEntries: 0 }).refuse).toBe(false);
  });

  it('allows a re-boot onto the same collection', () => {
    expect(
      embedderDowngrade({ ...base, targetCollection: 'kdbscope_ollama_768' }).refuse,
    ).toBe(false);
  });

  it('yields to an explicit operator override', () => {
    expect(embedderDowngrade({ ...base, allowDowngrade: true }).refuse).toBe(false);
  });
});
