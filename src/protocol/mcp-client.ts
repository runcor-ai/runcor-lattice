// MCP client — connects to a peer lattice's MCP server and exposes a Lattice-shaped
// interface (MemoryBridge, sendMessage). The protocol adapter uses this when a
// `LatticeProtocolConfig.subscriptions[i].endpoint` is configured.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LatticeMessage, MemoryBridge } from './index.js';

export interface PeerEndpoint {
  /** Identifier the peer published as. */
  latticeId: string;
  /** HTTP URL (e.g. http://localhost:7301/mcp) or null when paired in-process. */
  url?: string;
}

export interface PeerClient {
  bridge: MemoryBridge;
  send(msg: Omit<LatticeMessage, 'ts'>): Promise<boolean>;
  recentTrace(n?: number): Promise<unknown[]>;
  close(): Promise<void>;
}

interface ClientOptions {
  endpoint: PeerEndpoint;
  /** When provided, used instead of an HTTP transport (for tests + same-process Bridge). */
  inProcessTransport?: InMemoryTransport;
}

export async function connectPeer(opts: ClientOptions): Promise<PeerClient> {
  const client = new Client({ name: 'runcor-lattice-client', version: '0.0.1' });

  if (opts.inProcessTransport) {
    await client.connect(opts.inProcessTransport);
  } else {
    if (!opts.endpoint.url) throw new Error('connectPeer: either inProcessTransport or endpoint.url is required');
    const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint.url));
    // Cast around exactOptionalPropertyTypes mismatch: SDK transports declare optional
    // callbacks but the Transport interface expects them as required. Functionally fine.
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  }

  return {
    bridge: {
      async search(query: string, k = 5) {
        const result = await client.callTool({ name: 'memory.search', arguments: { query, k } });
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{"results":[]}';
        const parsed = JSON.parse(text) as { results: Array<{ content: string; M: number; cube: 'short' | 'long' }> };
        return parsed.results.map((r) => ({ content: r.content, M: r.M, cube: r.cube }));
      },
    },
    async send(msg) {
      const result = await client.callTool({ name: 'inbox.send', arguments: { from: msg.from, text: msg.text } });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{"delivered":false}';
      return (JSON.parse(text) as { delivered: boolean }).delivered;
    },
    async recentTrace(n = 10) {
      const result = await client.callTool({ name: 'trace.recent', arguments: { n } });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{"entries":[]}';
      return (JSON.parse(text) as { entries: unknown[] }).entries;
    },
    async close() {
      await client.close();
    },
  };
}
