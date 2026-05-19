// Day-1 vertical slice — runs the cycle skeleton end-to-end.
//
// Per spec §"Vertical slice test (day 1)": "Analyze this 3-file codebase and produce a
// vulnerability summary." The full version of this example will wire substrate, memory,
// dialectic, and a real engine. The current version uses only the skeleton — it proves
// the loop runs all 8 phases, captures trace, and exits on a budget cap. The phases
// themselves are stubs that emit trace entries with `{stub: true}`.
//
// When each phase is implemented (in spec order), this example will be tightened — the
// `{stub: true}` markers will disappear from the trace, and the agent will produce a
// real vulnerability summary.

import { instantiate, type LatticeConfig } from '../src/index.js';

const config: LatticeConfig = {
  identity: {
    description: 'Application security analyst',
  },
  substrate: {
    laws: [
      'Cite evidence for every claim.',
      'State assumptions before conclusions.',
      'Refuse fabrications: if no evidence supports a claim, name the unknown.',
    ],
    realitySource: 'data-cube',
    discernmentMode: 'strict',
  },
  memory: {
    dbPath: ':memory:', // In-memory for the day-1 demo; the slice writeup will use a real path
    openaiKey: process.env['OPENAI_API_KEY'] ?? '',
  },
  goals: {
    initial: [
      { statement: 'Produce a vulnerability summary covering all 3 files in the test codebase.', level: 'objective' },
    ],
    dbPath: ':memory:',
  },
  drives: {
    budget: { tokens: 1000 },
    weights: { resource: 0.5, curiosity: 0.2, reactivity: 0.2, coherence: 0.1 },
  },
  engine: {
    type: 'runcor-engine',
    apiKeys: {
      openrouter: process.env['OPENROUTER_API_KEY'] ?? '',
    },
  },
  controls: {
    autonomy: 0.3,
    exploration: 0.4,
    memoryDurability: { tau: 100, D: 1 },
    promotionThreshold: 0.6,
    dialecticDepth: 'medium',
    reviewCadence: 5,
    drivePressure: 0.5,
    riskTolerance: 0.5,
    planStability: 0.5,
    memoryRecallBreadth: 8,
    // Tight for the skeleton: cycles cost nothing yet, so without this cap the in-memory
    // trace buffer grows until OOM. Will be widened once real LLM calls land in phases.
    budget: { dollars: 0.05, time: 100 },
  },
  trainingMode: true,
  reviewCycle: { everyNCycles: 5 },
  trace: {
    // Per-engagement JSONL written under examples/traces/. Inspect after the run with:
    //   head -n 20 examples/traces/<engagementId>.jsonl
    dir: 'examples/traces',
    memoryBufferCap: 5_000,
  },
};

async function main(): Promise<void> {
  const agent = instantiate(config);
  console.log(`[first-engagement] started ${agent.state().engagementId}`);

  const result = await agent.run();

  console.log('\n─── ENGAGEMENT RESULT ───');
  console.log(`  exit: ${result.exitReason}`);
  console.log(`  cycles: ${result.cyclesRun}`);
  console.log(`  duration: ${result.durationMs}ms`);
  console.log(`  cost: $${result.totalCostUsd.toFixed(6)}`);
  console.log(`  tokens: ${result.totalTokens.input + result.totalTokens.output}`);
  console.log(`  trace: ${result.tracePath}`);
}

main().catch((err) => {
  console.error('[first-engagement] FATAL:', err);
  process.exit(1);
});
