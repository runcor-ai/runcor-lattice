// MCP server — exposes a lattice's protocol surface as MCP tools so other lattices
// can call them across processes.
//
// Tools exposed (per operator's MCP-as-coordination decision, captured in memory):
//   memory.search(query, k?)       — read-only peer memory recall
//   inbox.send(from, text)         — push a message into this lattice's inbox
//   trace.recent(n?)               — return the last n trace entries from the published stream
//
// Transports:
//   - InMemoryTransport: same-process MCP — useful for tests + the Bridge in-the-loop
//   - StreamableHTTPServerTransport: cross-process — what the Bridge uses to discover and
//     observe deployed lattices
//
// The cycle's protocol adapter calls this when LatticeProtocolConfig.publish.endpoint is set.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Memory } from '../memory/index.js';
import type { Trace } from '../trace/index.js';
import type { LatticeMessage } from './index.js';

export interface LatticeMcpServerOptions {
  latticeId: string;
  memory: Memory;
  trace: Trace;
  /** Append a message to the lattice's inbox; cycle drains via drainInbox(). */
  enqueueMessage: (msg: LatticeMessage) => void;
}

export interface LatticeMcpServer {
  /** The underlying McpServer instance. Tools registered when constructed. */
  server: McpServer;
  /** Start an HTTP transport on the given port. Returns the running http.Server. */
  listen(port: number): Promise<HttpServer>;
  /** Connect to an InMemoryTransport pair (returns the client-side transport). */
  pairInProcess(): Promise<InMemoryTransport>;
  /** Stop the HTTP transport if running. */
  close(): Promise<void>;
}

export function createLatticeMcpServer(opts: LatticeMcpServerOptions): LatticeMcpServer {
  const server = new McpServer({
    name: `runcor-lattice/${opts.latticeId}`,
    version: '0.0.1',
  });

  // memory.search — read-only peer memory recall
  server.tool(
    'memory.search',
    { query: z.string().describe('Semantic query against this lattice\'s memory'), k: z.number().optional().describe('Top-k results (default 5)') },
    async (args) => {
      const k = args.k ?? 5;
      if (!opts.memory.isEnabled()) {
        return { content: [{ type: 'text', text: JSON.stringify({ enabled: false, results: [] }) }] };
      }
      const results = await opts.memory.recall(String(args.query), k);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            enabled: true,
            results: results.map((r) => ({ content: r.content, M: r.M, cube: r.cube, similarity: r.similarity })),
          }),
        }],
      };
    },
  );

  // inbox.send — push a message into this lattice's inbox
  server.tool(
    'inbox.send',
    { from: z.string().describe('Sender lattice ID'), text: z.string().describe('Message body') },
    async (args) => {
      opts.enqueueMessage({ from: String(args.from), text: String(args.text), ts: Date.now() });
      return { content: [{ type: 'text', text: JSON.stringify({ delivered: true }) }] };
    },
  );

  // trace.recent — return the last N trace entries (best-effort; reads adapter snapshot)
  server.tool(
    'trace.recent',
    { n: z.number().optional().describe('Number of recent entries (default 10, max 50)') },
    async (args) => {
      const n = Math.min(50, Math.max(1, args.n ?? 10));
      // Trace adapter exposes latest() but not a backlog reader yet; for v1 we return latest only.
      const latest = opts.trace.latest();
      const entries = latest ? [latest] : [];
      void n; // documented for forward-compat; full backlog comes with trace.subscribe
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: entries.length, totalCaptured: opts.trace.count(), entries }) }],
      };
    },
  );

  let httpServer: HttpServer | null = null;
  let httpTransport: StreamableHTTPServerTransport | null = null;
  const linkedTransports: InMemoryTransport[] = [];

  return {
    server,
    async listen(port: number): Promise<HttpServer> {
      httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => `${opts.latticeId}-${Date.now().toString(36)}`,
      });
      // Cast around exactOptionalPropertyTypes mismatch — see mcp-client.ts for the same pattern.
      await server.connect(httpTransport as unknown as Parameters<typeof server.connect>[0]);
      httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
          await httpTransport!.handleRequest(req, res);
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      await new Promise<void>((resolve) => httpServer!.listen(port, resolve));
      return httpServer;
    },
    async pairInProcess(): Promise<InMemoryTransport> {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      linkedTransports.push(serverTransport);
      return clientTransport;
    },
    async close(): Promise<void> {
      if (httpServer) await new Promise<void>((res, rej) => httpServer!.close((err) => err ? rej(err) : res()));
      if (httpTransport) await httpTransport.close();
      for (const t of linkedTransports) await t.close().catch(() => {});
      httpServer = null;
      httpTransport = null;
    },
  };
}
