import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { invalidateCache, invalidateOnConflictHeader } from '@atlas/core';

/**
 * Pure retry/memo/shaping logic for the atlas-connect stdio shim (spec §8).
 * No network, no filesystem, no SDK `Client`/`Server` instances — those live
 * in `main.ts`, which is why this file is trivially unit-testable with a
 * fake `connect`.
 */

/**
 * Memoizes whatever `deps.connect()` returns, keyed on the `deps` object's
 * own identity (not a module-level singleton) — so two callers each holding
 * their own `deps` never share a cached upstream, and tests can construct a
 * fresh `deps` per case with zero cross-test bleed. `main.ts` builds exactly
 * one `deps` object at module scope and reuses it for every `tools/list` and
 * `tools/call` request, which is what gives the memo its "one connection for
 * the shim's lifetime" behavior in practice.
 *
 * Retry contract (spec §8 — "re-resolves and retries once on mid-session
 * connection failure"): up to two attempts. On ANY failure — `connect()`
 * itself throwing, or `fn(upstream)` throwing — the memo is dropped AND the
 * resolver cache is invalidated, so the next attempt genuinely re-resolves
 * instead of reconnecting to the same dead host the cache still names.
 * Dropping only the memo made `connect()` run again but hand back the same
 * cached baseUrl for up to the rest of its 5-minute TTL, which is the one
 * thing "re-resolves" was supposed to prevent. The first failure is
 * swallowed and retried; the second is rethrown to the caller.
 *
 * `deps.invalidate` is injectable so a test can count the calls without a
 * real cache file; the default is the real `invalidateCache` (`@atlas/core`).
 */
const memoByDeps = new WeakMap<object, unknown>();

export async function withUpstream<T, C>(
  deps: { connect: () => Promise<C>; invalidate?: () => void },
  fn: (upstream: C) => Promise<T>,
): Promise<T> {
  const invalidate = deps.invalidate ?? (() => { invalidateCache(); });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let upstream = memoByDeps.get(deps) as C | undefined;
      if (upstream === undefined) {
        upstream = await deps.connect();
        memoByDeps.set(deps, upstream);
      }
      return await fn(upstream);
    } catch (e) {
      memoByDeps.delete(deps);
      invalidate();
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * The single tool `tools/list` returns when the upstream can't be resolved
 * or connected — visible in-band at session start instead of an opaque MCP
 * error (spec §8). `detail` is `AtlasResolveError.detail` (or an equivalent
 * connect-failure message): already human-ready, listing every host checked
 * plus a remedy line, so it's embedded verbatim rather than summarized.
 */
export function unavailableTool(detail: string): Tool {
  return {
    name: 'atlas_unavailable',
    description: `No active Atlas instance is reachable — every atlas_* tool call will fail until this is fixed.\n\n${detail}`,
    inputSchema: { type: 'object' },
  };
}

/** `tools/call`'s in-band failure shape (spec §8) when both attempts fail. */
export function errorResult(detail: string): CallToolResult {
  return { content: [{ type: 'text', text: `Atlas unreachable: ${detail}` }], isError: true };
}

/** Minimal shape `invalidateOnConflictHeader` needs — matches `Response.headers`. */
export interface HeaderLike {
  get(name: string): string | null;
}

/**
 * Wraps a `fetch` implementation (e.g. the global one, or the SDK transport's
 * own `fetch` option) so every response's headers are checked for
 * `X-Atlas-State: conflicted` (spec §8) THE INSTANT that response is in
 * hand — never stashed in a variable for some later, out-of-band check.
 *
 * That "stash it, check it later" shape is exactly what broke under
 * concurrency: the MCP SDK's `Client` can have multiple round trips in
 * flight against the same memoized connection (pipelined `tools/list`/
 * `tools/call` requests), so a shared "last response's headers" variable
 * plus a separate post-hoc check races — whichever response wrote last
 * wins, regardless of which response the caller actually cared about, and a
 * genuine `conflicted` header can get silently overwritten by an unrelated
 * clean response before anything looks at it (or the reverse: an unrelated
 * clean response gets blamed for a conflict it never signaled). Checking
 * inline, inside the same closure that holds `res`, is race-free by
 * construction — there is no shared mutable state left to race over, so it
 * doesn't matter how many calls are in flight or in what order they settle.
 *
 * `invalidate` defaults to the real `invalidateOnConflictHeader` — injectable
 * so tests can assert exactly which response each call fired for without a
 * real cache file.
 */
export function conflictCheckingFetch(
  fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>,
  cachePath?: string,
  invalidate: (headers: HeaderLike, cachePath?: string) => boolean = invalidateOnConflictHeader,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const res = await fetchImpl(url, init);
    invalidate(res.headers, cachePath);
    return res;
  };
}
