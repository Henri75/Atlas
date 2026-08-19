import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authorize, getConfig } from '@atlas/core';
import { mergeToolResponse, SERVER_INSTRUCTIONS, TOOLS } from './tools.js';

/**
 * Stateless streamable-HTTP MCP server. Each request gets a fresh
 * server+transport pair (no session affinity needed for these tools), which
 * plays well with `claude mcp add --transport http`.
 */

const cfg = getConfig();

// Fail closed (spec §7): a non-loopback bind with no token would serve the
// LAN with no auth at all. Refuse to boot rather than do that silently.
if (cfg.atlasBind !== '127.0.0.1' && !cfg.atlasToken) {
  console.error(
    `[mcp] REFUSING TO START — ATLAS_BIND=${cfg.atlasBind} with no ATLAS_TOKEN set. ` +
      'Set ATLAS_TOKEN or leave ATLAS_BIND at 127.0.0.1.',
  );
  process.exit(1);
}

function buildMcpServer(): McpServer {
  // `instructions` reach the client at initialize time — this is the only
  // channel for cross-tool guidance (beta caveats, scoping pitfalls); the
  // per-tool descriptions can't carry it.
  const server = new McpServer(
    { name: 'atlas', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: any) => {
        const { path, init } = tool.request(args ?? {});
        // Identify agent traffic so the API's usage telemetry can tell which
        // tool was called; unlabeled requests (the UI) are not recorded.
        const res = await fetch(`${cfg.apiUrl}${path}`, {
          ...init,
          headers: { ...init?.headers, 'x-atlas-client': 'mcp', 'x-atlas-tool': tool.name },
        });
        let text = await res.text();
        if (!res.ok) {
          return {
            content: [{ type: 'text' as const, text: `API error ${res.status}: ${text.slice(0, 500)}` }],
            isError: true,
          };
        }
        // A second REST call folded into the same tool answer (atlas_status +
        // /api/machines) — see mergeToolResponse for the merge/degrade rules;
        // this stays plumbing (fetch, call the helper, return).
        if (tool.merge) {
          const { key, path: mergePath, init: mergeInit } = tool.merge(args ?? {});
          let secondary: { ok: boolean; text: string };
          try {
            const mergeRes = await fetch(`${cfg.apiUrl}${mergePath}`, {
              ...mergeInit,
              headers: { ...mergeInit?.headers, 'x-atlas-client': 'mcp', 'x-atlas-tool': tool.name },
            });
            secondary = { ok: mergeRes.ok, text: await mergeRes.text() };
          } catch {
            secondary = { ok: false, text: '' };
          }
          text = mergeToolResponse(text, key, secondary);
        }
        return { content: [{ type: 'text' as const, text }] };
      },
    );
  }
  return server;
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

const httpServer = createServer(async (req, res) => {
  /**
   * Bearer-token gate (spec §7): `authorize()` from `@atlas/core`, the same
   * pure decision the api server's Hono middleware wraps
   * (packages/api/src/auth.ts) — sharing the decision itself, not just its
   * shape, so the loopback/exempt/compare rules can never drift between the
   * two servers. Peer address ONLY, from the raw socket — never a header
   * (nginx sets no X-Forwarded-For; trusting one would be a spoofable bypass).
   */
  const path = (req.url ?? '').split('?')[0] ?? '';
  const rawAuth = req.headers.authorization;
  const verdict = authorize(
    { path, peer: req.socket.remoteAddress, header: Array.isArray(rawAuth) ? rawAuth[0] : rawAuth },
    { token: cfg.atlasToken, exempt: ['/health'] },
  );
  if (verdict === 401) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'atlas-mcp' }));
    return;
  }
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  } catch (e) {
    console.error('[mcp] request failed:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  }
});

httpServer.listen(cfg.mcpPort, '0.0.0.0', () => {
  console.log(`[mcp] streamable HTTP on :${cfg.mcpPort}/mcp (${TOOLS.length} tools)`);
});
