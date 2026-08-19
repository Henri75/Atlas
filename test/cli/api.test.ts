import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proofFor } from '@atlas/core';
import { computeBaseUrl } from '../../packages/cli/src/api.js';

/**
 * `computeBaseUrl` is `baseUrl()`'s pure decision logic (api.ts) — the
 * memoized `baseUrl()` itself is thin glue over this and stays untested
 * (house norm: command handlers/glue don't get unit tests). These tests
 * exercise the ordering without a live server: env override skips both the
 * localhost probe and the resolver's own probe; the localhost fast path
 * short-circuits the resolver entirely when reachable; and a fallthrough to
 * the full resolver when it isn't. `cachePath: null` throughout the
 * fallthrough tests so none of this ever touches the real
 * `~/.atlas/active.json` on the machine running the suite —
 * `resolveActive` has no injectable env of its own (it reads real
 * `process.env` directly), so the env-override tests save/restore the real
 * vars instead, matching `test/core/resolve.test.ts`'s own convention.
 */

function writeMachinesFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-api-machines-'));
  const p = join(dir, 'machines.yaml');
  writeFileSync(p, content);
  return p;
}

/** A path guaranteed not to exist, so `readToken` resolves to undefined — never this machine's real `~/.atlas/credentials`. */
function noCredentials(): string {
  return join(mkdtempSync(join(tmpdir(), 'cli-api-nocreds-')), 'credentials');
}

const ONE_MACHINE_YAML = `
machines:
  - name: nasta-mbp
    address: 192.168.1.20
    user: nasta
    codeRoots: ["/Users/nasta/code"]
    claudeProjects: /Users/nasta/.claude/projects
`;

describe('computeBaseUrl — env override', () => {
  const savedAtlas = process.env.ATLAS_API_URL;
  const savedLegacy = process.env.KDBSCOPE_API_URL;

  afterEach(() => {
    if (savedAtlas === undefined) delete process.env.ATLAS_API_URL;
    else process.env.ATLAS_API_URL = savedAtlas;
    if (savedLegacy === undefined) delete process.env.KDBSCOPE_API_URL;
    else process.env.KDBSCOPE_API_URL = savedLegacy;
  });

  it('ATLAS_API_URL wins outright — fetchImpl is never called (no localhost probe, no resolver probe)', async () => {
    delete process.env.KDBSCOPE_API_URL;
    process.env.ATLAS_API_URL = 'http://10.0.0.5:8710';
    const fetchImpl = vi.fn();

    const result = await computeBaseUrl({
      machinesFile: join(tmpdir(), 'never-read.yaml'),
      cachePath: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBe('http://10.0.0.5:8710');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('legacy KDBSCOPE_API_URL also skips the localhost probe', async () => {
    delete process.env.ATLAS_API_URL;
    process.env.KDBSCOPE_API_URL = 'http://10.0.0.9:8710';
    const fetchImpl = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await computeBaseUrl({
        machinesFile: join(tmpdir(), 'never-read.yaml'),
        cachePath: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result).toBe('http://10.0.0.9:8710');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('computeBaseUrl — localhost fast path', () => {
  const savedAtlas = process.env.ATLAS_API_URL;
  const savedLegacy = process.env.KDBSCOPE_API_URL;
  afterEach(() => {
    if (savedAtlas === undefined) delete process.env.ATLAS_API_URL;
    else process.env.ATLAS_API_URL = savedAtlas;
    if (savedLegacy === undefined) delete process.env.KDBSCOPE_API_URL;
    else process.env.KDBSCOPE_API_URL = savedLegacy;
  });

  it('returns http://127.0.0.1:8710 when /api/health answers ok, without ever consulting the resolver', async () => {
    delete process.env.ATLAS_API_URL;
    delete process.env.KDBSCOPE_API_URL;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('127.0.0.1:8710/api/health');
      return { ok: true } as Response;
    });

    const result = await computeBaseUrl({
      machinesFile: join(tmpdir(), 'never-read.yaml'),
      cachePath: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBe('http://127.0.0.1:8710');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a non-ok health response falls through rather than trusting it', async () => {
    delete process.env.ATLAS_API_URL;
    delete process.env.KDBSCOPE_API_URL;
    const machinesFile = writeMachinesFile(ONE_MACHINE_YAML);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('127.0.0.1:8710/api/health')) return { ok: false } as Response;
      if (url.includes('192.168.1.20')) {
        const u = new URL(url);
        const nonce = u.searchParams.get('nonce')!;
        return {
          ok: true,
          json: async () => ({ machine: 'nasta-mbp', bootId: randomUUID(), state: 'active', entries: 3 }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await computeBaseUrl({
      machinesFile,
      credentialsPath: noCredentials(),
      cachePath: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });

    expect(result).toBe('http://192.168.1.20:8710');
  });
});

describe('computeBaseUrl — fallthrough to the resolver', () => {
  const savedAtlas = process.env.ATLAS_API_URL;
  const savedLegacy = process.env.KDBSCOPE_API_URL;
  afterEach(() => {
    if (savedAtlas === undefined) delete process.env.ATLAS_API_URL;
    else process.env.ATLAS_API_URL = savedAtlas;
    if (savedLegacy === undefined) delete process.env.KDBSCOPE_API_URL;
    else process.env.KDBSCOPE_API_URL = savedLegacy;
  });

  it('an unreachable localhost falls through to resolveActive against machines.yaml', async () => {
    delete process.env.ATLAS_API_URL;
    delete process.env.KDBSCOPE_API_URL;
    const machinesFile = writeMachinesFile(ONE_MACHINE_YAML);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('127.0.0.1:8710')) throw new Error('ECONNREFUSED');
      const u = new URL(url);
      const nonce = u.searchParams.get('nonce')!;
      return {
        ok: true,
        json: async () => ({ machine: 'nasta-mbp', bootId: randomUUID(), state: 'active', entries: 7 }),
      } as unknown as Response;
    });

    const result = await computeBaseUrl({
      machinesFile,
      credentialsPath: noCredentials(),
      cachePath: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });

    expect(result).toBe('http://192.168.1.20:8710');
  });

  it('propagates AtlasResolveError when nothing is reachable anywhere', async () => {
    delete process.env.ATLAS_API_URL;
    delete process.env.KDBSCOPE_API_URL;
    const machinesFile = writeMachinesFile(ONE_MACHINE_YAML);
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      computeBaseUrl({
        machinesFile,
        credentialsPath: noCredentials(),
        cachePath: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ name: 'AtlasResolveError', kind: 'none-reachable' });
  });

  it('a configured token (read from an injected credentials path) is verified via proof against the fallthrough resolver', async () => {
    delete process.env.ATLAS_API_URL;
    delete process.env.KDBSCOPE_API_URL;
    const machinesFile = writeMachinesFile(ONE_MACHINE_YAML);
    const TOKEN = 'sekret';
    const credentialsPath = join(mkdtempSync(join(tmpdir(), 'cli-api-creds-')), 'credentials');
    writeFileSync(credentialsPath, JSON.stringify({ token: TOKEN }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('127.0.0.1:8710')) throw new Error('ECONNREFUSED');
      const u = new URL(url);
      const nonce = u.searchParams.get('nonce')!;
      const payload = { machine: 'nasta-mbp', installId: 'x', bootId: randomUUID(), state: 'active', entries: 1 };
      return { ok: true, json: async () => ({ ...payload, proof: proofFor(TOKEN, nonce, payload) }) } as unknown as Response;
    });

    const result = await computeBaseUrl({
      machinesFile,
      credentialsPath,
      cachePath: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });

    expect(result).toBe('http://192.168.1.20:8710');
  });

  it('a mismatched token (wrong proof) surfaces as AtlasResolveError token-mismatch, not a silent fallback', async () => {
    delete process.env.ATLAS_API_URL;
    delete process.env.KDBSCOPE_API_URL;
    const machinesFile = writeMachinesFile(ONE_MACHINE_YAML);
    const credentialsPath = join(mkdtempSync(join(tmpdir(), 'cli-api-creds-')), 'credentials');
    writeFileSync(credentialsPath, JSON.stringify({ token: 'wrong-token' }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('127.0.0.1:8710')) throw new Error('ECONNREFUSED');
      const u = new URL(url);
      const nonce = u.searchParams.get('nonce')!;
      const payload = { machine: 'nasta-mbp', installId: 'x', bootId: randomUUID(), state: 'active', entries: 1 };
      return { ok: true, json: async () => ({ ...payload, proof: proofFor('sekret', nonce, payload) }) } as unknown as Response;
    });

    await expect(
      computeBaseUrl({
        machinesFile,
        credentialsPath,
        cachePath: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ name: 'AtlasResolveError', kind: 'token-mismatch' });
  });
});
