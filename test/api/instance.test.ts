import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../packages/api/src/app.js';
import type { ApiDeps } from '../../packages/api/src/app.js';
import {
  bootId,
  canonicalJson,
  conflictPeers,
  getState,
  proofFor,
  setConflicted,
} from '../../packages/api/src/instance.js';

/**
 * `/api/instance` (route) touches only `deps.instance()` and
 * `deps.atlasToken`; the header middleware (mounted on every `/api/*`
 * route) touches `deps.machines()`. Everything else here is inert filler so
 * `buildApp` type-checks — same `as any` convention routes.test.ts uses for
 * fields a given test file never exercises.
 */
function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    // The usage-telemetry middleware (app.ts) calls `recordCall` on EVERY
    // `/api/*` request, fire-and-forget — a bare `{}` throws synchronously
    // (`.recordCall is not a function`), which the middleware doesn't catch
    // until the promise settles, so it surfaces as a 500 on every request.
    catalog: { recordCall: async () => {} } as any,
    search: {} as any,
    ask: {} as any,
    enqueueScan: async () => 0,
    triggerSync: async () => {},
    enqueueAdoption: async () => 0,
    vectorCount: async () => 0,
    meta: () => ({ embedder: 'none', collection: 'none' }),
    queueCounts: async () => null,
    pathMappings: [],
    storage: async () => ({
      postgresBytes: 0,
      qdrantBytes: 0,
      redisMemoryBytes: 0,
      collections: [],
    }),
    health: async () => ({}),
    vectorStats: async () => null,
    embeddingsProvider: 'auto',
    servingEmbedder: () => null,
    backlogReview: {} as any,
    backlogMatchThreshold: 0.5,
    usagePageSize: 50,
    machines: () => ({ fleet: null, self: 'test-machine' }),
    listMachineSync: async () => [],
    listProjectLocations: async () => new Map(),
    instance: async () => ({ machine: 'test-machine', installId: 'install-abc', entries: 42 }),
    ...overrides,
  };
}

const NONCE = 'a1b2c3d4';
const NONCE_2 = 'b2c3d4e5';

/**
 * An HMAC computed WITHOUT calling `proofFor`/`canonicalJson` — the
 * independent check the brief calls for, so a bug in the module's own
 * canonicalizer can't hide behind a test that uses the same buggy function
 * to check itself. `JSON.stringify`'s replacer-array form both filters AND
 * reorders top-level keys to match the array given it, so sorting the
 * payload's own keys and handing that array in reproduces "sorted-key JSON"
 * via a completely different code path than `canonicalJson`'s recursive
 * string-building. The `/api/instance` payload is flat (no nested objects),
 * so a top-level sort is a faithful independent reimplementation here.
 */
function independentProof(token: string, nonce: string, payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  return createHmac('sha256', token)
    .update(`${nonce}\n${JSON.stringify(payload, sortedKeys)}`)
    .digest('hex');
}

describe('GET /api/instance — nonce validation (spec §8: 400 on missing/malformed)', () => {
  const app = buildApp(makeDeps({ atlasToken: 'sekret' }));

  it('rejects a missing nonce', async () => {
    const res = await app.request('/api/instance');
    expect(res.status).toBe(400);
  });

  it('rejects an empty nonce', async () => {
    const res = await app.request('/api/instance?nonce=');
    expect(res.status).toBe(400);
  });

  it('rejects a too-short nonce ("zz")', async () => {
    const res = await app.request('/api/instance?nonce=zz');
    expect(res.status).toBe(400);
  });

  it('rejects a 7-char nonce (one under the 8-char floor)', async () => {
    const res = await app.request(`/api/instance?nonce=${'a'.repeat(7)}`);
    expect(res.status).toBe(400);
  });

  it('rejects a 65-char nonce (one over the 64-char ceiling)', async () => {
    const res = await app.request(`/api/instance?nonce=${'a'.repeat(65)}`);
    expect(res.status).toBe(400);
  });

  it('rejects a 100-char nonce', async () => {
    const res = await app.request(`/api/instance?nonce=${'a'.repeat(100)}`);
    expect(res.status).toBe(400);
  });

  it('rejects a right-length but non-hex nonce', async () => {
    const res = await app.request(`/api/instance?nonce=${'g'.repeat(8)}`);
    expect(res.status).toBe(400);
  });

  it('accepts an 8-char hex nonce (the floor)', async () => {
    const res = await app.request(`/api/instance?nonce=${'a'.repeat(8)}`);
    expect(res.status).toBe(200);
  });

  it('accepts a 64-char hex nonce (the ceiling)', async () => {
    const res = await app.request(`/api/instance?nonce=${'a'.repeat(64)}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/instance — payload + proof', () => {
  it('returns machine/installId/bootId/state/entries, defaulting to active', async () => {
    const app = buildApp(makeDeps({ atlasToken: undefined }));
    const res = await app.request(`/api/instance?nonce=${NONCE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      machine: 'test-machine',
      installId: 'install-abc',
      entries: 42,
      state: 'active',
    });
    expect(body.bootId).toBe(bootId);
  });

  it('no-token mode omits proof entirely — key absent, not null', async () => {
    const app = buildApp(makeDeps({ atlasToken: undefined }));
    const res = await app.request(`/api/instance?nonce=${NONCE}`);
    const body = await res.json();
    expect('proof' in body).toBe(false);
  });

  it('proof verifies against an independently computed HMAC, not by calling proofFor', async () => {
    const app = buildApp(makeDeps({ atlasToken: 'sekret' }));
    const res = await app.request(`/api/instance?nonce=${NONCE}`);
    const body = await res.json();
    expect(typeof body.proof).toBe('string');
    const { proof, ...payload } = body;
    expect(proof).toBe(independentProof('sekret', NONCE, payload));
  });

  it('a different nonce (same payload) yields a different proof — replay is inert', async () => {
    const app = buildApp(makeDeps({ atlasToken: 'sekret' }));
    const r1 = await (await app.request(`/api/instance?nonce=${NONCE}`)).json();
    const r2 = await (await app.request(`/api/instance?nonce=${NONCE_2}`)).json();
    expect(r1.proof).not.toBe(r2.proof);
  });

  it('a wrong token produces a different proof than the right one', async () => {
    const right = buildApp(makeDeps({ atlasToken: 'sekret' }));
    const wrong = buildApp(makeDeps({ atlasToken: 'not-sekret' }));
    const rBody = await (await right.request(`/api/instance?nonce=${NONCE}`)).json();
    const wBody = await (await wrong.request(`/api/instance?nonce=${NONCE}`)).json();
    expect(rBody.proof).not.toBe(wBody.proof);
  });

  /**
   * Self-review pin: the proof must cover the WHOLE payload, not a signed
   * subset — a tampered `state` or `machine` (the two fields a rogue
   * listener or a hairpin would most want to fake) must invalidate it.
   */
  it('a tampered state or machine invalidates the proof — full-payload coverage', async () => {
    const app = buildApp(makeDeps({ atlasToken: 'sekret' }));
    const body = await (await app.request(`/api/instance?nonce=${NONCE}`)).json();

    const tamperedState = { ...body, state: 'conflicted' };
    delete tamperedState.proof;
    expect(independentProof('sekret', NONCE, tamperedState)).not.toBe(body.proof);

    const tamperedMachine = { ...body, machine: 'rogue-listener' };
    delete tamperedMachine.proof;
    expect(independentProof('sekret', NONCE, tamperedMachine)).not.toBe(body.proof);

    const tamperedEntries = { ...body, entries: body.entries + 1 };
    delete tamperedEntries.proof;
    expect(independentProof('sekret', NONCE, tamperedEntries)).not.toBe(body.proof);
  });
});

describe('canonicalJson / proofFor stability', () => {
  it('identical data in a different key order produces an identical proof', () => {
    const a = { machine: 'm', installId: 'i', bootId: 'b', state: 'active', entries: 5 };
    const b = { entries: 5, state: 'active', bootId: 'b', installId: 'i', machine: 'm' };
    expect(proofFor('tok', NONCE, a)).toBe(proofFor('tok', NONCE, b));
  });

  it('sorts nested object keys recursively too', () => {
    expect(canonicalJson({ b: 1, a: { z: 1, y: 2 } })).toBe(canonicalJson({ a: { y: 2, z: 1 }, b: 1 }));
  });

  it('a changed VALUE still changes the canonical form (order isn\'t the only thing signed)', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('X-Atlas-Machine / X-Atlas-State headers (default state)', () => {
  it('GET /api/instance carries X-Atlas-State: active and X-Atlas-Machine by default', async () => {
    const app = buildApp(makeDeps());
    const res = await app.request(`/api/instance?nonce=${NONCE}`);
    expect(res.headers.get('X-Atlas-State')).toBe('active');
    expect(res.headers.get('X-Atlas-Machine')).toBe('test-machine');
  });

  it('a 400 (malformed nonce) still carries the headers', async () => {
    const app = buildApp(makeDeps());
    const res = await app.request('/api/instance?nonce=zz');
    expect(res.status).toBe(400);
    expect(res.headers.get('X-Atlas-State')).toBe('active');
    expect(res.headers.get('X-Atlas-Machine')).toBe('test-machine');
  });
});

/**
 * MUST run last in this file. `setConflicted` mutates instance.ts's
 * module-level singleton state, and the spec makes that deliberately
 * one-way (no `clearConflict` — recovery is a fresh process, not a runtime
 * reset) — every test above this block depends on the default 'active'
 * state, which this block permanently ends for the rest of the file.
 */
describe('setConflicted — flips state for the rest of the process (module-level singleton)', () => {
  it('flips getState()/conflictPeers(), the response payload, and the header', async () => {
    expect(getState()).toBe('active'); // sanity: nothing above this block touched it
    setConflicted(['mac-mini']);
    expect(getState()).toBe('conflicted');
    expect(conflictPeers()).toEqual(['mac-mini']);

    const app = buildApp(makeDeps());
    const res = await app.request(`/api/instance?nonce=${NONCE}`);
    const body = await res.json();
    expect(body.state).toBe('conflicted');
    expect(res.headers.get('X-Atlas-State')).toBe('conflicted');
  });
});
