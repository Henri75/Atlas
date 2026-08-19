#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AtlasResolveError, invalidateOnConflictHeader, resolveActive } from '@atlas/core';
import { errorResult, unavailableTool, withUpstream } from './bridge.js';

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
 * `config/machines.yaml`, resolved relative to THIS file's own location —
 * this package is npm-linked from the checkout (`bin` -> `dist/main.js`), so
 * `import.meta.url` always points inside it regardless of cwd. Same
 * convention as `packages/cli/src/main.ts`'s `machinesFilePath()`.
 * `ATLAS_MACHINES_FILE` overrides, matching the CLI and `resolveActive`'s
 * other callers.
 */
function machinesFilePath(): string {
  if (process.env.ATLAS_MACHINES_FILE) return process.env.ATLAS_MACHINES_FILE;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return join(repoRoot, 'config', 'machines.yaml');
}

const CREDENTIALS_PATH = join(homedir(), '.atlas', 'credentials');

/**
 * `~/.atlas/credentials` — JSON `{ token }`, written by `atlas connect
 * --token <t>` (Task 26). Absent file, unreadable JSON, or a missing/empty
 * `token` field all mean the same thing: no token configured (legacy/dev
 * mode) — never invented, never fatal.
 */
function readToken(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The most recent upstream HTTP response's headers, captured as a side
 * channel (see the long comment on `checkConflict` below for why this is
 * the only way to get at them without reaching into SDK internals). Reset
 * implicitly on every request the transport makes.
 */
let lastResponseHeaders: Headers | undefined;

async function headerCapturingFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  lastResponseHeaders = res.headers;
  return res;
}

/**
 * Resolves the active instance and opens a fresh `Client` connection to it.
 * This is `deps.connect` for `withUpstream` (bridge.ts) — called once per
 * successful connection, and again on the one retry after a failure, never
 * directly.
 */
async function connect(): Promise<Client> {
  const token = readToken();
  const resolved = await resolveActive({ machinesFile: machinesFilePath(), token });
  const client = new Client({ name: 'atlas-connect', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resolved.mcpUrl), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    fetch: headerCapturingFetch,
  });
  await client.connect(transport);
  return client;
}

/**
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
 * requests." `headerCapturingFetch` above uses it to record the most recent
 * response's headers as a side channel, and this function feeds that into
 * `invalidateOnConflictHeader` after every `tools/list`/`tools/call` round
 * trip. Two honest limitations of this approach, worth flagging rather than
 * hiding: (1) it only sees the LAST response of a given call — fine today,
 * since each tool request is exactly one POST, but would need revisiting if
 * the SDK starts splitting a call across multiple requests; (2) if a future
 * SDK version opens a background SSE stream for server-initiated messages,
 * that stream's headers wouldn't flow through this path (`fetch` is only
 * used for direct request/response calls, not the long-lived GET stream).
 * Resolve-time conflict detection — the cache TTL, and `withUpstream`
 * re-resolving on ANY connect/call failure — is the fallback net that
 * already exists independently of whether this header capture ever fires.
 */
function checkConflict(): void {
  if (lastResponseHeaders) invalidateOnConflictHeader(lastResponseHeaders);
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
      const result = await withUpstream(upstreamDeps, (c) => c.listTools(request.params));
      checkConflict();
      return result;
    } catch (e) {
      // Visible in-band at session start (spec §8) — an MCP-level error here
      // gives Claude Code nothing useful to show the user.
      return { tools: [unavailableTool(detailOf(e))] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await withUpstream(upstreamDeps, (c) => c.callTool(request.params));
      checkConflict();
      return result;
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
