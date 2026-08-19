import type { Context, MiddlewareHandler, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { authorize, type AuthorizeOpts } from '@atlas/core';

/**
 * Bearer-token gate for the LAN-exposed API (spec §7).
 *
 * The pass/401 decision itself is `authorize()` in `@atlas/core` — a pure
 * function over `{ path, peer, header }`, shared with the MCP server's plain
 * `node:http` handler (`packages/mcp/src/main.ts`). This file is deliberately
 * thin: its only job is pulling those three inputs out of Hono/Node.
 *
 * `getConnInfo` reads the real socket via `c.env`, which only exists under
 * the actual `@hono/node-server` listener — Hono's `app.request()` test
 * client has no socket and throws reading it (confirmed empirically), so it
 * is wrapped in a try/catch rather than relied on directly. That is also why
 * the loopback rule itself is proven by `authorize()`'s own suite
 * (test/api/auth.test.ts), which can hand it a peer address straight up,
 * rather than by exercising this middleware through `app.request()`.
 *
 * Peer address ONLY, never a header: nginx sets no `X-Forwarded-For` in
 * front of this stack, so trusting one here would be a spoofable bypass.
 */
export function authMiddleware(opts: AuthorizeOpts): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    let peer: string | undefined;
    try {
      peer = getConnInfo(c).remote.address;
    } catch {
      peer = undefined;
    }
    const verdict = authorize(
      { path: new URL(c.req.url).pathname, peer, header: c.req.header('authorization') },
      opts,
    );
    if (verdict === 401) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
