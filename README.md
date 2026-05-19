# runcor-lattice

Open-source cognitive runtime that turns an LLM into an autonomous entity. Composes the runcor sibling components into a configurable, peer-aware lattice.

MIT licensed. Built on top of the existing `runcor` engine.

## Status

**Day 1 — skeleton.** The Loop runs all 8 phases per cycle (`observe → ground → recall → decide → act → judge → write → pulse`), captures a trace, and exits on configured budgets. Phase implementations are stubs that emit `{stub: true}` trace entries.

Build order ahead (per `runcor-lattice-build-spec.md`):

1. ✅ Loop skeleton (phases, pulse, exit) — this commit
2. ⏳ Substrate (law injection, identity prior, discernment gate)
3. ⏳ Memory (cube schema, M formula, simple promotion)
4. ⏳ Dialectic (Player/Coach/Judge over existing engine)
5. ⏳ Trace (cross-cutting capture, transcript emit)
6. ⏳ Self-review (compressed memory dialectic at cadence)
7. ⏳ Training mode primitives (validation gates, adversarial review)
8. ⏳ Control surface (dial wiring)
9. ⏳ Lattice protocol (peer-to-peer over MCP)

## Quick start

```typescript
import { instantiate } from 'runcor-lattice';

const agent = instantiate({
  identity: { description: 'Application security analyst' },
  substrate: { laws: ['Cite evidence for every claim.'] },
  memory: { dbPath: './agent-memory.db' },
  goals: { initial: [{ statement: 'Produce a vulnerability summary.', level: 'objective' }], dbPath: './agent-goals.db' },
  drives: { budget: { tokens: 10_000 } },
  engine: { type: 'runcor-engine', apiKeys: { openrouter: process.env.OPENROUTER_API_KEY } },
  controls: { /* dials, see ControlSurface in src/types.ts */ },
});

const result = await agent.run();
console.log(result.exitReason, result.cyclesRun, result.totalCostUsd);
```

See `examples/first-engagement.ts` for the day-1 vertical-slice configuration.

## Architecture

Four layers (per spec):

1. **Substrate** — enforced physics (laws + identity prior + reality slice + discernment gate)
2. **Memory** — persistence (decay/promotion cubes + rolling plan)
3. **Engine** — runtime (already built; consumed via `runcor`)
4. **Loop** — cognition cycle (the arrangement that runs everything)

Plus: **Trace** (cross-cutting reasoning provenance), **Training mode** (low-autonomy gated promotion), **Control surface** (runtime dials), **Lattice protocol** (peer-to-peer interaction over MCP).

## Build / test

```bash
npm install
npm run build
npm test
npm run typecheck
```
