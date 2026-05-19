// Loop cycle skeleton — runs the 8 phases in sequence per spec §1.
//
// Each phase is a thin adapter that delegates to a runcor sibling component. The Loop
// itself owns: phase ordering, exit-condition checks between phases, trace capture, and
// the stop signal handshake.
//
// Day-1 status: phases are STUBS that capture trace entries but don't yet wire to real
// sibling calls. The vertical-slice test will tighten each phase one at a time, in the
// order specified in the spec (loop → substrate → memory → dialectic → ...).

import type {
  Agent,
  AgentState,
  ControlSurface,
  EngagementResult,
  LatticeConfig,
  ObservationStream,
  Phase,
  TraceEntry,
} from '../types.js';
import { PHASES } from '../types.js';
import { computeExit, type ExitReason } from './exit.js';
import { pulse, type PulseResult } from './pulse.js';
import { createSubstrate, type Substrate, type WrappedPrompt } from '../substrate/index.js';
import { createMemory, type Memory, type RecalledMemory } from '../memory/index.js';
import { createDialectic, type Dialectic, type Decision } from '../dialectic/index.js';
import { createTrace, type Trace } from '../trace/index.js';
import { createSelfReview, type SelfReview } from '../review/index.js';
import { createTrainingMode, type TrainingMode } from '../training/index.js';
import { createControlSurfaceApplicator, type ControlSurfaceApplicator, type EffectiveControls } from '../controls/surface.js';
import { createLatticeProtocol, registerPeerMemory, type LatticeProtocol } from '../protocol/index.js';
import { parseInvocation, executeCapability, renderCapabilityCatalog } from '../capabilities/index.js';
import type { ActionInvocation, Capability } from '../types.js';

export class Cycle implements Agent {
  private cycleCount = 0;
  private status: AgentState['status'] = 'running';
  private currentPhase: AgentState['currentPhase'] = 'idle';
  private stopRequested = false;
  private readonly engagementId: string;
  private readonly trace: Trace;
  private controls: ControlSurface;
  private totalCostUsd = 0;
  private totalTokens = { input: 0, output: 0 };
  private startedAt = 0;
  private readonly substrate: Substrate;
  private readonly memory: Memory;
  private readonly dialectic: Dialectic;
  private readonly selfReview: SelfReview;
  private readonly trainingMode: TrainingMode;
  private readonly controlApplicator: ControlSurfaceApplicator;
  private readonly protocol: LatticeProtocol;
  /** Effective controls for the CURRENT cycle (set by apply() at top of each cycle). */
  private effective: EffectiveControls | null = null;
  /** Did we already emit a 'training-mode-active' trace entry? Only fire once per engagement. */
  private trainingNoticeEmitted = false;
  /** Most recent ground() output — judge() needs the same input the agent saw. */
  private lastWrappedPrompt: WrappedPrompt | null = null;
  /** Most recent recall result — decide phase consumes this. */
  private lastRecall: RecalledMemory[] = [];
  /** Most recent decide result — act phase consumes this. */
  private lastDecision: Decision | null = null;
  /** Most recent action invocation — judge + write phases consume this. */
  private lastAction: ActionInvocation | null = null;
  /** Names of all actions invoked in this engagement (for goal completion). */
  private readonly actionsInvoked: string[] = [];
  /** Capabilities available to the agent. */
  private readonly capabilities: Capability[];
  /** Cumulative substrate-flag count (judge non-pass outcomes). Drives substrate-hard-stop. */
  private substrateFlagCount = 0;
  /** Outcomes that escalate to a hard stop once flagCount exceeds the threshold. */
  private readonly HARD_STOP_FLAG_THRESHOLD = 3;

  constructor(private readonly config: LatticeConfig) {
    this.engagementId = `eng-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.controls = { ...config.controls };
    this.capabilities = config.capabilities ?? [];
    this.substrate = createSubstrate(
      config.substrate,
      config.identity.description,
      config.identity.initialClaims ?? [],
    );
    // Training-mode gating: when a TrainingModeConfig is present, route promotions
    // through the candidate cube so external validation is required before long-term.
    const memoryGating: 'direct' | 'candidate' = config.trainingMode ? 'candidate' : 'direct';
    this.memory = createMemory(config.memory, { gating: memoryGating });
    this.dialectic = createDialectic(config.engine, config.controls.dialecticDepth);
    this.trace = createTrace(config.trace);
    this.trace.start(this.engagementId);
    this.selfReview = createSelfReview(
      this.memory,
      this.dialectic,
      config.identity.description,
      () => this.renderGoalContext(),
    );
    this.trainingMode = createTrainingMode(
      config.trainingMode,
      this.memory,
      this.dialectic,
      config.identity.description,
    );
    this.controlApplicator = createControlSurfaceApplicator(this.substrate, this.dialectic, this.trainingMode);
    this.protocol = createLatticeProtocol(config.protocol);
    if (config.protocol) {
      // Register this lattice's memory so same-process peers can bridgeMemory() to it.
      registerPeerMemory(config.protocol.latticeId, this.memory);
      // Publish our trace stream to the registry so peers can subscribeToTrace().
      if (config.protocol.publish?.trace) {
        this.protocol.publishTrace(config.protocol.latticeId, this.observe());
      }
    }
  }

  /** Public access to the underlying LatticeProtocol — Bridge + cross-process tests use this. */
  protocolHandle(): LatticeProtocol {
    return this.protocol;
  }

  async run(): Promise<EngagementResult> {
    this.startedAt = Date.now();
    // Initialize protocol: spin up MCP server (if publish.endpoint set) + connect to peers.
    await this.protocol.initialize(this.memory, this.trace);
    this.emit('observe', 0, { event: 'engagement-started', config: { identity: this.config.identity.description } });
    if (this.trainingMode.isEnabled()) {
      const snap = this.trainingMode.snapshot();
      this.emit('observe', 0, {
        event: 'training-mode-active',
        ...snap,
        effectiveAutonomy: this.trainingMode.effectiveAutonomy(this.controls.autonomy),
      });
      this.trainingNoticeEmitted = true;
    }
    // One-shot warning at cycle 0: dials that can't change mid-flight.
    const staticNotes = this.controlApplicator.staticDialNotes();
    if (staticNotes.length > 0) {
      this.emit('observe', 0, { event: 'static-dial-warning', notes: staticNotes });
    }

    while (this.status === 'running') {
      this.cycleCount += 1;
      // Apply control-surface dials BEFORE phases run, so mid-flight adjust() lands cleanly.
      this.effective = this.controlApplicator.apply(this.controls);
      this.emit('observe', this.cycleCount, {
        event: 'effective-controls',
        autonomy: this.effective.effectiveAutonomy,
        discernmentMode: this.effective.discernmentMode,
        recallBreadth: this.effective.effectiveRecallBreadth,
        dialecticDepth: this.effective.effectiveDialecticDepth,
      });
      for (const phase of PHASES) {
        if (this.stopRequested) {
          this.status = 'stopped';
          break;
        }
        this.currentPhase = phase;
        await this.runPhase(phase);
      }

      if (this.status !== 'running') break;

      const goalsComplete = this.config.goals.completion
        ? this.config.goals.completion({ cycle: this.cycleCount, actionsInvoked: [...this.actionsInvoked], lastAction: this.lastAction })
        : false;
      const exit = computeExit({
        cycle: this.cycleCount,
        budget: this.controls.budget,
        spent: { dollars: this.totalCostUsd, tokens: this.totalTokens.input + this.totalTokens.output },
        elapsedMs: Date.now() - this.startedAt,
        goalsComplete,
        substrateHardStop: this.substrateFlagCount >= this.HARD_STOP_FLAG_THRESHOLD,
      });
      if (exit !== null) {
        this.status = this.exitReasonToStatus(exit);
        this.emit('pulse', this.cycleCount, { exitReason: exit });
        return this.makeResult(exit);
      }

      // Yield to the macrotask queue between cycles so external signals (stop(), timers)
      // can run. Without this, all-stub cycles spin synchronously and starve setTimeout.
      await new Promise<void>((res) => setImmediate(res));
    }

    return this.makeResult('manual-stop');
  }

  stop(): void {
    this.stopRequested = true;
  }

  state(): AgentState {
    const last = this.trace.latest();
    const base: AgentState = {
      engagementId: this.engagementId,
      cycleCount: this.cycleCount,
      currentPhase: this.currentPhase,
      currentGoals: [], // Stub — wired when goals phase is implemented
      budgetRemaining: this.computeBudgetRemaining(),
      status: this.status,
    };
    return last ? { ...base, lastTraceEntry: last } : base;
  }

  observe(): ObservationStream {
    const queue: TraceEntry[] = [];
    // When close() is called mid-await, we resolve the pending promise with null so the
    // iterator can observe the close flag and break, instead of hanging on a promise
    // that will never resolve.
    let resolve: ((entry: TraceEntry | null) => void) | null = null;
    let closed = false;
    const unsubscribe = this.trace.subscribe((entry) => {
      if (closed) return;
      if (resolve) { resolve(entry); resolve = null; } else { queue.push(entry); }
    });
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) { yield queue.shift()!; continue; }
          if (closed) break;
          const next = await new Promise<TraceEntry | null>((res) => { resolve = res; });
          if (next === null) {
            while (queue.length > 0) yield queue.shift()!;
            break;
          }
          yield next;
        }
      },
      close() {
        closed = true;
        unsubscribe();
        if (resolve) { resolve(null); resolve = null; }
      },
    };
  }

  adjust(controls: Partial<ControlSurface>): void {
    this.controls = { ...this.controls, ...controls };
    this.emit('pulse', this.cycleCount, { event: 'controls-adjusted', applied: controls });
  }

  // ─── Phase dispatch ────────────────────────────────────────────────────
  // Each phase is a stub today; implementing each is the per-phase work that
  // follows from the spec's build order.

  private async runPhase(phase: Phase): Promise<void> {
    switch (phase) {
      case 'observe': {
        // Drain peer-protocol inbox (if any) into the cycle's observation.
        const inbox = this.protocol.drainInbox();
        this.emit('observe', this.cycleCount, {
          inboxMessages: inbox.length,
          ...(inbox.length > 0 ? { messagesFrom: inbox.map((m) => m.from) } : {}),
        });
        break;
      }
      case 'ground': {
        // Substrate wraps the per-cycle instruction with laws + identity + reality + goal context.
        // The cycle's "input" is the cycle-prompt; for the skeleton it's a generic instruction.
        // When the act phase is wired, the act prompt will flow through here.
        const goalContext = this.renderGoalContext();
        const wrapped = this.substrate.ground(this.makeCycleInstruction(), {
          engagementId: this.engagementId,
          cycle: this.cycleCount,
          goalContext,
        });
        this.lastWrappedPrompt = wrapped;
        this.emit('ground', this.cycleCount, {
          layers: wrapped.layers,
          systemLength: wrapped.system.length,
        });
        break;
      }
      case 'recall': {
        // Query memory against the current goal context. When goals aren't yet wired,
        // the agent description doubles as the recall query (gives meaningful results
        // even for the day-3 skeleton).
        const query = this.renderGoalContext() || this.config.identity.description;
        const breadth = this.effective?.effectiveRecallBreadth ?? this.controls.memoryRecallBreadth;
        try {
          this.lastRecall = await this.memory.recall(query, breadth);
          this.emit('recall', this.cycleCount, {
            queryLength: query.length,
            recalled: this.lastRecall.length,
            breadth,
            enabled: this.memory.isEnabled(),
          });
        } catch (e) {
          this.lastRecall = [];
          this.emit('recall', this.cycleCount, {
            error: e instanceof Error ? e.message : String(e),
            enabled: this.memory.isEnabled(),
          });
        }
        break;
      }
      case 'decide': {
        // Build the decision problem from recalled memory + goal context. When dialectic is
        // disabled, this still runs (returns a placeholder) so the cycle stays observable.
        const problem = this.makeDecideProblem();
        // Re-read depth dial each cycle so adjust() takes effect mid-flight.
        this.dialectic.setDepth(this.controls.dialecticDepth);
        try {
          this.lastDecision = await this.dialectic.decide({ problem });
          this.totalCostUsd += this.lastDecision.costUsd;
          this.emit('decide', this.cycleCount, {
            enabled: this.lastDecision.enabled,
            rounds: this.lastDecision.rounds,
            converged: this.lastDecision.converged,
            convergenceReason: this.lastDecision.convergenceReason,
            costUsd: this.lastDecision.costUsd,
            answerLength: this.lastDecision.answer.length,
          });
        } catch (e) {
          this.lastDecision = null;
          this.emit('decide', this.cycleCount, {
            error: e instanceof Error ? e.message : String(e),
            enabled: this.dialectic.isEnabled(),
          });
        }
        break;
      }
      case 'act': {
        // Parse the dialectic's decision for an INVOKE directive and execute the matching
        // capability. When no decision text or no INVOKE line is present, the act phase is
        // a no-op for this cycle.
        this.lastAction = null;
        const answer = this.lastDecision?.answer ?? '';
        const parsed = parseInvocation(answer);
        if (!parsed) {
          this.emit('act', this.cycleCount, { invoked: null, reason: 'no INVOKE directive in decision' });
          break;
        }
        const exec = await executeCapability(parsed, this.capabilities, {
          cycle: this.cycleCount,
          engagementId: this.engagementId,
        });
        if (exec.error) {
          this.emit('act', this.cycleCount, { invoked: parsed.name, error: exec.error });
          break;
        }
        this.lastAction = exec.invocation;
        if (exec.invocation) {
          this.actionsInvoked.push(exec.invocation.name);
          this.emit('act', this.cycleCount, {
            invoked: exec.invocation.name,
            argsKeys: Object.keys(exec.invocation.args),
            resultLength: exec.invocation.result.length,
            durationMs: exec.invocation.durationMs,
          });
        }
        break;
      }
      case 'judge': {
        // Judge the agent's actual output for this cycle. When act produced an invocation,
        // the result string is the output under evaluation. Otherwise we judge the decision
        // text (so the discernment gate still gets a meaningful sample even on no-action cycles).
        const input = this.lastWrappedPrompt?.system ?? '';
        const output = this.lastAction?.result ?? this.lastDecision?.answer ?? '(no output this cycle)';
        const verdict = await this.substrate.judge(input, output);
        if (verdict.outcome !== 'pass') {
          this.substrateFlagCount += 1;
        }
        this.emit('judge', this.cycleCount, {
          outcome: verdict.outcome,
          flagCount: this.substrateFlagCount,
          failedChecks: verdict.checks.filter((c) => !c.passed).map((c) => c.law),
        });
        break;
      }
      case 'write': {
        // Persist an episodic event for this cycle + run R9 consolidation (decay + promotion).
        // Content composition: action result when one happened, otherwise the decision text.
        const content = this.lastAction
          ? `Cycle ${this.cycleCount}: invoked ${this.lastAction.name}(${JSON.stringify(this.lastAction.args).slice(0, 200)}). Result: ${this.lastAction.result.slice(0, 500)}`
          : `Cycle ${this.cycleCount}: no action invoked. Decision: ${this.lastDecision?.answer.slice(0, 300) ?? '(none)'}`;
        try {
          const recorded = await this.memory.record(content, { tags: ['episodic', `cycle:${this.cycleCount}`], R: 0.5 });
          const consolidated = await this.memory.cycle(this.cycleCount);
          this.emit('write', this.cycleCount, {
            recordAction: recorded.action,
            nodeId: recorded.nodeId,
            promoted: consolidated.promoted,
            forgotten: consolidated.forgotten,
            enabled: this.memory.isEnabled(),
          });
        } catch (e) {
          this.emit('write', this.cycleCount, {
            error: e instanceof Error ? e.message : String(e),
            enabled: this.memory.isEnabled(),
          });
        }
        break;
      }
      case 'pulse': {
        const pulseResult: PulseResult = pulse({ cycle: this.cycleCount, drivePressure: this.controls.drivePressure });
        this.emit('pulse', this.cycleCount, { ...pulseResult });
        // Self-review cadence: when reviewCadence > 0 and we've completed a multiple of it,
        // run the higher-altitude review against the recent memory window. Emit under the
        // pulse phase tag (Phase is a closed enum; reviews are a between-cycle event).
        const cadence = Math.max(0, this.controls.reviewCadence | 0);
        if (cadence > 0 && this.cycleCount > 0 && this.cycleCount % cadence === 0) {
          try {
            const verdict = await this.selfReview.runReview(this.cycleCount);
            this.totalCostUsd += verdict.costUsd;
            this.emit('pulse', this.cycleCount, {
              event: 'self-review',
              enabled: verdict.enabled,
              costUsd: verdict.costUsd,
              window: verdict.window,
              summary: verdict.summary,
              recommendation: verdict.recommendation,
            });
          } catch (e) {
            this.emit('pulse', this.cycleCount, {
              event: 'self-review-error',
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        // Adversarial review cadence (training-mode only). Independent from self-review.
        if (this.trainingMode.shouldAdversarialReview(this.cycleCount)) {
          try {
            const result = await this.trainingMode.runAdversarialReview(this.cycleCount);
            this.totalCostUsd += result.costUsd;
            this.emit('pulse', this.cycleCount, {
              event: 'adversarial-review',
              enabled: result.enabled,
              examined: result.examined,
              recommendations: result.recommendations,
              costUsd: result.costUsd,
            });
          } catch (e) {
            this.emit('pulse', this.cycleCount, {
              event: 'adversarial-review-error',
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        break;
      }
    }
  }

  private makeCycleInstruction(): string {
    // Skeleton instruction — phases will replace this with prompts derived from recalled
    // memory + dialectic-decided next action when those phases come online.
    return `Cycle ${this.cycleCount}: assess current state and choose next action.`;
  }

  private renderGoalContext(): string {
    if (this.config.goals.initial.length === 0) return '';
    return this.config.goals.initial
      .map((g, i) => `${i + 1}. (${g.level}) ${g.statement}`)
      .join('\n');
  }

  private makeDecideProblem(): string {
    const goal = this.renderGoalContext();
    const recallSummary = this.lastRecall.length > 0
      ? this.lastRecall.map((r) => `- [${r.cube}, M=${r.M.toFixed(2)}] ${r.content.slice(0, 200)}`).join('\n')
      : '(no relevant memory recalled)';
    return [
      `Identity: ${this.config.identity.description}`,
      goal ? `Goals:\n${goal}` : 'Goals: (none configured)',
      `Recalled memory:\n${recallSummary}`,
      renderCapabilityCatalog(this.capabilities),
      `Cycle ${this.cycleCount}: What is the next concrete action this agent should take, and why? End your answer with one INVOKE line per the capability catalog (or omit if no action is needed).`,
    ].join('\n\n');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private emit(phase: Phase, cycle: number, data: Record<string, unknown>): void {
    const entry: TraceEntry = { engagementId: this.engagementId, cycle, phase, ts: Date.now(), data };
    this.trace.capture(entry);
  }

  private computeBudgetRemaining(): AgentState['budgetRemaining'] {
    const b = this.controls.budget;
    const out: AgentState['budgetRemaining'] = {};
    if (typeof b.dollars === 'number') out.dollars = b.dollars - this.totalCostUsd;
    if (typeof b.tokens === 'number') out.tokens = b.tokens - (this.totalTokens.input + this.totalTokens.output);
    if (typeof b.time === 'number') out.time = b.time - (Date.now() - this.startedAt);
    return out;
  }

  private exitReasonToStatus(reason: ExitReason): AgentState['status'] {
    if (reason === 'goal-complete') return 'complete';
    if (reason === 'budget-exhausted') return 'complete';
    if (reason === 'substrate-hard-stop') return 'drifted';
    return 'stopped';
  }

  private makeResult(reason: ExitReason): EngagementResult {
    const result: EngagementResult = {
      engagementId: this.engagementId,
      exitReason: reason,
      cyclesRun: this.cycleCount,
      totalCostUsd: this.totalCostUsd,
      totalTokens: this.totalTokens,
      durationMs: Date.now() - this.startedAt,
      finalState: this.state(),
      tracePath: this.trace.path(),
    };
    this.trace.end(result);
    // Best-effort protocol shutdown — don't let MCP server errors fail the engagement result.
    void this.protocol.shutdown().catch(() => {});
    return result;
  }
}
