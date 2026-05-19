# runcor-lattice

Open-source cognitive runtime that turns an LLM into an autonomous entity. Composes the runcor sibling components into a configurable, peer-aware lattice.

MIT licensed. Built on top of the existing `runcor` engine.

## Status

**v0.0.1 — all 9 build-order steps complete.** 60/60 tests passing. Loop runs end-to-end; every adapter has a disabled-mode for $0 testing; cross-process MCP wiring is the only piece left for the protocol layer (in-process peering already works for tests).

Build order (per `runcor-lattice-build-spec.md`):

1. ✅ Loop skeleton (phases, pulse, exit)
2. ✅ Substrate (laws + identity prior + reality + goal context layered into ground; discernment gate in judge; substrate-hard-stop wired)
3. ✅ Memory (recall in `recall` phase, episodic record + R9 consolidation in `write` phase; disabled-mode no-op when no OpenAI key)
4. ✅ Dialectic (Player/Coach/Judge in `decide` phase via runcor-dialectic; dial maps shallow/medium/deep to maxRounds; disabled-mode when no provider key)
5. ✅ Trace (JSONL per engagement, bounded in-memory ring, broadcast to ObservationStream subscribers; cycle delegates all trace ownership to the adapter)
6. ✅ Self-review (compressed memory window every `controls.reviewCadence` cycles → dialectic → verdict + recommendation captured in trace; disabled-mode degrades cleanly)
7. ✅ Training mode (cold-start humility caps autonomy until N validated engagements complete; adversarial review at independent cadence asks "would we still promote these?"; procedural-promotion gating deferred — needs memory candidate state)
8. ✅ Control surface (ControlSurfaceApplicator wires autonomy+riskTolerance→substrate discernment mode, exploration→recall breadth scaling, dialecticDepth→dialectic; 4 presets shipped; static dials warn once at cycle 0)
9. ✅ Lattice protocol (in-process publishTrace/subscribeToTrace/bridgeMemory/sendMessage with process-local registry; cross-process MCP server + ReachableSource discovery deferred — placeholder marked in src/protocol/index.ts with the exact integration plan)

### Beyond the 9 steps

10. ✅ Capability system + act phase (Capability registry, INVOKE-line parser, executeCapability dispatch; act phase parses & executes, judge evaluates the result, write records it. `GoalConfig.completion` predicate now drives goal-complete exit). `examples/vertical-slice.ts` ships the spec's day-1 engagement (3-file vulnerability audit). Run with `OPENAI_API_KEY` + `OPENROUTER_API_KEY` set.
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
