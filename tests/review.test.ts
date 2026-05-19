// Self-review adapter tests — verify the cadence fires, the disabled-mode degrades
// gracefully, and the trace records the verdict.

import { describe, it, expect } from 'vitest';
import { createSelfReview } from '../src/review/index.js';
import { createMemory } from '../src/memory/index.js';
import { createDialectic } from '../src/dialectic/index.js';
import { instantiate, type LatticeConfig } from '../src/index.js';

function baseConfig(overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: 'Application security analyst' },
    substrate: { laws: ['Cite evidence.'] },
    memory: { dbPath: ':memory:' },
    goals: { initial: [], dbPath: ':memory:' },
    drives: {},
    engine: { type: 'runcor-engine', apiKeys: {} },
    controls: {
      autonomy: 0.5,
      exploration: 0.5,
      memoryDurability: { tau: 100, D: 1 },
      promotionThreshold: 0.6,
      dialecticDepth: 'shallow',
      reviewCadence: 3,
      drivePressure: 0.5,
      riskTolerance: 0.5,
      planStability: 0.5,
      memoryRecallBreadth: 4,
      budget: { time: 60 },
    },
    ...overrides,
  };
}

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

describe('Self-review adapter — disabled mode', () => {
  it('returns enabled=false when memory + dialectic both disabled', async () => {
    await withoutKeys(async () => {
      const memory = createMemory({ dbPath: ':memory:' });
      const dialectic = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const review = createSelfReview(memory, dialectic, 'test agent', () => '');
      const v = await review.runReview(5);
      expect(v.enabled).toBe(false);
      expect(v.costUsd).toBe(0);
      expect(v.window.nodesIncluded).toBe(0);
      expect(v.recommendation).toMatch(/disabled/);
    });
  });
});

describe('Self-review wired into the cycle', () => {
  it('does NOT fire when reviewCadence is 0', async () => {
    await withoutKeys(async () => {
      const cfg = baseConfig({ controls: { ...baseConfig().controls, reviewCadence: 0, budget: { time: 40 } } });
      const agent = instantiate(cfg);
      const observed: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'pulse' && (e.data as Record<string, unknown>).event === 'self-review') {
            observed.push(e.data);
          }
        }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(observed).toEqual([]);
    });
  });

  it('fires at every cadence-multiple cycle (cycle % reviewCadence === 0)', async () => {
    await withoutKeys(async () => {
      const cfg = baseConfig({ controls: { ...baseConfig().controls, reviewCadence: 3, budget: { time: 60 } } });
      const agent = instantiate(cfg);
      const reviewCycles: number[] = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'pulse' && (e.data as Record<string, unknown>).event === 'self-review') {
            reviewCycles.push(e.cycle);
          }
        }
      })();
      const result = await agent.run();
      stream.close();
      await reader;
      // Reviews should fire at cycle 3, 6, 9, ... up to cyclesRun
      const expected = [];
      for (let c = 3; c <= result.cyclesRun; c += 3) expected.push(c);
      // At least one review should have fired given the time budget
      expect(reviewCycles.length).toBeGreaterThan(0);
      // Every observed review-cycle must be a multiple of 3
      for (const c of reviewCycles) expect(c % 3).toBe(0);
      // Reviews observed should match the expected set (order preserved)
      expect(reviewCycles).toEqual(expected);
    });
  });

  it('records the verdict on the trace with enabled=false and a recommendation field', async () => {
    await withoutKeys(async () => {
      const cfg = baseConfig({ controls: { ...baseConfig().controls, reviewCadence: 2, budget: { time: 40 } } });
      const agent = instantiate(cfg);
      const observed: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'pulse' && (e.data as Record<string, unknown>).event === 'self-review') {
            observed.push(e.data);
            break;
          }
        }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(observed[0]).toBeDefined();
      expect(observed[0]).toMatchObject({ event: 'self-review', enabled: false, costUsd: 0 });
      expect(observed[0]).toHaveProperty('recommendation');
      expect(observed[0]).toHaveProperty('summary');
      expect(observed[0]).toHaveProperty('window');
    });
  });
});
