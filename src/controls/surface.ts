// ControlSurfaceApplicator — projects ControlSurface dials onto the live adapters each cycle.
//
// Per spec §8, each dial maps to a concrete mechanism in one of the layers. This file owns
// that mapping. The cycle calls `apply()` at the top of each cycle so that mid-flight
// `agent.adjust()` calls take effect on the very next phase.
//
// What runtime-applies today:
//   autonomy         → substrate.setDiscernmentMode (via 3-bucket threshold)
//   riskTolerance    → folded into the same discernment-mode mapping (lower tolerance = more strict)
//   dialecticDepth   → dialectic.setDepth (applied here AND in decide phase for safety)
//   exploration      → scales effective memory.recall breadth (multiplier on configured value)
//   memoryRecallBreadth, drivePressure, reviewCadence, budget → consumed directly by phases
//
// What's static-only (set at construction; cannot change mid-flight without rebuilding the
// component):
//   memoryDurability { tau, D }  — passed to MemorySystem at construction
//   promotionThreshold           — same
//   planStability                — plan-rewrite path not yet implemented
//
// The applicator emits a one-shot warning at cycle 0 noting which dials are static.

import type { ControlSurface, Phase, TraceEntry } from '../types.js';
import type { Substrate, DiscernmentMode } from '../substrate/index.js';
import type { Dialectic, DialecticDepth } from '../dialectic/index.js';
import type { TrainingMode } from '../training/index.js';

export interface EffectiveControls {
  /** Autonomy clamped by training-mode cold-start cap. */
  effectiveAutonomy: number;
  /** Discernment mode derived from autonomy + riskTolerance. */
  discernmentMode: DiscernmentMode;
  /** Effective recall breadth: configured value × (1 + exploration). */
  effectiveRecallBreadth: number;
  /** Effective dialectic depth (just pass-through; recorded for trace symmetry). */
  effectiveDialecticDepth: DialecticDepth;
}

export interface ControlSurfaceApplicator {
  apply(controls: ControlSurface): EffectiveControls;
  /** Static-dial warnings to emit once at cycle 0. */
  staticDialNotes(): Array<{ dial: string; reason: string }>;
}

class LatticeControlSurfaceApplicator implements ControlSurfaceApplicator {
  constructor(
    private readonly substrate: Substrate,
    private readonly dialectic: Dialectic,
    private readonly trainingMode: TrainingMode,
  ) {}

  apply(controls: ControlSurface): EffectiveControls {
    const effectiveAutonomy = this.trainingMode.effectiveAutonomy(controls.autonomy);
    const discernmentMode = deriveDiscernmentMode(effectiveAutonomy, controls.riskTolerance);
    this.substrate.setDiscernmentMode(discernmentMode);
    this.dialectic.setDepth(controls.dialecticDepth);
    const effectiveRecallBreadth = Math.max(1, Math.round(controls.memoryRecallBreadth * (1 + clamp01(controls.exploration))));
    return {
      effectiveAutonomy,
      discernmentMode,
      effectiveRecallBreadth,
      effectiveDialecticDepth: controls.dialecticDepth,
    };
  }

  staticDialNotes(): Array<{ dial: string; reason: string }> {
    return [
      { dial: 'memoryDurability', reason: 'tau and D are passed to MemorySystem at construction — runtime change requires re-instantiation.' },
      { dial: 'promotionThreshold', reason: 'M-threshold lives in MemorySystem config; same constraint as memoryDurability.' },
      { dial: 'planStability', reason: 'plan-rewrite path not yet implemented — dial is parked.' },
    ];
  }
}

/** Map (autonomy × riskTolerance) → 3-bucket discernment mode.
 *
 *  Both inputs lower the substrate's bar for intervening.
 *  blended = (autonomy + riskTolerance) / 2 (range 0..1).
 *
 *  blended < 0.34 → aggressive  (lots of substrate intervention)
 *  0.34..0.67     → moderate
 *  > 0.67         → conservative (let the agent speak more freely)
 */
export function deriveDiscernmentMode(autonomy: number, riskTolerance: number): DiscernmentMode {
  const blended = (clamp01(autonomy) + clamp01(riskTolerance)) / 2;
  if (blended < 0.34) return 'aggressive';
  if (blended < 0.67) return 'moderate';
  return 'conservative';
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function createControlSurfaceApplicator(
  substrate: Substrate,
  dialectic: Dialectic,
  trainingMode: TrainingMode,
): ControlSurfaceApplicator {
  return new LatticeControlSurfaceApplicator(substrate, dialectic, trainingMode);
}

// Re-export for consumers writing trace-driven dashboards.
export type { Phase, TraceEntry };
