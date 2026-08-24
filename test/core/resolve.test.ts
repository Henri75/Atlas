import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasResolveError, invalidateCache, invalidateOnConflictHeader, proofFor, resolveActive } from '@atlas/core';

/**
 * Resolver matrix (spec §8, Task 24). The proof-verification math itself
 * (`canonicalJson`/`proofFor`) is already covered independently in
 * test/api/instance.test.ts and test/api/guard.test.ts — these tests focus
 * on the RESOLUTION algorithm: cache TTL, the exactly-one-active rule, and
 * the error taxonomy's naming.
 */

const TOKEN = 'sekret';

const MACHINES_YAML = `
machines:
  - name: nasta-mbp
    address: 192.168.1.20
    user: nasta
    codeRoots: ["/Users/nasta/code"]
    claudeProjects: /Users/nasta/.claude/projects
  - name: m4max
    address: 192.168.1.30
    user: serge
    codeRoots: ["/Users/serge/code"]
    claudeProjects: /Users/serge/.claude/projects
`;

function writeMachinesFile(content = MACHINES_YAML): string {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-machines-'));
  const p = join(dir, 'machines.yaml');
  writeFileSync(p, content);
  return p;
}

function tempCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-cache-'));
  return join(dir, 'active.json');
}

/** Builds a proof-valid `/api/instance` body the way the real route would. */
function signedBody(
  nonce: string,
  overrides: Partial<{ machine: string; bootId: string; state: string; entries: number }> = {},
) {
  const payload = {
    machine: overrides.machine ?? 'nasta-mbp',
    installId: 'install-x',
    bootId: overrides.bootId ?? randomUUID(),
    state: overrides.state ?? 'active',
    entries: overrides.entries ?? 10,
  };
  return { ...payload, proof: proofFor(TOKEN, nonce, payload) };
}

/**
 * A fake `fetch` keyed by hostname — resolveActive builds
 * `http://<address>:8710/api/instance?nonce=...` per machines.yaml entry, so
 * routing on the URL's hostname lets one fake stand in for the whole fleet.
 * `'unreachable'` simulates a dead/asleep host (network throw, same as the
 * real probeInstance's catch-all).
 */
function fakeFetch(byHost: Record<string, 'unreachable' | ((nonce: string) => Record<string, unknown>)>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const behavior = byHost[url.hostname];
    if (!behavior || behavior === 'unreachable') throw new Error('ECONNREFUSED');
    const nonce = url.searchParams.get('nonce')!;
    return { ok: true, json: async () => behavior(nonce) } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function rejectsWith(promise: Promise<unknown>): Promise<AtlasResolveError> {
  try {
    await promise;
  } catch (e) {
    return e as AtlasResolveError;
  }
  throw new Error('expected resolveActive to reject, but it resolved');
}

describe('resolveActive — probe-all outcomes', () => {
  it('0 reachable → none-reachable, naming both hosts', async () => {
    const machinesFile = writeMachinesFile();
    const err = await rejectsWith(
      resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl: fakeFetch({}), timeoutMs: 50 }),
    );
    expect(err).toBeInstanceOf(AtlasResolveError);
    expect(err.kind).toBe('none-reachable');
    expect(err.detail).toContain('nasta-mbp');
    expect(err.detail).toContain('m4max');
  });

  it('1 valid → resolves, writes the cache, mcpUrl/uiUrl from the winner address', async () => {
    const machinesFile = writeMachinesFile();
    const cachePath = tempCachePath();
    const fetchImpl = fakeFetch({
      '192.168.1.20': (nonce) => signedBody(nonce, { machine: 'nasta-mbp', entries: 55 }),
      '192.168.1.30': 'unreachable',
    });

    const result = await resolveActive({ machinesFile, token: TOKEN, cachePath, fetchImpl, timeoutMs: 50 });

    expect(result).toEqual({
      baseUrl: 'http://192.168.1.20:8710',
      mcpUrl: 'http://192.168.1.20:8711/mcp',
      uiUrl: 'http://192.168.1.20:8712',
      machine: 'nasta-mbp',
      fromCache: false,
    });
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cached).toMatchObject({ baseUrl: 'http://192.168.1.20:8710', machine: 'nasta-mbp' });
    expect(typeof cached.at).toBe('number');
  });

  it('mcpPort/uiPort overrides apply to the winner, never by arithmetic on baseUrl', async () => {
    const machinesFile = writeMachinesFile();
    const fetchImpl = fakeFetch({
      '192.168.1.20': (nonce) => signedBody(nonce, { machine: 'nasta-mbp' }),
      '192.168.1.30': 'unreachable',
    });
    const result = await resolveActive({
      machinesFile, token: TOKEN, cachePath: null, fetchImpl, timeoutMs: 50,
      mcpPort: 9001, uiPort: 9002,
    });
    expect(result.mcpUrl).toBe('http://192.168.1.20:9001/mcp');
    expect(result.uiUrl).toBe('http://192.168.1.20:9002');
  });

  it('2 valid → multiple-active, naming both', async () => {
    const machinesFile = writeMachinesFile();
    const fetchImpl = fakeFetch({
      '192.168.1.20': (nonce) => signedBody(nonce, { machine: 'nasta-mbp' }),
      '192.168.1.30': (nonce) => signedBody(nonce, { machine: 'm4max' }),
    });
    const err = await rejectsWith(
      resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl, timeoutMs: 50 }),
    );
    expect(err.kind).toBe('multiple-active');
    expect(err.detail).toContain('nasta-mbp');
    expect(err.detail).toContain('m4max');
  });

  it('a conflicted state anywhere → conflicted, even with just one responder', async () => {
    const machinesFile = writeMachinesFile();
    const fetchImpl = fakeFetch({
      '192.168.1.20': (nonce) => signedBody(nonce, { machine: 'nasta-mbp', state: 'conflicted' }),
      '192.168.1.30': 'unreachable',
    });
    const err = await rejectsWith(
      resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl, timeoutMs: 50 }),
    );
    expect(err.kind).toBe('conflicted');
    expect(err.detail).toContain('nasta-mbp');
    expect(err.detail).toContain('make stop');
  });

  it('a conflicted state takes priority over a second active responder', async () => {
    const machinesFile = writeMachinesFile();
    const fetchImpl = fakeFetch({
      '192.168.1.20': (nonce) => signedBody(nonce, { machine: 'nasta-mbp', state: 'conflicted' }),
      '192.168.1.30': (nonce) => signedBody(nonce, { machine: 'm4max', state: 'active' }),
    });
    const err = await rejectsWith(
      resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl, timeoutMs: 50 }),
    );
    expect(err.kind).toBe('conflicted');
  });

  it('bad proof from a configured machine → token-mismatch, naming it', async () => {
    const machinesFile = writeMachinesFile();
    const fetchImpl = fakeFetch({
      '192.168.1.20': (nonce) => ({ ...signedBody(nonce, { machine: 'nasta-mbp' }), proof: 'not-the-real-proof' }),
      '192.168.1.30': 'unreachable',
    });
    const err = await rejectsWith(
      resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl, timeoutMs: 50 }),
    );
    expect(err.kind).toBe('token-mismatch');
    expect(err.detail).toContain('nasta-mbp');
    expect(err.detail).toContain('Doppler');
  });

  it('missing proof (configured machine, we have a token) → token-mismatch, not none-reachable', async () => {
    const machinesFile = writeMachinesFile();
    const fetchImpl = fakeFetch({
      '192.168.1.20': (nonce) => {
        const { proof: _drop, ...rest } = signedBody(nonce, { machine: 'nasta-mbp' });
        return rest;
      },
      '192.168.1.30': 'unreachable',
    });
    const err = await rejectsWith(
      resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl, timeoutMs: 50 }),
    );
    expect(err.kind).toBe('token-mismatch');
    expect(err.detail).toContain('nasta-mbp');
  });

  it('missing machines.yaml → no-machines, naming the checked path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-nomachines-'));
    const missingPath = join(dir, 'does-not-exist.yaml');
    const err = await rejectsWith(
      resolveActive({ machinesFile: missingPath, cachePath: null, fetchImpl: vi.fn() as unknown as typeof fetch }),
    );
    expect(err.kind).toBe('no-machines');
    expect(err.detail).toContain(missingPath);
  });
});

describe('resolveActive — cache', () => {
  it('fresh cache short-circuits — fetch is never called', async () => {
    const machinesFile = writeMachinesFile();
    const cachePath = tempCachePath();
    writeFileSync(
      cachePath,
      JSON.stringify({ baseUrl: 'http://192.168.1.20:8710', machine: 'nasta-mbp', at: 1_000 }),
    );
    const fetchImpl = vi.fn();

    const result = await resolveActive({
      machinesFile,
      token: TOKEN,
      cachePath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000 + 60_000, // 1 min later — well within the 5-min TTL
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      baseUrl: 'http://192.168.1.20:8710',
      mcpUrl: 'http://192.168.1.20:8711/mcp',
      uiUrl: 'http://192.168.1.20:8712',
      machine: 'nasta-mbp',
      fromCache: true,
    });
  });

  it('stale cache + dead cached host → re-probes and finds the moved instance', async () => {
    const machinesFile = writeMachinesFile();
    const cachePath = tempCachePath();
    writeFileSync(
      cachePath,
      JSON.stringify({ baseUrl: 'http://192.168.1.20:8710', machine: 'nasta-mbp', at: 0 }),
    );
    const fetchImpl = fakeFetch({
      '192.168.1.20': 'unreachable', // the cached host is dead now
      '192.168.1.30': (nonce) => signedBody(nonce, { machine: 'm4max' }), // instance moved here
    });

    const result = await resolveActive({
      machinesFile,
      token: TOKEN,
      cachePath,
      fetchImpl,
      timeoutMs: 50,
      now: () => 10 * 60_000, // 10 min later — TTL (5 min) has expired
    });

    expect(result.machine).toBe('m4max');
    expect(result.baseUrl).toBe('http://192.168.1.30:8710');
    expect(result.fromCache).toBe(false);

    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cached.machine).toBe('m4max'); // cache refreshed to the new winner
  });

  it('cachePath: null disables caching — every call probes fresh, nothing persists across calls', async () => {
    const machinesFile = writeMachinesFile();
    const fetchImpl = vi.fn(
      fakeFetch({
        '192.168.1.20': (nonce) => signedBody(nonce, { machine: 'nasta-mbp' }),
        '192.168.1.30': 'unreachable',
      }),
    );

    await resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 50 });
    await resolveActive({ machinesFile, token: TOKEN, cachePath: null, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 50 });

    // Two full rounds x 2 machines = 4 calls; a cache would have made the
    // second resolveActive call short-circuit with 0 extra fetches.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('resolveActive — env override', () => {
  const savedAtlas = process.env.ATLAS_API_URL;
  const savedLegacy = process.env.KDBSCOPE_API_URL;

  afterEach(() => {
    if (savedAtlas === undefined) delete process.env.ATLAS_API_URL;
    else process.env.ATLAS_API_URL = savedAtlas;
    if (savedLegacy === undefined) delete process.env.KDBSCOPE_API_URL;
    else process.env.KDBSCOPE_API_URL = savedLegacy;
  });

  it('ATLAS_API_URL wins outright — unprobed, cache and machines.yaml both skipped', async () => {
    delete process.env.KDBSCOPE_API_URL;
    process.env.ATLAS_API_URL = 'http://10.0.0.5:8710';
    const fetchImpl = vi.fn();

    const result = await resolveActive({
      machinesFile: join(tmpdir(), 'never-read-this-path.yaml'),
      cachePath: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      baseUrl: 'http://10.0.0.5:8710',
      mcpUrl: 'http://10.0.0.5:8711/mcp',
      uiUrl: 'http://10.0.0.5:8712',
      machine: '10.0.0.5',
      fromCache: false,
    });
  });

  it('legacy KDBSCOPE_API_URL still works and warns once to stderr, not on every call', async () => {
    delete process.env.ATLAS_API_URL;
    process.env.KDBSCOPE_API_URL = 'http://10.0.0.9:8710';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const fetchImpl = vi.fn();
      const r1 = await resolveActive({ machinesFile: 'unused', cachePath: null, fetchImpl: fetchImpl as unknown as typeof fetch });
      const r2 = await resolveActive({ machinesFile: 'unused', cachePath: null, fetchImpl: fetchImpl as unknown as typeof fetch });

      expect(r1.baseUrl).toBe('http://10.0.0.9:8710');
      expect(r2.baseUrl).toBe('http://10.0.0.9:8710');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/KDBSCOPE_API_URL/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('invalidateOnConflictHeader', () => {
  it('deletes the cache file and returns true when the header is conflicted', () => {
    const cachePath = tempCachePath();
    writeFileSync(cachePath, JSON.stringify({ baseUrl: 'http://x:8710', machine: 'x', at: 0 }));
    const headers = { get: (name: string) => (name === 'X-Atlas-State' ? 'conflicted' : null) };

    expect(invalidateOnConflictHeader(headers, cachePath)).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('leaves the cache alone and returns false for active or missing headers', () => {
    const cachePath = tempCachePath();
    writeFileSync(cachePath, JSON.stringify({ baseUrl: 'http://x:8710', machine: 'x', at: 0 }));

    const activeHeaders = { get: (name: string) => (name === 'X-Atlas-State' ? 'active' : null) };
    expect(invalidateOnConflictHeader(activeHeaders, cachePath)).toBe(false);
    expect(existsSync(cachePath)).toBe(true);

    const missingHeaders = { get: () => null };
    expect(invalidateOnConflictHeader(missingHeaders, cachePath)).toBe(false);
    expect(existsSync(cachePath)).toBe(true);
  });

  it('returns true without throwing when the header is conflicted but no cache file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-cache-'));
    const missingCachePath = join(dir, 'missing.json');
    const headers = { get: (name: string) => (name === 'X-Atlas-State' ? 'conflicted' : null) };

    expect(() => invalidateOnConflictHeader(headers, missingCachePath)).not.toThrow();
    expect(invalidateOnConflictHeader(headers, missingCachePath)).toBe(true);
  });
});

/**
 * Spec §8 lists three re-probe triggers: TTL expiry, the conflicted header,
 * and a CONNECTION FAILURE. Only the first two had an implementation — a
 * thrown fetch has no response and therefore no header to read, so nothing
 * cleared the cache and every caller kept dialling the dead host for the
 * rest of its 5-minute TTL. This is the missing third one, used by the
 * CLI's `doFetch` catch, the shim's retry path, and `atlas which`.
 */
describe('invalidateCache', () => {
  it('deletes the cache file and reports that it did', () => {
    const cachePath = tempCachePath();
    writeFileSync(cachePath, JSON.stringify({ baseUrl: 'http://x:8710', machine: 'x', at: 0 }));

    expect(invalidateCache(cachePath)).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('is a no-op returning false when nothing is cached', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'resolve-cache-')), 'missing.json');
    expect(() => invalidateCache(missing)).not.toThrow();
    expect(invalidateCache(missing)).toBe(false);
  });

  it('a resolve after invalidation re-probes instead of answering from cache', async () => {
    const cachePath = tempCachePath();
    const machinesFile = writeMachinesFile();
    // A cache entry well inside its TTL, naming a host that has since moved:
    // without invalidation the next resolve returns it verbatim with zero
    // network calls (fromCache: true), which is exactly the stale-after-
    // connection-failure behavior this exists to end.
    writeFileSync(
      cachePath,
      JSON.stringify({ baseUrl: 'http://192.168.1.20:8710', machine: 'nasta-mbp', at: Date.now() }),
    );

    expect(invalidateCache(cachePath)).toBe(true);

    const fetchImpl = fakeFetch({
      '192.168.1.20': 'unreachable',
      '192.168.1.30': (nonce) => signedBody(nonce, { machine: 'm4max' }),
    });
    const resolved = await resolveActive({ machinesFile, token: TOKEN, cachePath, fetchImpl, timeoutMs: 50 });

    expect(resolved.fromCache).toBe(false);
    expect(resolved.machine).toBe('m4max');
  });
});
