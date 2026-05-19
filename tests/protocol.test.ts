// Lattice protocol tests — verify in-process peer interaction (publishTrace,
// subscribeToTrace, bridgeMemory, sendMessage). MCP cross-process wiring is deferred;
// these tests prove the surface shape works.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createLatticeProtocol,
  instantiate,
  type LatticeConfig,
} from '../src/index.js';
import { __resetProtocolRegistry } from '../src/protocol/index.js';

function withoutKeys<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { or: process.env.OPENROUTER_API_KEY, an: process.env.ANTHROPIC_API_KEY, oa: process.env.OPENAI_API_KEY };
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return fn().finally(() => {
    if (prev.or !== undefined) process.env.OPENROUTER_API_KEY = prev.or;
    if (prev.an !== undefined) process.env.ANTHROPIC_API_KEY = prev.an;
    if (prev.oa !== undefined) process.env.OPENAI_API_KEY = prev.oa;
  });
}

function baseConfig(latticeId: string, overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: `lattice ${latticeId}` },
    substrate: { laws: ['x'] },
    memory: { dbPath: ':memory:' },
    goals: { initial: [], dbPath: ':memory:' },
    drives: {},
    engine: { type: 'runcor-engine', apiKeys: {} },
    controls: {
      autonomy: 0.5, exploration: 0.5, memoryDurability: { tau: 100, D: 1 },
      promotionThreshold: 0.6, dialecticDepth: 'shallow', reviewCadence: 0,
      drivePressure: 0.5, riskTolerance: 0.5, planStability: 0.5,
      memoryRecallBreadth: 4, budget: { time: 30 },
    },
    protocol: { latticeId },
    ...overrides,
  };
}

beforeEach(() => {
  __resetProtocolRegistry();
});

describe('Lattice protocol — disabled mode', () => {
  it('returns no-op implementation when no config passed', async () => {
    await withoutKeys(async () => {
      const p = createLatticeProtocol(undefined);
      expect(p.subscribeToTrace('any')).toBeNull();
      expect(p.bridgeMemory('any', 'all')).toBeNull();
      expect(p.sendMessage('any', { from: 'me', text: 'hello' })).toBe(false);
      expect(p.drainInbox()).toEqual([]);
    });
  });
});

describe('Lattice protocol — in-process peering', () => {
  it('sendMessage delivers between two lattices; recipient drains it in observe phase', async () => {
    await withoutKeys(async () => {
      const agentB = instantiate(baseConfig('B', {
        controls: { autonomy: 0.5, exploration: 0.5, memoryDurability: { tau: 100, D: 1 }, promotionThreshold: 0.6, dialecticDepth: 'shallow', reviewCadence: 0, drivePressure: 0.5, riskTolerance: 0.5, planStability: 0.5, memoryRecallBreadth: 4, budget: { time: 50 } },
      }));
      const observed: Array<Record<string, unknown>> = [];
      const stream = agentB.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'observe' && (e.data as Record<string, unknown>).inboxMessages !== undefined && ((e.data as Record<string, unknown>).inboxMessages as number) > 0) {
            observed.push(e.data);
            if (observed.length >= 1) break;
          }
        }
      })();
      // Send a message from A's protocol view; B's cycle should observe it.
      const protocolA = createLatticeProtocol({ latticeId: 'A' });
      // Wait a tick to let B register itself in the registry (cycle constructor runs sync).
      await new Promise((r) => setTimeout(r, 5));
      const ok = protocolA.sendMessage('B', { from: 'A', text: 'hello from A' });
      expect(ok).toBe(true);
      await agentB.run();
      stream.close();
      await reader;
      expect(observed[0]).toMatchObject({ inboxMessages: 1, messagesFrom: ['A'] });
    });
  });

  it('bridgeMemory exposes peer memory read-only via the protocol (disabled-memory peer returns null)', async () => {
    await withoutKeys(async () => {
      // Create B (memory disabled — no OpenAI key) then have A try to bridge to B.
      const agentB = instantiate(baseConfig('B'));
      const protocolA = createLatticeProtocol({ latticeId: 'A' });
      await new Promise((r) => setTimeout(r, 5));
      const bridge = protocolA.bridgeMemory('B', 'all');
      // Memory is disabled (no OpenAI key) → bridge returns null per the
      // implementation contract: "no bridge unless peer memory is enabled".
      expect(bridge).toBeNull();
      // Cleanup
      agentB.stop();
      await agentB.run();
    });
  });

  it('subscribeToTrace returns null when peer has not published', async () => {
    await withoutKeys(async () => {
      const protocolA = createLatticeProtocol({ latticeId: 'A' });
      expect(protocolA.subscribeToTrace('nonexistent')).toBeNull();
    });
  });

  it('sendMessage to unregistered lattice returns false', async () => {
    await withoutKeys(async () => {
      const protocolA = createLatticeProtocol({ latticeId: 'A' });
      const result = protocolA.sendMessage('unknown', { from: 'A', text: 'lost message' });
      expect(result).toBe(false);
    });
  });
});

describe('Lattice protocol — observe phase wires inbox drain', () => {
  it('cycles without protocol config still emit observe phase entries normally', async () => {
    await withoutKeys(async () => {
      const agent = instantiate(baseConfig('SOLO', { protocol: undefined as never }));
      const collected: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'observe' && e.cycle === 1 && (e.data as Record<string, unknown>).inboxMessages !== undefined) {
            collected.push(e.data);
            break;
          }
        }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(collected[0]).toMatchObject({ inboxMessages: 0 });
    });
  });
});
