// Control-surface presets — common dial configurations consumers can pick from.
//
// These are starting points, not law. A Bridge UX typically presents these as named
// dropdowns ("Cautious", "Explorer", "Production") that load a ControlSurface; the operator
// then fine-tunes individual sliders.
//
// Budget is intentionally NOT pre-filled — it's the most engagement-specific dial.

import type { ControlSurface } from '../types.js';

type ControlPreset = Omit<ControlSurface, 'budget'>;

const COMMON: Pick<ControlPreset, 'memoryDurability'> = {
  memoryDurability: { tau: 100, D: 1 },
};

/** Default — balanced; matches the dial set used in tests and the day-1 example. */
export const DEFAULT_PRESET: ControlPreset = {
  ...COMMON,
  autonomy: 0.5,
  exploration: 0.4,
  promotionThreshold: 0.6,
  dialecticDepth: 'medium',
  reviewCadence: 5,
  drivePressure: 0.5,
  riskTolerance: 0.5,
  planStability: 0.5,
  memoryRecallBreadth: 8,
};

/** Cautious — aggressive substrate, slow cadence, narrow recall. For high-stakes domains. */
export const CAUTIOUS_PRESET: ControlPreset = {
  ...COMMON,
  autonomy: 0.2,
  exploration: 0.1,
  promotionThreshold: 0.8,
  dialecticDepth: 'deep',
  reviewCadence: 3,
  drivePressure: 0.3,
  riskTolerance: 0.2,
  planStability: 0.8,
  memoryRecallBreadth: 5,
};

/** Explorer — broad recall, frequent dialectic, willing to try new actions. */
export const EXPLORER_PRESET: ControlPreset = {
  ...COMMON,
  autonomy: 0.7,
  exploration: 0.9,
  promotionThreshold: 0.5,
  dialecticDepth: 'shallow', // shallow lets it try more options per dollar
  reviewCadence: 10,
  drivePressure: 0.8,
  riskTolerance: 0.7,
  planStability: 0.3,
  memoryRecallBreadth: 12,
};

/** Production — high autonomy once a lattice has graduated cold-start. Fast, lean. */
export const PRODUCTION_PRESET: ControlPreset = {
  ...COMMON,
  autonomy: 0.9,
  exploration: 0.3,
  promotionThreshold: 0.7,
  dialecticDepth: 'medium',
  reviewCadence: 20,
  drivePressure: 0.5,
  riskTolerance: 0.6,
  planStability: 0.7,
  memoryRecallBreadth: 8,
};

export const PRESETS = {
  default: DEFAULT_PRESET,
  cautious: CAUTIOUS_PRESET,
  explorer: EXPLORER_PRESET,
  production: PRODUCTION_PRESET,
} as const;

/** Convenience: take a preset + a budget and return a full ControlSurface. */
export function controlsFromPreset(
  preset: keyof typeof PRESETS,
  budget: ControlSurface['budget'],
): ControlSurface {
  return { ...PRESETS[preset], budget };
}
