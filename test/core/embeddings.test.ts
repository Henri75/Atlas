import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectionNameFor } from '@kdbscope/core';
import {
  compareVersions,
  ollamaHasModel,
  warnIfOllamaTooOld,
} from '../../packages/core/src/embeddings/ollama.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string) => { ok: boolean; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const r = handler(String(url));
      return {
        ok: r.ok,
        status: r.ok ? 200 : 500,
        json: async () => r.body,
        text: async () => JSON.stringify(r.body ?? ''),
      };
    }),
  );
}

describe('ollamaHasModel', () => {
  it('matches a bare model name against the ":latest" tag', async () => {
    stubFetch(() => ({ ok: true, body: { models: [{ name: 'nomic-embed-text:latest' }] } }));
    expect(await ollamaHasModel('http://x', 'nomic-embed-text')).toBe(true);
  });

  it('matches an explicitly tagged model', async () => {
    stubFetch(() => ({ ok: true, body: { models: [{ name: 'bge-m3:567m' }] } }));
    expect(await ollamaHasModel('http://x', 'bge-m3:567m')).toBe(true);
  });

  it('returns false when the model is absent', async () => {
    stubFetch(() => ({ ok: true, body: { models: [{ name: 'llama3:latest' }] } }));
    expect(await ollamaHasModel('http://x', 'nomic-embed-text')).toBe(false);
  });

  it('returns false when Ollama has no models at all', async () => {
    stubFetch(() => ({ ok: true, body: {} }));
    expect(await ollamaHasModel('http://x', 'nomic-embed-text')).toBe(false);
  });

  it('returns false (never throws) when Ollama is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await ollamaHasModel('http://x', 'nomic-embed-text')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    // '0.9' > '0.12' as strings, but 0.12 is the newer release.
    expect(compareVersions('0.12.6', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.31.1', '0.13.0')).toBeGreaterThan(0);
    expect(compareVersions('0.12.6', '0.13.0')).toBeLessThan(0);
    expect(compareVersions('0.13.0', '0.13.0')).toBe(0);
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.1', '1.0.9')).toBeGreaterThan(0);
  });
});

/**
 * Ollama 0.12.6 segfaults inside /api/embed under load and then hangs, which
 * stalls indexing with no error anywhere. Warn, but never refuse to boot.
 */
describe('warnIfOllamaTooOld', () => {
  it('warns for a version below the floor', async () => {
    stubFetch(() => ({ ok: true, body: { version: '0.12.6' } }));
    const msg = await warnIfOllamaTooOld('http://x');
    expect(msg).toMatch(/0\.12\.6 is below/);
    expect(msg).toMatch(/brew upgrade ollama/);
  });

  it('stays silent for a good version', async () => {
    stubFetch(() => ({ ok: true, body: { version: '0.31.1' } }));
    expect(await warnIfOllamaTooOld('http://x')).toBeNull();
  });

  it('never throws when Ollama is unreachable or the version is unparseable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await warnIfOllamaTooOld('http://x')).toBeNull();

    stubFetch(() => ({ ok: true, body: { version: 'custom-build' } }));
    expect(await warnIfOllamaTooOld('http://x')).toBeNull();

    stubFetch(() => ({ ok: true, body: {} }));
    expect(await warnIfOllamaTooOld('http://x')).toBeNull();
  });
});

describe('collectionNameFor', () => {
  it('encodes provider, model and dim so switching models is a new collection', () => {
    expect(collectionNameFor('ollama', 'nomic-embed-text', 768)).toBe(
      'kdbscope_ollama_nomic_embed_text_768',
    );
    expect(collectionNameFor('bundled', 'Xenova/all-MiniLM-L6-v2', 384)).toBe(
      'kdbscope_bundled_xenova_all_minilm_l6_v2_384',
    );
  });

  it('never collides across providers with the same dim', () => {
    expect(collectionNameFor('ollama', 'm', 768)).not.toBe(collectionNameFor('openai', 'm', 768));
  });
});
