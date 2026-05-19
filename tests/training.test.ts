// Training mode adapter tests — verify cold-start autonomy cap, adversarial-review
// cadence, and disabled-mode pass-through.

import { describe, it, expect } from 'vitest';
import { createTrainingMode } from '../src/training/index.js';
import { createMemory } from '../src/memory/index.js';
import { createDialectic } from '../src/dialectic/index.js';
import { instantiate, type LatticeConfig, type TrainingModeConfig } from '../src/index.js';

function baseConfig(overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: 'Application security analyst' },
    substrate: { laws: ['Cite evidence.'] },
    memory: { dbPath: ':memory:' },
    goals: { initial: [], dbPath: ':memory:' },
    drives: {},
    engine: { type: 'runcor-engine', apiKeys: {} },
    controls: {
      autonomy: 0.9, // configured high — training cap should pull this down
      exploration: 0.5,
      memoryDurability: { tau: 100, D: 1 },
      promotionThreshold: 0.6,
      dialecticDepth: 'shallow',
      reviewCadence: 0, // disable self-review so it doesn't interfere with training tests
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

function trainingCfg(overrides: Partial<TrainingModeConfig> = {}): TrainingModeConfig {
  return {
    validatedEngagementsRequired: 5,
    priorValidatedEngagements: 0,
    coldStartAutonomyCap: 0.3,
    adversarialReviewCadence: 4,
    ...overrides,
  };
}

describe('Training mode adapter — direct', () => {
  it('disabled when no config passed', async () => {
    await withoutKeys(async () => {
      const memory = createMemory({ dbPath: ':memory:' });
      const dialectic = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const tm = createTrainingMode(undefined, memory, dialectic, 'test');
      expect(tm.isEnabled()).toBe(false);
      expect(tm.isColdStart()).toBe(false);
      expect(tm.effectiveAutonomy(0.9)).toBe(0.9);
      expect(tm.shouldAdversarialReview(100)).toBe(false);
    });
  });

  it('cold-start caps autonomy until validated engagements meet the requirement', async () => {
    await withoutKeys(async () => {
      const memory = createMemory({ dbPath: ':memory:' });
      const dialectic = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');

      const earlyTm = createTrainingMode(trainingCfg({ priorValidatedEngagements: 1, validatedEngagementsRequired: 5, coldStartAutonomyCap: 0.3 }), memory, dialectic, 'test');
      expect(earlyTm.isColdStart()).toBe(true);
      expect(earlyTm.effectiveAutonomy(0.9)).toBe(0.3);
      expect(earlyTm.effectiveAutonomy(0.1)).toBe(0.1); // lower already; cap doesn't raise

      const matureTm = createTrainingMode(trainingCfg({ priorValidatedEngagements: 5, validatedEngagementsRequired: 5 }), memory, dialectic, 'test');
      expect(matureTm.isColdStart()).toBe(false);
      expect(matureTm.effectiveAutonomy(0.9)).toBe(0.9); // pass-through once mature
    });
  });

  it('shouldAdversarialReview honors cadence', async () => {
    await withoutKeys(async () => {
      const memory = createMemory({ dbPath: ':memory:' });
      const dialectic = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const tm = createTrainingMode(trainingCfg({ adversarialReviewCadence: 4 }), memory, dialectic, 'test');
      expect(tm.shouldAdversarialReview(0)).toBe(false); // cycle 0 excluded by spec
      expect(tm.shouldAdversarialReview(3)).toBe(false);
      expect(tm.shouldAdversarialReview(4)).toBe(true);
      expect(tm.shouldAdversarialReview(7)).toBe(false);
      expect(tm.shouldAdversarialReview(8)).toBe(true);
    });
  });

  it('runAdversarialReview is a no-op when memory disabled', async () => {
    await withoutKeys(async () => {
      const memory = createMemory({ dbPath: ':memory:' });
      const dialectic = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const tm = createTrainingMode(trainingCfg(), memory, dialectic, 'test');
      const r = await tm.runAdversarialReview(100);
      expect(r.enabled).toBe(false);
      expect(r.examined).toBe(0);
      expect(r.costUsd).toBe(0);
    });
  });
});

describe('Training mode wired into the cycle', () => {
  it('emits training-mode-active observation at cycle 0 when enabled', async () => {
    await withoutKeys(async () => {
      const agent = instantiate(baseConfig({ trainingMode: trainingCfg({ priorValidatedEngagements: 2, validatedEngagementsRequired: 5, coldStartAutonomyCap: 0.2 }) }));
      const collected: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'observe' && (e.data as Record<string, unknown>).event === 'training-mode-active') {
            collected.push(e.data);
            break;
          }
        }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(collected[0]).toMatchObject({ event: 'training-mode-active', isColdStart: true, validated: 2, required: 5, cap: 0.2, effectiveAutonomy: 0.2 });
    });
  });

  it('does NOT emit training-mode-active when trainingMode config omitted', async () => {
    await withoutKeys(async () => {
      const agent = instantiate(baseConfig());
      const collected: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'observe' && (e.data as Record<string, unknown>).event === 'training-mode-active') {
            collected.push(e.data);
          }
        }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(collected).toEqual([]);
    });
  });

  it('fires adversarial review at the cadence and captures it on the trace', async () => {
    await withoutKeys(async () => {
      const agent = instantiate(baseConfig({ trainingMode: trainingCfg({ adversarialReviewCadence: 3 }), controls: { ...baseConfig().controls, budget: { time: 50 } } }));
      const cycles: number[] = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'pulse' && (e.data as Record<string, unknown>).event === 'adversarial-review') {
            cycles.push(e.cycle);
          }
        }
      })();
      const result = await agent.run();
      stream.close();
      await reader;
      expect(cycles.length).toBeGreaterThan(0);
      for (const c of cycles) expect(c % 3).toBe(0);
      const expected = [];
      for (let c = 3; c <= result.cyclesRun; c += 3) expected.push(c);
      expect(cycles).toEqual(expected);
    });
  });
});
