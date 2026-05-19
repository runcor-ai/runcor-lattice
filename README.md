# runcor-lattice

Open-source cognitive runtime that turns an LLM into an autonomous entity. Composes the runcor sibling components into a configurable, peer-aware lattice.

MIT licensed. Built on top of the existing `runcor` engine.

## Status

**Day 1+ — skeleton with substrate live.** The Loop runs all 8 phases per cycle. The `ground` phase wraps each cycle's instruction with laws + identity prior + goal context + reality slice (via runcor-substrate). The `judge` phase runs the discernment gate on each cycle's output; accumulated flag verdicts trip a substrate-hard-stop exit. Other phases remain stubs.

Build order (per `runcor-lattice-build-spec.md`):

1. ✅ Loop skeleton (phases, pulse, exit)
2. ✅ Substrate (laws + identity prior + reality + goal context layered into ground; discernment gate in judge; substrate-hard-stop wired)
3. ✅ Memory (recall in `recall` phase, episodic record + R9 consolidation in `write` phase; disabled-mode no-op when no OpenAI key)
4. ⏳ Dialectic (Player/Coach/Judge over existing engine) — next
5. ⏳ Trace (cross-cutting capture, transcript emit, disk persistence)
6. ⏳ Self-review (compressed memory dialectic at cadence)
7. ⏳ Training mode primitives (validation gates, adversarial review)
8. ⏳ Control surface (full dial wiring)
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
