// Memory adapter tests — verify disabled-mode is a no-op and that the cycle's
// recall + write phases produce trace entries that reflect the adapter state.
//
// Real-memory tests (with embeddings) live in tests/memory.live.test.ts and only
// run when OPENAI_API_KEY is set. The day-3 commit only covers the disabled-mode
// path — the live-memory path is exercised by V2 already (integration probe 11/16
// in autonomous-company-v2/scripts/probe).

import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/memory/index.js';
import { instantiate, type LatticeConfig } from '../src/index.js';

function baseConfig(overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: 'Application security analyst' },
    substrate: { laws: ['Cite evidence.'] },
    memory: { dbPath: ':memory:' }, // No openaiKey — adapter goes into disabled mode
    goals: { initial: [], dbPath: ':memory:' },
    drives: {},
    engine: { type: 'runcor-engine', apiKeys: {} },
    controls: {
      autonomy: 0.5,
      exploration: 0.5,
      memoryDurability: { tau: 100, D: 1 },
      promotionThreshold: 0.6,
      dialecticDepth: 'shallow',
      reviewCadence: 5,
      drivePressure: 0.5,
      riskTolerance: 0.5,
      planStability: 0.5,
      memoryRecallBreadth: 4,
      budget: { time: 60 },
    },
    ...overrides,
  };
}

describe('Memory adapter — disabled mode', () => {
  it('returns isEnabled=false when no OpenAI key', () => {
    // Explicitly pass empty key + clear env to avoid picking up ambient OPENAI_API_KEY
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const m = createMemory({ dbPath: ':memory:' });
      expect(m.isEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('recall returns empty array', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const m = createMemory({ dbPath: ':memory:' });
      const r = await m.recall('anything');
      expect(r).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('record returns disabled action', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const m = createMemory({ dbPath: ':memory:' });
      const r = await m.record('test event');
      expect(r.action).toBe('disabled');
      expect(r.nodeId).toBeNull();
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('stats returns zeros', () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const m = createMemory({ dbPath: ':memory:' });
      expect(m.stats()).toEqual({ total: 0, shortCube: 0, longCube: 0 });
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe('Memory wired into the cycle — disabled mode', () => {
  it('recall phase trace entry shows enabled=false and recalled=0', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const agent = instantiate(baseConfig());
      const collected: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) if (e.phase === 'recall' && e.cycle === 1) { collected.push(e.data); break; }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(collected[0]).toMatchObject({ enabled: false, recalled: 0 });
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('write phase trace entry shows recordAction=disabled', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const agent = instantiate(baseConfig());
      const collected: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) if (e.phase === 'write' && e.cycle === 1) { collected.push(e.data); break; }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(collected[0]).toMatchObject({ recordAction: 'disabled', enabled: false });
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});
