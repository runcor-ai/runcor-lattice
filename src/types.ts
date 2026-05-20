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
  capabilities?: Capability[];
  /** Knowledge bundles surfaced to the agent in every cycle's decide prompt.
   *  Mutable at runtime via `Cycle.setKnowledge(bundles)` so the Bridge can
   *  attach/detach bundles mid-engagement. */
  knowledgeBundles?: KnowledgeBundleInput[];
  trace?: TraceConfig;
  trainingMode?: TrainingModeConfig;
  reviewCycle?: { everyNCycles: number };
  protocol?: LatticeProtocolConfig;
}

export interface KnowledgeBundleInput {
  name: string;
  content: string;
  /** Optional one-line description shown before the content. */
  description?: string;
}

/** A capability the agent can invoke during the act phase. */
export interface Capability {
  /** Short identifier — invoked by the agent as `INVOKE: <name> {args json}`. */
  name: string;
  /** What the capability does + arg shape — shown to the agent in the decide phase. */
  description: string;
  /** Implementation. Returns a string summary the agent sees as the action's result. */
  handler: (args: Record<string, unknown>, ctx: CapabilityContext) => Promise<string>;
}

export interface CapabilityContext {
  cycle: number;
  engagementId: string;
}

/** Captured invocation produced by the act phase. */
export interface ActionInvocation {
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

export interface TrainingModeConfig {
  /** How many engagements must have been externally validated for cold-start humility to lift. */
  validatedEngagementsRequired: number;
  /** How many validated engagements have already completed before THIS engagement. */
  priorValidatedEngagements: number;
  /** Autonomy ceiling while cold-start is active (0..1). configured autonomy is clamped to this. */
  coldStartAutonomyCap: number;
  /** Cycles between adversarial reviews (0 = disabled). Independent of self-review cadence. */
  adversarialReviewCadence: number;
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
  /** SQLite path for the SelfTheory store. Omit for ephemeral / disabled. */
  dbPath?: string;
  /** Cycles between dialectic-driven reflective updates as a periodic cadence.
   *  0 disables the cadence trigger. Default 20. Reflection ALSO fires on the
   *  event-driven trigger below regardless of cadence. */
  reflectEvery?: number;
  /** When true (default), an operator-injected prompt triggers an identity
   *  reflection on the same cycle, independent of `reflectEvery`. This captures
   *  how the agent's SelfTheory adapts to each external pivot — long-horizon
   *  coherence depends on this signal, not on arbitrary cycle-count cadences. */
  reflectOnOperatorInject?: boolean;
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
  completion?: (state: GoalCompletionContext) => boolean;
  /** Persistence path — ':memory:' or omit disables runcor-goals (uses seeded initial only). */
  dbPath: string;
  /** Cycles between dialectic-driven proposal rounds. 0 disables. Default 10. */
  proposeEvery?: number;
}

export interface GoalCompletionContext {
  cycle: number;
  /** Names of actions invoked across the engagement so far. */
  actionsInvoked: string[];
  /** Most recent action invocation. */
  lastAction: ActionInvocation | null;
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
  /** Provider API keys (passed through to runcor-dialectic adapters when no `instance` is set). */
  apiKeys: { openrouter?: string; anthropic?: string; openai?: string };
  /** Optional live runcor engine instance. When set, every dialectic model call routes
   *  through this engine — cost ledger, provider fallback, telemetry, and policy gates
   *  apply automatically. When omitted, the lattice falls back to the standalone
   *  runcor-dialectic provider adapters (direct OpenRouter / Anthropic fetch).
   *  Typed as `unknown` here so the lattice's type surface doesn't depend on `runcor`
   *  symbols at the type level — the dialectic adapter casts when registering. */
  instance?: unknown;
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
  /** Optional per-role model overrides for the Player/Coach/Judge dialectic.
   *  When omitted, runcor-dialectic's canonical defaults apply
   *  (Player: nemotron-120b, Coach: qwen3-32b, Judge: llama-3.1-8b). */
  dialecticModels?: { player?: string; coach?: string; judge?: string };
}

/** Canonical defaults from runcor-dialectic — exposed so consumers (Bridge UI) can show
 *  what the "default" actually resolves to without importing runcor-dialectic. */
export const DEFAULT_DIALECTIC_MODELS = {
  player: 'openrouter/nvidia/nemotron-3-super-120b-a12b',
  coach: 'openrouter/qwen/qwen3-32b',
  judge: 'openrouter/meta-llama/llama-3.1-8b-instruct',
} as const;

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
  /** MCP endpoints this lattice exposes (trace, memory-bridge, message channels).
   *  When `endpoint` is set, the lattice spins up an HTTP MCP server on that port. */
  publish?: {
    trace?: boolean;
    memory?: boolean;
    messages?: boolean;
    /** TCP port for the HTTP MCP server. When omitted, server runs in-process only. */
    endpoint?: number;
  };
  /** Peer lattices this one will discover at boot. Each subscription either references a
   *  same-process peer by latticeId (in-process registry) OR a remote URL (HTTP MCP). */
  subscriptions?: Array<{
    latticeId: string;
    /** Resource being subscribed. Currently only 'memory' + 'messages' are wired through MCP;
     *  'trace' uses the in-process ObservationStream until trace.subscribe is exposed via MCP. */
    resource: 'trace' | 'memory' | 'messages';
    /** Cross-process: full MCP endpoint URL (e.g. http://host:7301/mcp). When omitted,
     *  the in-process registry is the source. */
    url?: string;
  }>;
}
