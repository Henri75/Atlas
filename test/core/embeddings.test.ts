import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectionNameFor } from '@atlas/core';
import {
  compareVersions,
  createOllamaProvider,
  ollamaAvailable,
  ollamaHasModel,
  warnIfOllamaTooOld,
} from '../../packages/core/src/embeddings/ollama.js';
import { createOpenAICompatProvider } from '../../packages/core/src/embeddings/openaiCompat.js';
import { DEFAULT_G2P_CLIENT_ID } from '../../packages/core/src/g2pHeaders.js';

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

/**
 * Embeddings hit the same G2P proxy as chat and are billed the same way, so
 * they carry the same attribution header. Indexing is by far the highest-volume
 * caller, so dropping it here would understate our usage more than anywhere.
 */
describe('openai-compatible embeddings client identity', () => {
  const okBody = { data: [{ index: 0, embedding: [0.1, 0.2] }] };

  /** Captures the request the dimension probe issues on construction. */
  async function create(clientId?: string) {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => okBody,
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fn);
    await createOpenAICompatProvider({
      name: 'g2p',
      baseUrl: 'http://llm/v1',
      model: 'm',
      clientId,
    });
    return (fn.mock.calls[0] as any)[1].headers;
  }

  it('sends the configured client id', async () => {
    expect((await create('Atlas'))['X-G2P-Client-Id']).toBe('Atlas');
  });

  it('falls back to the default client id', async () => {
    expect((await create())['X-G2P-Client-Id']).toBe(DEFAULT_G2P_CLIENT_ID);
  });

  it('omits the header when explicitly opted out', async () => {
    expect((await create(''))['X-G2P-Client-Id']).toBeUndefined();
  });
});

/**
 * The probe that decides the embedding model — and therefore the collection,
 * and therefore the whole index.
 *
 * It was a single fetch with a 2s timeout and no retry. On 2026-07-29, with the
 * host at load 26, it lost that race while Ollama was running and reachable the
 * whole time: the indexer booted on the bundled 384-dim model, created a new
 * empty collection, and began re-embedding 326k entries. Left alone it would
 * have published that collection and reclaimed the good one. A transient blip
 * must not be able to migrate the index.
 */
describe('ollamaAvailable', () => {
  const noSleep = async () => {};

  it('accepts a healthy Ollama on the first try, without retrying', async () => {
    const fn = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fn);

    expect(await ollamaAvailable('http://x', { sleep: noSleep })).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  /** The regression. */
  it('survives a transient failure and accepts on a later attempt', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error('The operation was aborted due to timeout');
        return { ok: true } as Response;
      }),
    );

    expect(await ollamaAvailable('http://x', { sleep: noSleep })).toBe(true);
    expect(calls).toBe(3);
  });

  it('concedes only after every attempt has failed', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fn);

    expect(await ollamaAvailable('http://x', { attempts: 3, sleep: noSleep })).toBe(false);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('treats a non-ok response as a failed attempt, not as unreachable', async () => {
    // A 503 while Ollama is still loading is exactly the case worth retrying.
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return { ok: calls >= 2 } as Response;
      }),
    );

    expect(await ollamaAvailable('http://x', { sleep: noSleep })).toBe(true);
    expect(calls).toBe(2);
  });
});

/**
 * The *other* single-shot call on the auto path, and the one that survived the
 * 2026-07-29 fix: `createOllamaProvider` ends with one `/api/embed` to learn the
 * dimension. `autoSelect` catches anything it throws and returns the bundled CPU
 * provider — so a single slow embed still starts the whole downgrade chain that
 * hardening `/api/tags` was meant to stop.
 *
 * It is also the slowest call in the sequence, because it is the one that pays
 * the model's cold-load cost. Measured on the incident host at load 18.8: 13.4s
 * cold against 0.23s warm, with real indexing batches logged at 45.2s — those
 * survive only because `pipeline.ts` wraps them in `withRetry`. Boot had no such
 * wrapper.
 */
describe('createOllamaProvider dimension probe', () => {
  const noSleep = async () => {};
  const embedOk = {
    ok: true,
    status: 200,
    json: async () => ({ embeddings: [Array.from({ length: 768 }, () => 0.1)] }),
    text: async () => '',
  };

  it('resolves the dimension when the first probe succeeds', async () => {
    const fn = vi.fn(async () => embedOk as unknown as Response);
    vi.stubGlobal('fetch', fn);

    const p = await createOllamaProvider('http://x', 'nomic-embed-text', { sleep: noSleep });
    expect(p).toMatchObject({ name: 'ollama', model: 'nomic-embed-text', dim: 768 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  /** The regression: a cold model load that overran the ceiling meant a CPU index. */
  it('retries a timed-out probe instead of conceding the index to the CPU model', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error('The operation was aborted due to timeout');
        return embedOk as unknown as Response;
      }),
    );

    const p = await createOllamaProvider('http://x', 'nomic-embed-text', { sleep: noSleep });
    expect(p.dim).toBe(768);
    expect(calls).toBe(3);
  });

  it('retries a 503 from an Ollama still loading its runner', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return (calls >= 2 ? embedOk : { ok: false, status: 503, text: async () => 'loading' }) as unknown as Response;
      }),
    );

    expect((await createOllamaProvider('http://x', 'm', { sleep: noSleep })).dim).toBe(768);
    expect(calls).toBe(2);
  });

  it('still throws once every attempt has failed, so an explicit provider fails loudly', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fn);

    await expect(createOllamaProvider('http://x', 'm', { attempts: 3, sleep: noSleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  /**
   * A 404 means the model is not there; no amount of waiting changes that, and
   * retrying it delays the pull that would actually fix it.
   */
  it('does not retry a client error', async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 404, text: async () => 'model not found' }) as unknown as Response);
    vi.stubGlobal('fetch', fn);

    await expect(createOllamaProvider('http://x', 'nope', { sleep: noSleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  /**
   * Steady-state embeds keep the tight ceiling and stay unretried *here* — the
   * indexer wraps them in `withRetry` with its own budget, and nesting the two
   * would multiply attempts on every batch of a 326k-entry rebuild.
   */
  it('leaves steady-state embeds unretried', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) return embedOk as unknown as Response;
        throw new Error('The operation was aborted due to timeout');
      }),
    );

    const p = await createOllamaProvider('http://x', 'm', { sleep: noSleep });
    await expect(p.embed(['later'])).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
