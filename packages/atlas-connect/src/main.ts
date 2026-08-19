#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AtlasResolveError, machinesFilePath, readToken, resolveActive } from '@atlas/core';
import { conflictCheckingFetch, errorResult, unavailableTool, withUpstream } from './bridge.js';

/**
 * `atlas-connect` — the stdio MCP shim (spec §8). Registered exactly once
 * per machine (`claude mcp add atlas -- atlas-connect`, see README.md) and
 * never touched again: everything about WHERE Atlas actually runs is
 * resolved lazily, at first tool call, via `resolveActive()` (`@atlas/core`,
 * Task 24) — moving the stack (`make down` here, `make up` there) needs zero
 * Claude Code config changes.
 *
 * Hard requirement (self-review checklist, not just a nicety): this process
 * must NEVER crash at spawn. `main()` below does no upstream I/O at all —
 * `connect()` only ever runs lazily, inside a tool-call handler, wrapped by
 * `withUpstream`'s try/catch. A dead or misconfigured Atlas fleet shows up
 * as the in-band `atlas_unavailable` tool / an `isError` tool result, never
 * a shim that fails to start.
 */

/**
 * Resolves the active instance and opens a fresh `Client` connection to it.
 * This is `deps.connect` for `withUpstream` (bridge.ts) — called once per
 * successful connection, and again on the one retry after a failure, never
 * directly.
 *
 * Every upstream response's headers SHOULD pass through
 * `invalidateOnConflictHeader` (spec §8: bounds a stale-conflicted window to
 * one request instead of one 5-minute cache TTL) — but the MCP SDK's
 * `Client`/`StreamableHTTPClientTransport` do NOT surface response headers
 * to the caller anywhere in their public API. Checked directly in
 * `node_modules/@modelcontextprotocol/sdk`: the client transport's
 * `onmessage?.(message)` calls (`client/streamableHttp.js`) pass no `extra`/
 * `MessageExtraInfo` — that parameter exists on the `Transport` interface
 * for the SERVER side, describing the INBOUND request the server received,
 * not headers on a response the client got back. Nothing else on `Client`
 * or `Transport` exposes a `Response` object. Reaching into the transport's
 * private fields to grab one would be exactly the "hack into SDK internals"
 * this task says not to do — so this does not do that.
 *
 * The one LEGITIMATE extension point the SDK exposes for this is
 * `StreamableHTTPClientTransportOptions.fetch` — a documented, public
 * constructor option: "Custom fetch implementation used for all network
 * requests." `conflictCheckingFetch` (bridge.ts) uses it to check EACH
 * response's headers inline, the instant that response is in hand — not
 * stashed in shared state for a later out-of-band check, which raced under
 * concurrent tool calls (the SDK can have multiple round trips in flight
 * against one memoized `Client`) and could silently miss a genuine conflict
 * or misattribute one to the wrong response. See `conflictCheckingFetch`'s
 * doc comment for the full story. Two honest limitations worth flagging
 * rather than hiding: (1) this only ever sees a request/response the
 * transport makes through `fetch` — fine today, since every tool call is
 * exactly one POST, but wouldn't cover a future SDK version that opens a
 * background SSE stream for server-initiated messages, whose headers never
 * flow through `fetch` at all; (2) resolve-time conflict detection — the
 * cache TTL, and `withUpstream` re-resolving on ANY connect/call failure —
 * is the fallback net that already exists independently of whether this
 * header check ever fires.
 */
async function connect(): Promise<Client> {
  const token = readToken();
  const resolved = await resolveActive({ machinesFile: machinesFilePath(), token });
  const client = new Client({ name: 'atlas-connect', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resolved.mcpUrl), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    fetch: conflictCheckingFetch(fetch),
  });
  await client.connect(transport);
  return client;
}

/** `AtlasResolveError.detail` is already the human-ready "hosts checked + remedy" text (spec §8: "no active Atlas instance; checked nasta-mbp, m4max"); any other failure (connect refused, non-Atlas responder, transport error) falls back to its own message. */
function detailOf(e: unknown): string {
  if (e instanceof AtlasResolveError) return e.detail;
  return e instanceof Error ? e.message : String(e);
}

// One `deps` object for the shim's whole lifetime — `withUpstream` (bridge.ts)
// memoizes keyed on this object's identity, so `tools/list` and `tools/call`
// share the same upstream connection until a failure drops it.
const upstreamDeps = { connect };

function buildServer(): Server {
  // The low-level `Server` (not the deprecating-toward-it `McpServer` used by
  // packages/mcp) is deliberate: this shim proxies whatever tool set the
  // UPSTREAM advertises — a dynamic list unknown at compile time — rather
  // than a fixed set registered per-tool the way `McpServer.registerTool`
  // expects.
  const server = new Server({ name: 'atlas', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      // Conflict-header checking happens inline inside `connect()`'s
      // `conflictCheckingFetch` wrapper, per response — no post-hoc check
      // needed (or safe to do, under concurrent requests) here.
      return await withUpstream(upstreamDeps, (c) => c.listTools(request.params));
    } catch (e) {
      // Visible in-band at session start (spec §8) — an MCP-level error here
      // gives Claude Code nothing useful to show the user.
      return { tools: [unavailableTool(detailOf(e))] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await withUpstream(upstreamDeps, (c) => c.callTool(request.params));
    } catch (e) {
      return errorResult(detailOf(e));
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  // The one place a crash is still possible: `StdioServerTransport` failing
  // to attach to stdio itself. Nothing upstream/Atlas-related can reach
  // here — see the module doc comment above.
  console.error('[atlas-connect] fatal:', e);
  process.exit(1);
});
