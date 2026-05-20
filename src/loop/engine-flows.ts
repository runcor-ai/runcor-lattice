// Engine-flow plumbing for the cycle's 8 phases.
//
// When an engine is wired into the lattice (config.engine.instance), every
// per-cycle phase runs inside an engine flow execution. This module holds the
// module-scope plumbing — the active-cycle map (keyed by engagementId) and a
// single 'lattice.runPhase' flow registration that dispatches into the right
// cycle instance.
//
// Why dispatch through a single flow + activeCycles map instead of per-cycle
// flow registration: the engine doesn't support unregistering flows, and we
// don't want the flow registry to grow without bound as engagements come and
// go. One generic flow + a lookup table keeps the registry bounded.

import type { Cycle } from './cycle.js';
import type { Phase } from '../types.js';

/** Map of in-flight engagementId → Cycle. The 'lattice.runPhase' flow handler
 *  uses this to resolve the right Cycle to invoke when the engine calls back. */
export const activeCycles = new Map<string, Cycle>();

const PHASE_FLOW = 'lattice.runPhase';
const registeredEngines = new WeakSet<object>();

interface MinimalEngine {
  register(name: string, handler: (ctx: { input: unknown }) => Promise<unknown>, config?: { timeout?: number; maxRetries?: number }): void;
}

/** Register the 'lattice.runPhase' flow on the engine once.
 *  Idempotent — safe to call from every Cycle constructor. */
export function ensureRunPhaseFlow(engine: unknown): void {
  if (!engine || typeof (engine as MinimalEngine).register !== 'function') return;
  if (registeredEngines.has(engine as object)) return;
  (engine as MinimalEngine).register(
    PHASE_FLOW,
    async (ctx) => {
      const { engagementId, phase } = ctx.input as { engagementId: string; phase: Phase };
      const cycle = activeCycles.get(engagementId);
      if (!cycle) {
        throw new Error(`lattice.runPhase: no active cycle for engagementId="${engagementId}" (cycle may have finalised)`);
      }
      await cycle.runPhaseDirect(phase);
      return { phase, ok: true };
    },
    // Phase flows can take a while when they include LLM calls (decide, pulse).
    // Bump timeout well above the 30s engine default; longest realistic phase is
    // a deep dialectic decide which may run 5+ minutes including all rounds.
    { timeout: 600000, maxRetries: 0 },
  );
  registeredEngines.add(engine as object);
}
