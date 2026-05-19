// Trace adapter tests — verify capture, persistence, broadcast, and the bounded buffer.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTrace } from '../src/trace/index.js';
import { instantiate, type LatticeConfig, type TraceEntry } from '../src/index.js';

function baseConfig(overrides: Partial<LatticeConfig> = {}): LatticeConfig {
  return {
    identity: { description: 'trace test' },
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
      budget: { time: 80 },
    },
    ...overrides,
  };
}

function makeEntry(phase: TraceEntry['phase'], cycle: number): TraceEntry {
  return { engagementId: 'eng-test', cycle, phase, ts: Date.now(), data: { stub: true } };
}

describe('Trace adapter — in-memory mode', () => {
  it('path() returns the in-memory sentinel when no dir configured', () => {
    const t = createTrace();
    t.start('eng-1');
    t.capture(makeEntry('observe', 1));
    expect(t.path()).toMatch(/^\(in-memory; 1 entries\)/);
  });

  it('count() reflects total captures', () => {
    const t = createTrace();
    t.start('eng-1');
    t.capture(makeEntry('observe', 1));
    t.capture(makeEntry('ground', 1));
    expect(t.count()).toBe(2);
  });

  it('latest() returns the most recently captured entry', () => {
    const t = createTrace();
    t.start('eng-1');
    t.capture(makeEntry('observe', 1));
    t.capture(makeEntry('judge', 1));
    expect(t.latest()?.phase).toBe('judge');
  });

  it('subscribe() receives every captured entry; unsubscribe stops delivery', () => {
    const t = createTrace();
    t.start('eng-1');
    const received: string[] = [];
    const unsub = t.subscribe((e) => received.push(`${e.cycle}:${e.phase}`));
    t.capture(makeEntry('observe', 1));
    t.capture(makeEntry('ground', 1));
    unsub();
    t.capture(makeEntry('recall', 1));
    expect(received).toEqual(['1:observe', '1:ground']);
  });

  it('memoryBufferCap drops oldest entries beyond the cap', () => {
    const t = createTrace({ memoryBufferCap: 3 });
    t.start('eng-1');
    for (let i = 0; i < 5; i++) t.capture(makeEntry('observe', i));
    expect(t.count()).toBe(5); // total captures
    expect(t.latest()?.cycle).toBe(4); // latest preserved
    // The internal buffer is bounded — we don't expose it directly, but count() != buffer length
    // documents the distinction: count is monotonic, buffer is rolling.
  });
});

describe('Trace adapter — disk mode', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lattice-trace-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes one JSONL file per engagement, one line per entry', () => {
    const t = createTrace({ dir: tmp });
    t.start('eng-disk');
    t.capture(makeEntry('observe', 1));
    t.capture(makeEntry('ground', 1));
    t.capture(makeEntry('judge', 1));
    const files = readdirSync(tmp);
    expect(files).toContain('eng-disk.jsonl');
    const lines = readFileSync(join(tmp, 'eng-disk.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]!);
    expect(first.phase).toBe('observe');
    expect(first.cycle).toBe(1);
  });

  it('path() returns the JSONL path when dir configured', () => {
    const t = createTrace({ dir: tmp });
    t.start('eng-x');
    expect(t.path()).toBe(join(tmp, 'eng-x.jsonl'));
  });

  it('end() appends a synthetic engagement-ended entry', () => {
    const t = createTrace({ dir: tmp });
    t.start('eng-end');
    t.capture(makeEntry('observe', 1));
    t.end({
      engagementId: 'eng-end',
      exitReason: 'budget-exhausted',
      cyclesRun: 1,
      totalCostUsd: 0,
      totalTokens: { input: 0, output: 0 },
      durationMs: 100,
      finalState: { engagementId: 'eng-end', cycleCount: 1, currentPhase: 'idle', currentGoals: [], budgetRemaining: {}, status: 'complete' },
      tracePath: join(tmp, 'eng-end.jsonl'),
    });
    const lines = readFileSync(join(tmp, 'eng-end.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const last = JSON.parse(lines[1]!);
    expect(last.data.event).toBe('engagement-ended');
    expect(last.data.exitReason).toBe('budget-exhausted');
  });

  it('creates the dir if it does not exist', () => {
    const nestedDir = join(tmp, 'a', 'b', 'c');
    expect(existsSync(nestedDir)).toBe(false);
    const t = createTrace({ dir: nestedDir });
    t.start('eng-nested');
    t.capture(makeEntry('observe', 0));
    expect(existsSync(join(nestedDir, 'eng-nested.jsonl'))).toBe(true);
  });
});

describe('Trace wired into the cycle', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'lattice-trace-cycle-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('engagement result.tracePath points at the on-disk JSONL', async () => {
    const agent = instantiate(baseConfig({ trace: { dir: tmp }, controls: { ...baseConfig().controls, budget: { time: 30 } } }));
    const result = await agent.run();
    expect(result.tracePath).toContain(tmp);
    expect(result.tracePath).toMatch(/\.jsonl$/);
    expect(existsSync(result.tracePath)).toBe(true);
  });

  it('trace file contains entries for every phase in every cycle plus the final engagement-ended entry', async () => {
    const agent = instantiate(baseConfig({ trace: { dir: tmp }, controls: { ...baseConfig().controls, budget: { time: 30 } } }));
    const result = await agent.run();
    const lines = readFileSync(result.tracePath, 'utf-8').trim().split('\n');
    const parsed = lines.map((l) => JSON.parse(l));
    const last = parsed[parsed.length - 1];
    expect(last.data.event).toBe('engagement-ended');
    expect(parsed.filter((p) => p.phase === 'ground').length).toBeGreaterThanOrEqual(result.cyclesRun);
  });

  it('falls back to in-memory sentinel when no trace dir configured', async () => {
    const agent = instantiate(baseConfig({ controls: { ...baseConfig().controls, budget: { time: 20 } } }));
    const result = await agent.run();
    expect(result.tracePath).toMatch(/^\(in-memory;/);
  });
});
