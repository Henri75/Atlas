import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConfig } from '@kdbscope/core';
import { TOOLS } from './tools.js';

/**
 * Stateless streamable-HTTP MCP server. Each request gets a fresh
 * server+transport pair (no session affinity needed for these tools), which
 * plays well with `claude mcp add --transport http`.
 */

const cfg = getConfig();

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'kdbscope', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: any) => {
        const { path, init } = tool.request(args ?? {});
        const res = await fetch(`${cfg.apiUrl}${path}`, init);
        const text = await res.text();
        if (!res.ok) {
          return {
            content: [{ type: 'text' as const, text: `API error ${res.status}: ${text.slice(0, 500)}` }],
            isError: true,
          };
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
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'kdbscope-mcp' }));
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
