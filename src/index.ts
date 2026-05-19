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
  Agent,
  AgentState,
  ControlSurface,
  DriveConfig,
  EngagementResult,
  EngineRef,
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
} from './types.js';

export { PHASES } from './types.js';
