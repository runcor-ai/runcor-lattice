// Public API for runcor-lattice.
//
// One entry point: `instantiate(config)` returns an Agent that runs the cycle.
// Everything else (substrate config, memory config, controls, trace, peer protocol) is
// addressable through the LatticeConfig + Agent surfaces.

import { Cycle } from './loop/cycle.js';
import type { Agent, LatticeConfig } from './types.js';

export function instantiate(config: LatticeConfig): Agent {
  return new Cycle(config);
}

// Re-export types so consumers don't have to deep-import.
export type {
  ActionInvocation,
  Agent,
  AgentState,
  Capability,
  CapabilityContext,
  ControlSurface,
  DriveConfig,
  EngagementResult,
  EngineRef,
  GoalCompletionContext,
  GoalConfig,
  IdentityConfig,
  LatticeConfig,
  LatticeProtocolConfig,
  MemoryConfig,
  ObservationStream,
  Phase,
  SubstrateConfig,
  TraceConfig,
  TraceEntry,
  TrainingModeConfig,
} from './types.js';

export { parseInvocation, renderCapabilityCatalog } from './capabilities/index.js';
export { createWebCapabilities, WebCache } from './capabilities/web.js';
export type { WebKeys } from './capabilities/web.js';

export { PHASES, DEFAULT_DIALECTIC_MODELS } from './types.js';
export { PRESETS, DEFAULT_PRESET, CAUTIOUS_PRESET, EXPLORER_PRESET, PRODUCTION_PRESET, controlsFromPreset } from './controls/presets.js';
export { deriveDiscernmentMode } from './controls/surface.js';
export type { EffectiveControls } from './controls/surface.js';
export { createLatticeProtocol } from './protocol/index.js';
export type { LatticeProtocol, LatticeMessage, MemoryBridge, MemoryScope } from './protocol/index.js';
