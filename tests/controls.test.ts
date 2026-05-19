// Control-surface tests — verify dial → mechanism wiring + preset shape.

import { describe, it, expect } from 'vitest';
import {
  deriveDiscernmentMode,
  PRESETS,
  controlsFromPreset,
  instantiate,
  type LatticeConfig,
} from '../src/index.js';
import { createControlSurfaceApplicator } from '../src/controls/surface.js';
import { createSubstrate } from '../src/substrate/index.js';
import { createDialectic } from '../src/dialectic/index.js';
import { createTrainingMode } from '../src/training/index.js';
import { createMemory } from '../src/memory/index.js';

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

function baseConfig(overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: 'control test' },
    substrate: { laws: ['Cite evidence.'], discernmentMode: 'strict' },
    memory: { dbPath: ':memory:' },
    goals: { initial: [], dbPath: ':memory:' },
    drives: {},
    engine: { type: 'runcor-engine', apiKeys: {} },
    controls: controlsFromPreset('default', { time: 50 }),
    ...overrides,
  };
}

describe('deriveDiscernmentMode', () => {
  it('low autonomy + low risk → aggressive', () => {
    expect(deriveDiscernmentMode(0.1, 0.2)).toBe('aggressive');
  });
  it('mid blended → moderate', () => {
    expect(deriveDiscernmentMode(0.5, 0.5)).toBe('moderate');
  });
  it('high autonomy + high risk → conservative', () => {
    expect(deriveDiscernmentMode(0.9, 0.8)).toBe('conservative');
  });
  it('clamps inputs to 0..1', () => {
    expect(deriveDiscernmentMode(1.5, 1.5)).toBe('conservative');
    expect(deriveDiscernmentMode(-0.5, -0.5)).toBe('aggressive');
  });
});

describe('Presets', () => {
  it('exposes 4 presets, each with the full ControlSurface minus budget', () => {
    expect(Object.keys(PRESETS)).toEqual(['default', 'cautious', 'explorer', 'production']);
    for (const name of Object.keys(PRESETS) as Array<keyof typeof PRESETS>) {
      const p = PRESETS[name];
      expect(p.autonomy).toBeGreaterThanOrEqual(0);
      expect(p.autonomy).toBeLessThanOrEqual(1);
      expect(p.memoryDurability).toEqual({ tau: 100, D: 1 });
    }
  });

  it('controlsFromPreset merges budget into the preset shape', () => {
    const c = controlsFromPreset('explorer', { tokens: 10_000 });
    expect(c.exploration).toBe(0.9);
    expect(c.dialecticDepth).toBe('shallow');
    expect(c.budget).toEqual({ tokens: 10_000 });
  });
});

describe('ControlSurfaceApplicator', () => {
  it('apply() returns effective controls and writes them onto substrate + dialectic', async () => {
    await withoutKeys(async () => {
      const substrate = createSubstrate({ laws: ['x'] }, 'test');
      const dialectic = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const memory = createMemory({ dbPath: ':memory:' });
      const tm = createTrainingMode(undefined, memory, dialectic, 'test');
      const applicator = createControlSurfaceApplicator(substrate, dialectic, tm);

      const out = applicator.apply({
        autonomy: 0.1, exploration: 0.5, memoryDurability: { tau: 100, D: 1 },
        promotionThreshold: 0.6, dialecticDepth: 'deep', reviewCadence: 5,
        drivePressure: 0.5, riskTolerance: 0.1, planStability: 0.5,
        memoryRecallBreadth: 8, budget: {},
      });
      expect(out.discernmentMode).toBe('aggressive');
      expect(out.effectiveAutonomy).toBe(0.1);
      // exploration=0.5 → recall breadth × 1.5 = 12
      expect(out.effectiveRecallBreadth).toBe(12);
      expect(out.effectiveDialecticDepth).toBe('deep');
      expect(substrate.discernmentMode()).toBe('aggressive');
    });
  });

  it('static-dial notes flag the 3 dials that cannot change mid-flight', async () => {
    await withoutKeys(async () => {
      const substrate = createSubstrate({ laws: ['x'] }, 'test');
      const dialectic = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const memory = createMemory({ dbPath: ':memory:' });
      const tm = createTrainingMode(undefined, memory, dialectic, 'test');
      const applicator = createControlSurfaceApplicator(substrate, dialectic, tm);
      const notes = applicator.staticDialNotes();
      expect(notes.map((n) => n.dial)).toEqual(['memoryDurability', 'promotionThreshold', 'planStability']);
    });
  });
});

describe('Controls wired into the cycle', () => {
  it('emits effective-controls observation at every cycle', async () => {
    await withoutKeys(async () => {
      const agent = instantiate(baseConfig({ controls: { ...baseConfig().controls, budget: { time: 30 } } }));
      const seen: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'observe' && (e.data as Record<string, unknown>).event === 'effective-controls') {
            seen.push({ cycle: e.cycle, ...(e.data as Record<string, unknown>) });
          }
        }
      })();
      const result = await agent.run();
      stream.close();
      await reader;
      expect(seen.length).toBe(result.cyclesRun);
      const first = seen[0]!;
      expect(first).toHaveProperty('discernmentMode');
      expect(first).toHaveProperty('recallBreadth');
    });
  });

  it('static-dial-warning fires exactly once at cycle 0', async () => {
    await withoutKeys(async () => {
      const agent = instantiate(baseConfig({ controls: { ...baseConfig().controls, budget: { time: 30 } } }));
      const seen: number[] = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'observe' && (e.data as Record<string, unknown>).event === 'static-dial-warning') {
            seen.push(e.cycle);
          }
        }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(seen).toEqual([0]);
    });
  });

  it('adjust() takes effect on the next cycle', async () => {
    await withoutKeys(async () => {
      const agent = instantiate(baseConfig({ controls: { ...baseConfig().controls, autonomy: 0.1, riskTolerance: 0.1, budget: { time: 80 } } }));
      const modes: string[] = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) {
          if (e.phase === 'observe' && (e.data as Record<string, unknown>).event === 'effective-controls') {
            modes.push((e.data as Record<string, unknown>).discernmentMode as string);
          }
        }
      })();
      // Let a few cycles run, then bump autonomy + risk tolerance high.
      setTimeout(() => agent.adjust({ autonomy: 0.95, riskTolerance: 0.95 }), 10);
      await agent.run();
      stream.close();
      await reader;
      // Should see 'aggressive' at first, then 'conservative' after adjust takes effect.
      expect(modes[0]).toBe('aggressive');
      expect(modes[modes.length - 1]).toBe('conservative');
    });
  });
});
