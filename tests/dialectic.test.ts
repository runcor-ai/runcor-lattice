// Dialectic adapter tests — verify disabled-mode is a no-op and the cycle's decide phase
// emits trace entries that reflect dialectic state.
//
// Live-dialectic verification (real Player/Coach/Judge calls to OpenRouter) is covered by
// V2's existing dialectic probes and runcor-dialectic's own test suite — the day-4 commit
// only verifies the adapter wiring.

import { describe, it, expect } from 'vitest';
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

describe('Dialectic adapter — disabled mode', () => {
  it('returns isEnabled=false when no provider key', () => {
    const prev = { or: process.env.OPENROUTER_API_KEY, an: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENROUTER_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    try {
      const d = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      expect(d.isEnabled()).toBe(false);
    } finally {
      if (prev.or !== undefined) process.env.OPENROUTER_API_KEY = prev.or;
      if (prev.an !== undefined) process.env.ANTHROPIC_API_KEY = prev.an;
    }
  });

  it('decide returns a placeholder answer with enabled=false, $0 cost', async () => {
    const prev = { or: process.env.OPENROUTER_API_KEY, an: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENROUTER_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    try {
      const d = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const out = await d.decide({ problem: 'What is 2+2?' });
      expect(out.enabled).toBe(false);
      expect(out.costUsd).toBe(0);
      expect(out.convergenceReason).toBe('disabled');
      expect(out.answer.length).toBeGreaterThan(0);
    } finally {
      if (prev.or !== undefined) process.env.OPENROUTER_API_KEY = prev.or;
      if (prev.an !== undefined) process.env.ANTHROPIC_API_KEY = prev.an;
    }
  });
});

function withDisabledKeys<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = { or: process.env.OPENROUTER_API_KEY, an: process.env.ANTHROPIC_API_KEY };
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  return Promise.resolve(fn()).finally(() => {
    if (prev.or !== undefined) process.env.OPENROUTER_API_KEY = prev.or;
    if (prev.an !== undefined) process.env.ANTHROPIC_API_KEY = prev.an;
  });
}

describe('Dialectic adapter — model overrides', () => {
  it('currentModels() returns canonical defaults when no overrides', async () => {
    await withDisabledKeys(() => {
      const d = createDialectic({ type: 'runcor-engine', apiKeys: {} }, 'shallow');
      const m = d.currentModels();
      expect(m.player).toContain('nemotron');
      expect(m.coach).toContain('qwen');
      expect(m.judge).toContain('llama');
    });
  });

  it('currentModels() reflects partial overrides + canonical fallback for unset roles', async () => {
    await withDisabledKeys(() => {
      const d = createDialectic({ type: 'runcor-engine', apiKeys: { openrouter: 'stub' } }, 'shallow', { player: 'openrouter/anthropic/claude-haiku-4-5' });
      const m = d.currentModels();
      expect(m.player).toBe('openrouter/anthropic/claude-haiku-4-5');
      expect(m.coach).toContain('qwen');
      expect(m.judge).toContain('llama');
    });
  });

  it('setModels() updates the effective models', async () => {
    await withDisabledKeys(() => {
      const d = createDialectic({ type: 'runcor-engine', apiKeys: { openrouter: 'stub' } }, 'shallow');
      d.setModels({ judge: 'openrouter/openai/gpt-4o-mini' });
      expect(d.currentModels().judge).toBe('openrouter/openai/gpt-4o-mini');
      d.setModels(undefined);
      expect(d.currentModels().judge).toContain('llama');
    });
  });
});

describe('Dialectic wired into the cycle — disabled mode', () => {
  it('decide phase emits trace entry with enabled=false and convergenceReason=disabled', async () => {
    const prev = { or: process.env.OPENROUTER_API_KEY, an: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENROUTER_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    try {
      const agent = instantiate(baseConfig());
      const collected: Array<Record<string, unknown>> = [];
      const stream = agent.observe();
      const reader = (async () => {
        for await (const e of stream) if (e.phase === 'decide' && e.cycle === 1) { collected.push(e.data); break; }
      })();
      await agent.run();
      stream.close();
      await reader;
      expect(collected[0]).toMatchObject({ enabled: false, convergenceReason: 'disabled', costUsd: 0 });
    } finally {
      if (prev.or !== undefined) process.env.OPENROUTER_API_KEY = prev.or;
      if (prev.an !== undefined) process.env.ANTHROPIC_API_KEY = prev.an;
    }
  });
});
