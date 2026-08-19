import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { guardTick, probePeer } from '../../packages/api/src/guard.js';
import { canonicalJson } from '../../packages/api/src/instance.js';
import type { ProbeResult } from '../../packages/api/src/guard.js';

/**
 * Independent HMAC, computed WITHOUT calling `proofFor`/`canonicalJson` —
 * same reasoning as `test/api/instance.test.ts`'s `independentProof`: a bug
 * in the module's own canonicalizer can't hide behind a test that uses the
 * same buggy function to check itself.
 */
function independentProof(token: string, nonce: string, payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  return createHmac('sha256', token)
    .update(`${nonce}\n${JSON.stringify(payload, sortedKeys)}`)
    .digest('hex');
}

/** A fake `fetch` that returns one fixed JSON body for every call, 200 OK. */
function fakeFetch(body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const MY_BOOT_ID = randomUUID();
const PEER_BOOT_ID = randomUUID();
const TOKEN = 'sekret';

/** Build a proof-valid `/api/instance` body the way the real route would. */
function peerBody(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    machine: 'peer-machine',
    installId: 'install-xyz',
    bootId: PEER_BOOT_ID,
    state: 'active',
    entries: 7,
    ...overrides,
  };
  // Proof is computed over whatever nonce the caller sends; since probePeer
  // generates its own random nonce, a fixed fake fetch can't precompute a
  // valid proof against it directly — so fakeProbeFetch below reads the
  // nonce out of the request URL instead.
  return base;
}

/** A fake `fetch` that reads `?nonce=` off the URL and signs a real proof for it. */
function fakeProbeFetch(token: string, body: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const nonce = url.searchParams.get('nonce')!;
    const proof = createHmac('sha256', token)
      .update(`${nonce}\n${canonicalJson(body)}`)
      .digest('hex');
    return {
      ok: true,
      json: async () => ({ ...body, proof }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('probePeer', () => {
  it('valid proof → ok:true with machine/bootId/state', async () => {
    const body = peerBody();
    const result = await probePeer('http://peer:8710/api/instance', TOKEN, fakeProbeFetch(TOKEN, body));
    expect(result).toEqual({ ok: true, machine: 'peer-machine', bootId: PEER_BOOT_ID, state: 'active' });
  });

  it('tampered payload (proof no longer matches) → bad-proof', async () => {
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const nonce = url.searchParams.get('nonce')!;
      const body = peerBody();
      // Sign over the real body, then ship a DIFFERENT body — the proof no
      // longer covers what's actually in the response.
      const proof = createHmac('sha256', TOKEN).update(`${nonce}\n${canonicalJson(body)}`).digest('hex');
      return {
        ok: true,
        json: async () => ({ ...body, state: 'conflicted', proof }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await probePeer('http://peer:8710/api/instance', TOKEN, fetchImpl);
    expect(result).toEqual({ ok: false, reason: 'bad-proof' });
  });

  it('missing proof field while we have a token → no-proof', async () => {
    const result = await probePeer('http://peer:8710/api/instance', TOKEN, fakeFetch(peerBody()));
    expect(result).toEqual({ ok: false, reason: 'no-proof' });
  });

  it('network throw → unreachable', async () => {
    const throwing: typeof fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probePeer('http://peer:8710/api/instance', TOKEN, throwing);
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('timeout (abort fires before the fetch resolves) → unreachable', async () => {
    const hanging: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const result = await probePeer('http://peer:8710/api/instance', TOKEN, hanging, 20);
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('no token configured (legacy dev mode) → any well-shaped 200 is ok, no proof check', async () => {
    const result = await probePeer('http://peer:8710/api/instance', undefined, fakeFetch(peerBody()));
    expect(result).toEqual({ ok: true, machine: 'peer-machine', bootId: PEER_BOOT_ID, state: 'active' });
  });

  it('non-ok HTTP status → unreachable', async () => {
    const notOk: typeof fetch = (async () => ({ ok: false, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const result = await probePeer('http://peer:8710/api/instance', TOKEN, notOk);
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('guardTick', () => {
  it('one live valid peer (different bootId) → onConflict([name])', async () => {
    const onConflict = vi.fn();
    const warn = vi.fn();
    const probe = vi.fn(
      async (): Promise<ProbeResult> => ({ ok: true, machine: 'mac-mini', bootId: PEER_BOOT_ID, state: 'active' }),
    );

    await guardTick({
      self: 'nasta-mbp',
      bootId: MY_BOOT_ID,
      peers: [{ name: 'mac-mini', url: 'http://mac-mini:8710/api/instance' }],
      token: TOKEN,
      onConflict,
      warn,
      probe,
    });

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith(['mac-mini']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('hairpin — peer answers with MY bootId → no conflict', async () => {
    const onConflict = vi.fn();
    const probe = vi.fn(
      async (): Promise<ProbeResult> => ({ ok: true, machine: 'nasta-mbp', bootId: MY_BOOT_ID, state: 'active' }),
    );

    await guardTick({
      self: 'nasta-mbp',
      bootId: MY_BOOT_ID,
      peers: [{ name: 'nasta-mbp-stale-dns', url: 'http://stale:8710/api/instance' }],
      token: TOKEN,
      onConflict,
      probe,
    });

    expect(onConflict).not.toHaveBeenCalled();
  });

  it('bad proof → no conflict, warn contains "token mismatch on <name>"', async () => {
    const onConflict = vi.fn();
    const warn = vi.fn();
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: false, reason: 'bad-proof' }));

    await guardTick({
      self: 'nasta-mbp',
      bootId: MY_BOOT_ID,
      peers: [{ name: 'mac-mini', url: 'http://mac-mini:8710/api/instance' }],
      token: TOKEN,
      onConflict,
      warn,
      probe,
    });

    expect(onConflict).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('token mismatch on mac-mini');
  });

  it('all unreachable → neither onConflict nor warn', async () => {
    const onConflict = vi.fn();
    const warn = vi.fn();
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: false, reason: 'unreachable' }));

    await guardTick({
      self: 'nasta-mbp',
      bootId: MY_BOOT_ID,
      peers: [
        { name: 'mac-mini', url: 'http://mac-mini:8710/api/instance' },
        { name: 'mac-studio', url: 'http://mac-studio:8710/api/instance' },
      ],
      token: TOKEN,
      onConflict,
      warn,
      probe,
    });

    expect(onConflict).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('mixed tick: one live peer + one bad-proof peer → conflict on the live one only, one warn', async () => {
    const onConflict = vi.fn();
    const warn = vi.fn();
    const probe = vi.fn(async (url: string): Promise<ProbeResult> => {
      if (url.includes('mac-mini')) return { ok: true, machine: 'mac-mini', bootId: PEER_BOOT_ID, state: 'active' };
      return { ok: false, reason: 'bad-proof' };
    });

    await guardTick({
      self: 'nasta-mbp',
      bootId: MY_BOOT_ID,
      peers: [
        { name: 'mac-mini', url: 'http://mac-mini:8710/api/instance' },
        { name: 'mac-studio', url: 'http://mac-studio:8710/api/instance' },
      ],
      token: TOKEN,
      onConflict,
      warn,
      probe,
    });

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith(['mac-mini']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('token mismatch on mac-studio');
  });

  it('no-proof (missing proof, configured peer) → treated as a proof failure too: no conflict, warns', async () => {
    const onConflict = vi.fn();
    const warn = vi.fn();
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: false, reason: 'no-proof' }));

    await guardTick({
      self: 'nasta-mbp',
      bootId: MY_BOOT_ID,
      peers: [{ name: 'mac-mini', url: 'http://mac-mini:8710/api/instance' }],
      token: TOKEN,
      onConflict,
      warn,
      probe,
    });

    expect(onConflict).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('token mismatch on mac-mini');
  });

  it('no peers configured → probe never called, onConflict never called', async () => {
    const onConflict = vi.fn();
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: false, reason: 'unreachable' }));

    await guardTick({ self: 'nasta-mbp', bootId: MY_BOOT_ID, peers: [], token: TOKEN, onConflict, probe });

    expect(probe).not.toHaveBeenCalled();
    expect(onConflict).not.toHaveBeenCalled();
  });

  it('default probe (no override) falls through to the real probePeer — smoke test', async () => {
    const onConflict = vi.fn();
    // guardTick's default `probe` must be `probePeer` itself, called with
    // (url, token) — a peer that is simply unreachable (bad host) resolves
    // to 'unreachable' via probePeer's own try/catch, not a thrown rejection.
    await guardTick({
      self: 'nasta-mbp',
      bootId: MY_BOOT_ID,
      peers: [{ name: 'nowhere', url: 'http://127.0.0.1:1/api/instance' }],
      token: TOKEN,
      onConflict,
    });
    expect(onConflict).not.toHaveBeenCalled();
  }, 3000);
});
