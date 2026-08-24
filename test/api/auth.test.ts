import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { authorize, isLoopbackAddress } from '@atlas/core';
import { authMiddleware } from '../../packages/api/src/auth.js';

/**
 * The bearer-token pass/401 decision (spec §7). `authorize()` is a pure
 * function over `{ path, peer, header }` — see packages/core/src/auth.ts for
 * why: `getConnInfo` (the real socket-peer lookup) needs a Node listener
 * Hono's `app.request()` test client doesn't provide (confirmed empirically —
 * it throws reading `c.env`), so the loopback rule is proven here directly
 * rather than through a live socket.
 */
describe('authorize()', () => {
  const opts = { token: 'sekret', exempt: ['/api/health', '/api/instance'] };

  it('no token configured → everything passes, no matter the peer or path', () => {
    expect(
      authorize({ path: '/api/search', peer: '192.168.1.9' }, { token: undefined, exempt: [] }),
    ).toBe('pass');
  });

  it('exempt paths pass without a header', () => {
    expect(authorize({ path: '/api/health', peer: '192.168.1.9' }, opts)).toBe('pass');
    expect(authorize({ path: '/api/instance', peer: '192.168.1.9' }, opts)).toBe('pass');
  });

  it('a non-exempt path from a LAN peer still needs a header even with no header given', () => {
    expect(authorize({ path: '/api/search', peer: '192.168.1.9' }, opts)).toBe(401);
  });

  it('loopback peer passes on a non-exempt path with no header at all (socket address only)', () => {
    expect(authorize({ path: '/api/search', peer: '127.0.0.1' }, opts)).toBe('pass');
  });

  it('LAN peer: no header → 401, wrong header → 401, right header → pass', () => {
    expect(authorize({ path: '/api/search', peer: '192.168.1.9' }, opts)).toBe(401);
    expect(
      authorize({ path: '/api/search', peer: '192.168.1.9', header: 'Bearer nope' }, opts),
    ).toBe(401);
    expect(
      authorize({ path: '/api/search', peer: '192.168.1.9', header: 'Bearer sekret' }, opts),
    ).toBe('pass');
  });

  it('rejects a malformed Authorization header (wrong scheme, or bare token with no scheme)', () => {
    expect(
      authorize({ path: '/api/search', peer: '192.168.1.9', header: 'Basic sekret' }, opts),
    ).toBe(401);
    expect(authorize({ path: '/api/search', peer: '192.168.1.9', header: 'sekret' }, opts)).toBe(
      401,
    );
  });

  it('a right-length-but-wrong token is rejected, not crashed on (timing-safe compare guard)', () => {
    expect(
      authorize({ path: '/api/search', peer: '192.168.1.9', header: 'Bearer xxxxxx' }, opts),
    ).toBe(401);
  });

  it('a token of the wrong LENGTH is rejected, not thrown on', () => {
    // node:crypto's timingSafeEqual throws on mismatched buffer lengths —
    // this is the length guard the interface calls for.
    expect(() =>
      authorize({ path: '/api/search', peer: '192.168.1.9', header: 'Bearer short' }, opts),
    ).not.toThrow();
    expect(
      authorize({ path: '/api/search', peer: '192.168.1.9', header: 'Bearer short' }, opts),
    ).toBe(401);
    expect(() =>
      authorize(
        { path: '/api/search', peer: '192.168.1.9', header: 'Bearer way-longer-than-sekret' },
        opts,
      ),
    ).not.toThrow();
  });

  it('an undefined peer (no real socket) is treated as non-loopback, not as loopback', () => {
    expect(authorize({ path: '/api/search', peer: undefined }, opts)).toBe(401);
  });
});

describe('isLoopbackAddress()', () => {
  it('accepts every form of loopback the spec names', () => {
    for (const addr of ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1', '::ffff:127.9.9.9']) {
      expect(isLoopbackAddress(addr)).toBe(true);
    }
  });

  it('rejects LAN and public addresses, including near-miss IPv6-mapped ones', () => {
    for (const addr of ['192.168.1.9', '10.0.0.5', '8.8.8.8', '::ffff:10.0.0.5', undefined, '']) {
      expect(isLoopbackAddress(addr)).toBe(false);
    }
  });
});

/**
 * `authMiddleware` (packages/api/src/auth.ts) is a thin Hono wrapper around
 * `authorize()`. `getConnInfo` throws under `app.request()` (no real socket),
 * which the middleware catches and treats as an undefined — i.e. non-loopback
 * — peer. That happens to make every case EXCEPT "loopback passes" exercisable
 * end to end here, proving the wrapper's own plumbing (header extraction, the
 * 401 JSON shape, calling `next()`) rather than just the pure function.
 */
describe('authMiddleware (wiring)', () => {
  const buildTestApp = (opts: Parameters<typeof authMiddleware>[0]) => {
    const app = new Hono();
    app.use('*', authMiddleware(opts));
    app.get('/api/search', (c) => c.json({ ok: true }));
    app.get('/api/health', (c) => c.json({ ok: true }));
    return app;
  };

  it('no token configured → passes through untouched (legacy mode)', async () => {
    const app = buildTestApp({ token: undefined, exempt: [] });
    const res = await app.request('/api/search');
    expect(res.status).toBe(200);
  });

  it('exempt path passes with no header', async () => {
    const app = buildTestApp({ token: 'sekret', exempt: ['/api/health'] });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('non-exempt path with no header → 401 { error: "unauthorized" }', async () => {
    const app = buildTestApp({ token: 'sekret', exempt: ['/api/health'] });
    const res = await app.request('/api/search');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('wrong bearer token → 401; right bearer token → 200', async () => {
    const app = buildTestApp({ token: 'sekret', exempt: [] });
    const wrong = await app.request('/api/search', { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    const right = await app.request('/api/search', {
      headers: { authorization: 'Bearer sekret' },
    });
    expect(right.status).toBe(200);
  });

  /**
   * Anti-spoof pin, and the mutation-verification target for this task: a
   * caller cannot claim loopback via a header. Proven by temporarily editing
   * `authMiddleware` to trust `X-Forwarded-For` for `peer` instead of
   * `getConnInfo` — with that mutation in place this test flips from 401 to
   * 200 (the spoofed header would be treated as loopback and skip the bearer
   * check entirely), i.e. it fails exactly the way a real spoofable bypass
   * would be caught. Restored immediately after; see task-21-report.md for
   * the captured before/after output.
   */
  it('a spoofed X-Forwarded-For claiming loopback does NOT bypass auth', async () => {
    const app = buildTestApp({ token: 'sekret', exempt: [] });
    const res = await app.request('/api/search', {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(res.status).toBe(401);
  });
});
