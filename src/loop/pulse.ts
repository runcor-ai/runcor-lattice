// Pulse — the heartbeat that decides whether to continue the cycle and at what intensity.
//
// Per spec §1: "Drives provide the pulse." The full implementation will compute drive
// pressure from runcor-drives (resource, curiosity, reactivity, coherence) + budget burn
// + temporal context (runcor-temporal.computeNextWake). For now, pulse is a deterministic
// "always continue with the configured pressure" stub so the cycle can be exercised.

export interface PulseInput {
  cycle: number;
  drivePressure: number;
}

export interface PulseResult {
  /** Should the next cycle fire? When false, the loop exits via 'manual-stop'. */
  shouldContinue: boolean;
  /** Effective pressure for the next cycle (0..1). Real impl: weighted blend of drives. */
  nextPressure: number;
  /** Wake delay before next cycle in ms (0 = immediate). Real impl: runcor-temporal. */
  nextWakeMs: number;
}

export function pulse(input: PulseInput): PulseResult {
  // Stub: always continue, propagate pressure as-is, no inter-cycle wait.
  return {
    shouldContinue: true,
    nextPressure: input.drivePressure,
    nextWakeMs: 0,
  };
}
