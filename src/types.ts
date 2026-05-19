// Core types — verbatim from runcor-lattice-build-spec.md
//
// Many fields are typed as `unknown` for now and tightened as each phase is implemented.
// The spec's interfaces are the contract; this file is the single source of truth that
// every other file in the lattice imports from.

// ─── Configuration (passed at instantiation) ────────────────────────────────

export interface LatticeConfig {
  identity: IdentityConfig;
  substrate: SubstrateConfig;
  memory: MemoryConfig;
  goals: GoalConfig;
  drives: DriveConfig;
  engine: EngineRef;
  controls: ControlSurface;
  trace?: TraceConfig;
  trainingMode?: boolean;
  reviewCycle?: { everyNCycles: number };
  protocol?: LatticeProtocolConfig;
}

export interface TraceConfig {
  /** Directory to write JSONL trace files into. Omit for in-memory-only (testing, smoke runs). */
  dir?: string;
  /** Soft cap on in-memory buffer size. When exceeded, oldest entries are flushed/dropped. Default: 10_000. */
  memoryBufferCap?: number;
}

export interface IdentityConfig {
  /** Free-text "who is this agent" — e.g. "Application security analyst" */
  description: string;
  /** Optional pre-loaded SelfTheory claims (e.g. inherited from a trained lattice). */
  initialClaims?: string[];
}

export interface SubstrateConfig {
  /** Laws are declarative rules compiled into every prompt (max ~120 tokens total). */
  laws: string[];
  /** Reality slice provider — substrate calls this each cycle to read current world state. */
  realitySource?: 'data-cube' | 'none';
  /** Discernment gate strictness. 'permissive' allows borderline outputs through with flags. */
  discernmentMode?: 'strict' | 'permissive';
}

export interface MemoryConfig {
  /** Path on disk for the SQLite DB. Required — memory MUST persist. */
  dbPath: string;
  /** Tau (base decay constant) in M = R·ln(f+1)·e^(-t/(τD)). Defaults defined by runcor-memory. */
  tau?: number;
  /** D depth multiplier for promotion gating. */
  depth?: number;
  /** OpenAI key for embeddings (memory uses text-embedding-3-small). */
  openaiKey?: string;
}

export interface GoalConfig {
  /** Initial goals seeded at instantiation. Empty array = lattice discovers its own. */
  initial: Array<{ statement: string; level: 'purpose' | 'objective' | 'initiative' }>;
  /** Completion predicate. When this returns true, the loop exits cleanly. */
  completion?: (state: AgentState) => boolean;
  /** Persistence path. */
  dbPath: string;
}

export interface DriveConfig {
  /** Budget caps that trigger drive pressure. */
  budget?: { tokens?: number; dollars?: number; time?: number };
  /** Custom drive function weighting. Defaults to runcor-drives defaults. */
  weights?: { resource?: number; curiosity?: number; reactivity?: number; coherence?: number };
}

export interface EngineRef {
  /** Where the engine receives LLM calls. Defaults to runcor's built-in modelRouter. */
  type: 'runcor-engine';
  /** Provider API keys (passed through to runcor-dialectic adapters). */
  apiKeys: { openrouter?: string; anthropic?: string; openai?: string };
}

// ─── Control surface (the runtime dials) ────────────────────────────────────

export interface ControlSurface {
  autonomy: number;
  exploration: number;
  memoryDurability: { tau: number; D: number };
  promotionThreshold: number;
  dialecticDepth: 'shallow' | 'medium' | 'deep';
  reviewCadence: number;
  drivePressure: number;
  riskTolerance: number;
  planStability: number;
  memoryRecallBreadth: number;
  budget: { tokens?: number; dollars?: number; time?: number };
}

// ─── Agent (returned by Loop.instantiate) ────────────────────────────────────

export interface Agent {
  /** Drive the cycle until an exit condition fires. */
  run(): Promise<EngagementResult>;
  /** Halt at the next safe boundary (between phases). */
  stop(): void;
  /** Snapshot of cycle state — for Bridge inspection. */
  state(): AgentState;
  /** Live trace stream — Bridge subscribes here. */
  observe(): ObservationStream;
  /** Mid-flight dial adjustment. */
  adjust(controls: Partial<ControlSurface>): void;
}

export interface AgentState {
  engagementId: string;
  cycleCount: number;
  currentPhase: Phase | 'idle';
  currentGoals: Array<{ statement: string; level: string; status: 'open' | 'satisfied' }>;
  budgetRemaining: { tokens?: number; dollars?: number; time?: number };
  lastTraceEntry?: TraceEntry;
  status: 'running' | 'paused' | 'complete' | 'drifted' | 'stopped';
}

// ─── The cycle's 8 phases ───────────────────────────────────────────────────

export type Phase =
  | 'observe'
  | 'ground'
  | 'recall'
  | 'decide'
  | 'act'
  | 'judge'
  | 'write'
  | 'pulse';

export const PHASES: readonly Phase[] = ['observe', 'ground', 'recall', 'decide', 'act', 'judge', 'write', 'pulse'] as const;

// ─── Trace (cross-cutting reasoning provenance) ─────────────────────────────

export interface TraceEntry {
  engagementId: string;
  cycle: number;
  phase: Phase;
  ts: number;
  data: Record<string, unknown>;
}

export interface ObservationStream {
  /** Async iterator yielding trace entries as the cycle runs. */
  [Symbol.asyncIterator](): AsyncIterator<TraceEntry>;
  close(): void;
}

export interface EngagementResult {
  engagementId: string;
  exitReason: 'goal-complete' | 'budget-exhausted' | 'substrate-hard-stop' | 'manual-stop';
  cyclesRun: number;
  totalCostUsd: number;
  totalTokens: { input: number; output: number };
  durationMs: number;
  finalState: AgentState;
  tracePath: string;
}

// ─── Lattice protocol (peer-to-peer) ────────────────────────────────────────
// Per memory note: knowledge sources AND inter-lattice peering both go through MCP.
// The spec's LatticeProtocol interface is the OUTSIDE surface; internally each capability
// will be implemented over runcor-integration's MCP adapter.

export interface LatticeProtocolConfig {
  /** This lattice's published identity for peers to address. */
  latticeId: string;
  /** MCP endpoints this lattice exposes (trace, memory-bridge, message channels). */
  publish?: { trace?: boolean; memory?: boolean; messages?: boolean };
  /** MCP endpoints this lattice subscribes to from other lattices. */
  subscriptions?: Array<{ latticeId: string; resource: 'trace' | 'memory' | 'messages' }>;
}
