// Loop skeleton tests — assert the cycle runs all 8 phases, captures trace, and exits
// on configured budgets. These tests validate the SKELETON (not phase implementations),
// so phases are expected to emit `{stub: true}` trace entries.

import { describe, it, expect } from 'vitest';
import { instantiate, PHASES, type LatticeConfig } from '../src/index.js';

function minimalConfig(overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: 'test agent' },
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
      budget: { time: 200 },
    },
    ...overrides,
  };
}

describe('Loop skeleton', () => {
  it('runs cycles until budget exhausted', async () => {
    const agent = instantiate(minimalConfig({ controls: { ...minimalConfig().controls, budget: { time: 50 } } }));
    const result = await agent.run();
    expect(result.exitReason).toBe('budget-exhausted');
    expect(result.cyclesRun).toBeGreaterThan(0);
    expect(result.finalState.status).toBe('complete');
  });

  it('emits trace entries for every phase in every cycle', async () => {
    const agent = instantiate(minimalConfig({ controls: { ...minimalConfig().controls, budget: { time: 50 } } }));
    const observed: string[] = [];
    const stream = agent.observe();
    const reader = (async () => {
      for await (const entry of stream) observed.push(`${entry.cycle}:${entry.phase}`);
    })();
    const result = await agent.run();
    stream.close();
    await reader;

    expect(observed[0]).toBe('0:observe');
    for (let c = 1; c <= result.cyclesRun; c++) {
      for (const phase of PHASES) {
        expect(observed).toContain(`${c}:${phase}`);
      }
    }
  });

  it('reports state at any time', async () => {
    const agent = instantiate(minimalConfig());
    const s0 = agent.state();
    expect(s0.cycleCount).toBe(0);
    expect(s0.currentPhase).toBe('idle');
    expect(s0.status).toBe('running');
  });

  it('responds to adjust() by emitting a trace entry observable to subscribers', async () => {
    const agent = instantiate(minimalConfig());
    const stream = agent.observe();
    const collected: Array<Record<string, unknown>> = [];
    const reader = (async () => {
      for await (const entry of stream) {
        collected.push(entry.data);
        if (collected.length >= 1) break;
      }
    })();
    agent.adjust({ drivePressure: 0.9 });
    await reader;
    stream.close();
    expect(collected[0]).toMatchObject({ event: 'controls-adjusted' });
  });

  it('stop() halts at next phase boundary', async () => {
    const agent = instantiate(minimalConfig({ controls: { ...minimalConfig().controls, budget: { time: 60_000 } } }));
    setTimeout(() => agent.stop(), 5);
    const result = await agent.run();
    expect(result.exitReason).toBe('manual-stop');
    expect(result.finalState.status).toBe('stopped');
  });
});
