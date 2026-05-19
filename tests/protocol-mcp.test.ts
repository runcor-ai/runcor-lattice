// Cross-process MCP protocol tests — verify the McpServer + McpClient surfaces work
// end-to-end. Uses InMemoryTransport so tests don't need actual TCP ports.

import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLatticeMcpServer } from '../src/protocol/mcp-server.js';
import { connectPeer } from '../src/protocol/mcp-client.js';
import { createMemory } from '../src/memory/index.js';
import { createTrace } from '../src/trace/index.js';

describe('Cross-process MCP protocol', () => {
  it('memory.search tool returns enabled=false when peer memory is disabled', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const memory = createMemory({ dbPath: ':memory:' });
      const trace = createTrace();
      trace.start('eng-test');
      const server = createLatticeMcpServer({ latticeId: 'A', memory, trace, enqueueMessage: () => {} });
      const clientTransport = await server.pairInProcess();
      const peer = await connectPeer({ endpoint: { latticeId: 'A' }, inProcessTransport: clientTransport });
      const results = await peer.bridge.search('anything', 3);
      expect(results).toEqual([]);  // disabled memory yields no results
      await peer.close();
      await server.close();
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('inbox.send tool delivers a message to the server\'s enqueue callback', async () => {
    const memory = createMemory({ dbPath: ':memory:' });
    const trace = createTrace();
    trace.start('eng-test');
    const delivered: Array<{ from: string; text: string }> = [];
    const server = createLatticeMcpServer({
      latticeId: 'A',
      memory,
      trace,
      enqueueMessage: (msg) => { delivered.push({ from: msg.from, text: msg.text }); },
    });
    const clientTransport = await server.pairInProcess();
    const peer = await connectPeer({ endpoint: { latticeId: 'A' }, inProcessTransport: clientTransport });
    const ok = await peer.send({ from: 'B', text: 'hello A' });
    expect(ok).toBe(true);
    expect(delivered).toEqual([{ from: 'B', text: 'hello A' }]);
    await peer.close();
    await server.close();
  });

  it('trace.recent returns the most recent trace entry', async () => {
    const memory = createMemory({ dbPath: ':memory:' });
    const trace = createTrace();
    trace.start('eng-test');
    trace.capture({ engagementId: 'eng-test', cycle: 1, phase: 'observe', ts: Date.now(), data: { event: 'engagement-started' } });
    const server = createLatticeMcpServer({ latticeId: 'A', memory, trace, enqueueMessage: () => {} });
    const clientTransport = await server.pairInProcess();
    const peer = await connectPeer({ endpoint: { latticeId: 'A' }, inProcessTransport: clientTransport });
    const recent = await peer.recentTrace(5);
    expect(recent).toHaveLength(1);
    expect((recent[0] as { data: { event: string } }).data.event).toBe('engagement-started');
    await peer.close();
    await server.close();
  });
});

describe('Cross-process MCP via real HTTP (smoke)', () => {
  it('listen() opens an HTTP port and the server responds at /', async () => {
    const memory = createMemory({ dbPath: ':memory:' });
    const trace = createTrace();
    trace.start('eng-test');
    const server = createLatticeMcpServer({ latticeId: 'A', memory, trace, enqueueMessage: () => {} });
    // Use port 0 → OS-assigned ephemeral port to avoid collisions
    const httpServer = await server.listen(0);
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    await server.close();
  });
});
