// Substrate adapter tests — verify ground + judge wiring produce real output and that
// the cycle integrates the substrate's verdicts into trace + exit conditions.

import { describe, it, expect } from 'vitest';
import { createSubstrate } from '../src/substrate/index.js';
import { instantiate, type LatticeConfig } from '../src/index.js';

function baseConfig(overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: 'Application security analyst' },
    substrate: {
      laws: [
        'Cite evidence for every claim.',
        'State assumptions before conclusions.',
        'Refuse fabrications: if no evidence supports a claim, name the unknown.',
      ],
      realitySource: 'data-cube',
      discernmentMode: 'permissive',
    },
    memory: { dbPath: ':memory:' },
    goals: {
      initial: [{ statement: 'Produce a vulnerability summary covering all 3 files.', level: 'objective' }],
      dbPath: ':memory:',
    },
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
      budget: { time: 80 },
    },
    ...overrides,
  };
}

describe('Substrate adapter', () => {
  it('ground() injects laws + identity prior + goal context into the system prompt', () => {
    const cfg = baseConfig();
    const substrate = createSubstrate(cfg.substrate, cfg.identity.description, cfg.identity.initialClaims ?? []);
    const wrapped = substrate.ground('What is the next action?', {
      engagementId: 'eng-test',
      cycle: 1,
      goalContext: '1. (objective) Produce a vulnerability summary covering all 3 files.',
    });
    expect(wrapped.system).toContain('Laws (binding, non-negotiable):');
    expect(wrapped.system).toContain('1. Cite evidence for every claim.');
    expect(wrapped.system).toContain('Identity prior: Application security analyst');
    expect(wrapped.system).toContain('Goal context:');
    expect(wrapped.system).toContain('Produce a vulnerability summary');
    expect(wrapped.system).toContain('What is the next action?');
    expect(wrapped.layers).toContain('laws');
    expect(wrapped.layers).toContain('identity_prior');
    expect(wrapped.layers).toContain('goal_context');
    expect(wrapped.layers).toContain('input');
  });

  it('ground() omits goal_context layer when no goals configured', () => {
    const cfg = baseConfig();
    const substrate = createSubstrate(cfg.substrate, cfg.identity.description);
    const wrapped = substrate.ground('hello', {
      engagementId: 'eng',
      cycle: 1,
      goalContext: '',
    });
    expect(wrapped.layers).not.toContain('goal_context');
    expect(wrapped.layers).toContain('laws');
  });

  it('judge() returns a DiscernmentResult with outcome', async () => {
    const cfg = baseConfig();
    const substrate = createSubstrate(cfg.substrate, cfg.identity.description);
    const verdict = await substrate.judge('What is the next action?', 'I will proceed by examining file 1.');
    expect(['pass', 'modify', 'block', 'escalate', 'flag']).toContain(verdict.outcome);
    expect(Array.isArray(verdict.checks)).toBe(true);
  });

  it('laws() returns the configured laws verbatim', () => {
    const cfg = baseConfig();
    const substrate = createSubstrate(cfg.substrate, cfg.identity.description);
    expect(substrate.laws()).toEqual(cfg.substrate.laws);
  });
});

describe('Substrate wired into the cycle', () => {
  it('ground phase emits a trace entry with non-empty layer names and a system length > 0', async () => {
    const cfg = baseConfig();
    const agent = instantiate(cfg);
    const observed: Array<Record<string, unknown>> = [];
    const stream = agent.observe();
    const reader = (async () => {
      for await (const e of stream) if (e.phase === 'ground' && e.cycle === 1) { observed.push(e.data); break; }
    })();
    await agent.run();
    stream.close();
    await reader;
    expect(observed[0]).toBeDefined();
    expect((observed[0] as { layers: string[] }).layers).toContain('laws');
    expect((observed[0] as { systemLength: number }).systemLength).toBeGreaterThan(0);
  });

  it('judge phase emits a trace entry with a verdict outcome', async () => {
    const cfg = baseConfig();
    const agent = instantiate(cfg);
    const observed: Array<Record<string, unknown>> = [];
    const stream = agent.observe();
    const reader = (async () => {
      for await (const e of stream) if (e.phase === 'judge' && e.cycle === 1) { observed.push(e.data); break; }
    })();
    await agent.run();
    stream.close();
    await reader;
    expect(observed[0]).toBeDefined();
    expect(observed[0]).toHaveProperty('outcome');
  });
});
