import { describe, expect, it } from 'vitest';
import { embedderStatus } from '@atlas/core';

/**
 * "Running on a fallback embedder" was only ever visible in `docker logs`.
 *
 * That is where it stayed on 2026-07-29 while the indexer quietly began
 * rebuilding the index on a CPU model — the dashboard reported every dependency
 * healthy, because reachability was all it measured, and reachability was fine.
 * A degraded embedder is not an outage; it is worse, because nothing looks
 * wrong.
 */
describe('embedderStatus', () => {
  it('reports a healthy auto resolution as not a fallback', () => {
    const s = embedderStatus('auto', 'ollama/nomic-embed-text/768');
    expect(s).toMatchObject({ name: 'ollama', model: 'nomic-embed-text', dim: 768, fallback: false });
  });

  it('flags auto that settled for the bundled model', () => {
    const s = embedderStatus('auto', 'bundled/Xenova/all-MiniLM-L6-v2/384');
    expect(s.fallback).toBe(true);
  });

  /** The model name itself contains slashes; only the first and last fields are fixed. */
  it('parses a model name containing slashes', () => {
    const s = embedderStatus('auto', 'bundled/Xenova/all-MiniLM-L6-v2/384');
    expect(s.name).toBe('bundled');
    expect(s.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(s.dim).toBe(384);
  });

  it('does not call an explicitly chosen provider a fallback', () => {
    // Asking for bundled and getting bundled is the system working.
    expect(embedderStatus('bundled', 'bundled/Xenova/all-MiniLM-L6-v2/384').fallback).toBe(false);
    expect(embedderStatus('g2p', 'g2p/text-embedding-3-small/1536').fallback).toBe(false);
  });

  it('reports unknown rather than guessing before the indexer has ever run', () => {
    const s = embedderStatus('auto', null);
    expect(s).toMatchObject({ name: null, model: null, dim: null, fallback: false });
  });

  it('survives a malformed setting without throwing', () => {
    const s = embedderStatus('auto', 'nonsense');
    expect(s.fallback).toBe(false);
    expect(s.dim).toBeNull();
  });

  it('carries the configured provider through, so a reader can see both', () => {
    expect(embedderStatus('auto', 'ollama/nomic-embed-text/768').configured).toBe('auto');
  });
});
