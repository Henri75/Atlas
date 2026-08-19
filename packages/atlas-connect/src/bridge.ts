import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

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
 * itself throwing, or `fn(upstream)` throwing — the memo is dropped so the
 * next attempt reconnects from scratch (picking up a moved instance rather
 * than retrying against the same dead client). The first failure is
 * swallowed and retried; the second is rethrown to the caller.
 */
const memoByDeps = new WeakMap<object, unknown>();

export async function withUpstream<T, C>(
  deps: { connect: () => Promise<C> },
  fn: (upstream: C) => Promise<T>,
): Promise<T> {
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
