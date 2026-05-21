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
import { createIdentity, reflectIdentity, type Identity, type SelfTheorySnapshot } from '../identity/index.js';
import { createGoalsAdapter, proposeGoalsViaDialectic, type GoalsAdapter, type GoalSnapshot } from '../goals/index.js';

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => pad + line).join('\n');
}

function escapeOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

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
  private readonly identity: Identity;
  /** Snapshot of the most recent identity reflection — exposed via state() + Bridge. */
  private lastIdentitySnapshot: SelfTheorySnapshot | null = null;
  private readonly goals: GoalsAdapter;
  /** Track recent invocations for identity.reflect() input. */
  private readonly recentInvocations: ActionInvocation[] = [];
  /** Operator-injected prompts queued by injectPrompt() — drained into the next cycle. */
  private readonly injectedPrompts: string[] = [];
  /** Mutable knowledge bundles surfaced to every cycle's decide prompt. */
  private knowledgeBundles: Array<{ name: string; content: string; description?: string }> = [];
  /** Cumulative substrate-flag count (judge non-pass outcomes). Drives substrate-hard-stop. */
  private substrateFlagCount = 0;
  /** When the engine path is in use, the executionId of the currently-running
   *  phase flow. stop() calls engine.cancel(currentExecutionId) so an in-flight
   *  LLM call aborts immediately rather than waiting for the phase to finish. */
  private currentExecutionId: string | null = null;
  /** Set true when the most-recent decide phase consumed an operator-injected
   *  prompt. Cleared after pulse runs. The pulse phase fires an event-driven
   *  identity reflection whenever this is true, so the agent's SelfTheory
   *  captures how it responds to each operator pivot — independent of the
   *  fixed `reflectEvery` cadence which would never fire on short engagements. */
  private operatorInjectThisCycle = false;
  /** Cycles remaining in the operator-injection transition window. Set to
   *  TRANSITION_WINDOW_CYCLES when an operator inject is consumed; substrate
   *  non-pass verdicts during the window don't accumulate toward hard-stop.
   *  The window represents "expected adjustment period after external pivot" —
   *  the agent legitimately needs cycles to integrate new priorities, and that
   *  integration is NOT the same as internal drift. */
  private operatorTransitionCounter = 0;
  /** Cycles of post-inject grace where substrate non-pass verdicts log but
   *  don't increment substrateFlagCount. Default 3 = one cycle to absorb the
   *  inject + two to integrate into goals/responses. */
  private readonly TRANSITION_WINDOW_CYCLES = 3;
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
    this.dialectic = createDialectic(config.engine, config.controls.dialecticDepth, config.controls.dialecticModels);
    this.identity = createIdentity(config.identity, config.identity.dbPath, this.dialectic);
    this.lastIdentitySnapshot = this.identity.current();
    this.goals = createGoalsAdapter(config.goals, this.dialectic);
    if (config.knowledgeBundles) {
      this.knowledgeBundles = config.knowledgeBundles.map((b) => {
        const out: { name: string; content: string; description?: string } = { name: b.name, content: b.content };
        if (b.description !== undefined) out.description = b.description;
        return out;
      });
    }
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

  /** Underlying adapters — Bridge inspector pulls per-lattice data through these. */
  memoryHandle(): Memory { return this.memory; }
  identityHandle(): Identity { return this.identity; }
  goalsHandle(): GoalsAdapter { return this.goals; }
  /** Mid-flight prompt injection — operator nudge that prepends to the next cycle's prompt. */
  injectPrompt(text: string): void {
    if (text) this.injectedPrompts.push(text);
  }
  /** Replace the knowledge bundle set. Bridge calls this when bundles are attached/detached. */
  setKnowledge(bundles: Array<{ name: string; content: string; description?: string }>): void {
    this.knowledgeBundles = bundles.map((b) => {
      const out: { name: string; content: string; description?: string } = { name: b.name, content: b.content };
      if (b.description !== undefined) out.description = b.description;
      return out;
    });
  }
  knowledgeSummary(): Array<{ name: string; chars: number }> {
    return this.knowledgeBundles.map((b) => ({ name: b.name, chars: b.content.length }));
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
    // When the engine path is in use AND a phase execution is in-flight,
    // cancel it so in-flight LLM calls abort immediately instead of waiting
    // for the phase to finish. cycle.ts's runPhase treats a cancelled
    // execution as a graceful resolve (not a throw) so the cycle loop sees
    // status===stopped at the next phase boundary check.
    const engine = this.config.engine.instance as { cancel: (id: string, reason?: string) => Promise<void> } | undefined;
    if (engine && this.currentExecutionId) {
      const execId = this.currentExecutionId;
      void engine.cancel(execId, 'agent.stop()').catch(() => { /* best-effort */ });
    }
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

  /** Phase dispatch — when an engine is wired, every phase runs inside an engine
   *  flow execution so it gets an idempotency key, a cost-ledger slice, an OTel
   *  span, policy gates, and crash-resume. When no engine is wired, falls back
   *  to direct in-process dispatch. */
  private async runPhase(phase: Phase): Promise<void> {
    const engine = this.config.engine.instance as { trigger: (n: string, o: { idempotencyKey: string; input: unknown }) => Promise<{ id: string; state: string; error?: { message?: string } }> } | undefined;
    if (engine) {
      // Resolve the per-engine state machinery (active-cycle map + dispatch flow)
      // lazily so importing the lattice library doesn't require the engine type.
      const { activeCycles, ensureRunPhaseFlow } = await import('./engine-flows.js');
      ensureRunPhaseFlow(this.config.engine.instance);
      activeCycles.set(this.engagementId, this);
      const execution = await engine.trigger('lattice.runPhase', {
        idempotencyKey: `${this.engagementId}-cycle-${this.cycleCount}-${phase}`,
        input: { engagementId: this.engagementId, phase },
      });
      // Track the live executionId so stop() can cancel it mid-flight.
      this.currentExecutionId = execution.id;
      try {
        if (execution.state === 'queued' || execution.state === 'running' || execution.state === 'waiting' || execution.state === 'retrying') {
          // Trigger returns the queued execution; the actual completion is signaled
          // via the engine's 'execution:complete' event. Wait for it.
          await new Promise<void>((resolve, reject) => {
            const e = this.config.engine.instance as { on: (event: string, cb: (e: { executionId: string }) => void) => void; off: (event: string, cb: (e: { executionId: string }) => void) => void; getExecution: (id: string) => Promise<{ state: string; error?: { message?: string } } | null> };
            const onComplete = (event: { executionId: string }): void => {
              if (event.executionId !== execution.id) return;
              e.off('execution:complete', onComplete);
              void e.getExecution(execution.id).then((finalExec) => {
                if (!finalExec) return reject(new Error(`engine execution ${execution.id} not found`));
                if (finalExec.state === 'complete') return resolve();
                if (finalExec.state === 'failed' && finalExec.error?.message?.includes('cancelled')) return resolve(); // graceful stop
                reject(new Error(`lattice.runPhase(${phase}) ended in state "${finalExec.state}": ${finalExec.error?.message ?? '<no error>'}`));
              });
            };
            e.on('execution:complete', onComplete);
          });
        } else if (execution.state !== 'complete') {
          throw new Error(`lattice.runPhase(${phase}) returned unexpected state "${execution.state}": ${execution.error?.message ?? '<no error>'}`);
        }
      } finally {
        this.currentExecutionId = null;
      }
      return;
    }
    await this.runPhaseDirect(phase);
  }

  /** Phase body — the actual work for each phase. Engine path calls this via a
   *  registered flow handler; non-engine path calls it directly. Public so the
   *  engine-flows module can invoke it from within the flow handler context. */
  async runPhaseDirect(phase: Phase): Promise<void> {
    switch (phase) {
      case 'observe': {
        // Drain peer-protocol inbox (if any) into the cycle's observation.
        const inbox = this.protocol.drainInbox();
        this.emit('observe', this.cycleCount, {
          inboxMessages: inbox.length,
          ...(inbox.length > 0 ? {
            messagesFrom: inbox.map((m) => m.from),
            messages: inbox.map((m) => ({ from: m.from, text: m.text.slice(0, 500), ts: m.ts })),
          } : {}),
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
            // Show the actual recalled content (truncated per node) for trace inspection
            nodes: this.lastRecall.slice(0, 5).map((n) => ({
              cube: n.cube,
              M: Number(n.M.toFixed(3)),
              similarity: Number(n.similarity.toFixed(3)),
              preview: truncate(n.content, 200),
            })),
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
        this.dialectic.setDepth(this.controls.dialecticDepth);
        try {
          // Build a deterministic validator from any "PROHIBITED" rules in
          // the attached knowledge bundles. The dialectic enforces violations
          // by feeding them to the Coach so the Player is forced to revise
          // until clean. Catches char-level rules (no `!`, no `—`) that LLMs
          // routinely slip past prose-level CONSTRAINTs.
          const validators = this.buildBundleValidators();
          this.lastDecision = await this.dialectic.decide({
            problem,
            ...(validators.length > 0 ? { validators } : {}),
          });
          this.totalCostUsd += this.lastDecision.costUsd;
          this.emit('decide', this.cycleCount, {
            enabled: this.lastDecision.enabled,
            rounds: this.lastDecision.rounds,
            converged: this.lastDecision.converged,
            convergenceReason: this.lastDecision.convergenceReason,
            costUsd: this.lastDecision.costUsd,
            costByRole: this.lastDecision.costByRole,
            answerLength: this.lastDecision.answer.length,
            // 1200 was too short — CFO calculations with show-your-work would truncate
            // before the final total. 3000 was the next attempt — still too short for
            // HTML deliverables (web-design lattice produces 7K+ char landing pages).
            // 32000 covers most full-artifact outputs (long-form HTML, structured docs,
            // multi-section reports) without bloating the JSONL more than necessary.
            // Downstream consumers that need bounded preview can still slice() the
            // answerPreview field locally.
            answerPreview: truncate(this.lastDecision.answer, 32000),
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
          this.recentInvocations.push(exec.invocation);
          if (this.recentInvocations.length > 20) this.recentInvocations.shift();
          this.emit('act', this.cycleCount, {
            invoked: exec.invocation.name,
            argsKeys: Object.keys(exec.invocation.args),
            args: exec.invocation.args, // Full args for inspection (typically small JSON)
            resultLength: exec.invocation.result.length,
            resultPreview: truncate(exec.invocation.result, 800),
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
        // Two architectural mechanisms keep flagCount from spuriously tripping
        // hard-stop on long engagements with legitimate transient turbulence:
        //   (1) post-inject transition window — non-pass verdicts during the
        //       N cycles following an operator pivot are logged but don't count
        //       (the agent is integrating new priorities, not drifting)
        //   (2) pass-verdict decay — a pass cycle drops the count by 1, so an
        //       agent that recovers naturally clears its slate
        const inTransitionWindow = this.operatorTransitionCounter > 0;
        if (verdict.outcome !== 'pass') {
          if (!inTransitionWindow) {
            this.substrateFlagCount += 1;
          }
        } else if (this.substrateFlagCount > 0) {
          this.substrateFlagCount = Math.max(0, this.substrateFlagCount - 1);
        }
        // Tick down the transition counter regardless of verdict.
        if (this.operatorTransitionCounter > 0) {
          this.operatorTransitionCounter -= 1;
        }
        this.emit('judge', this.cycleCount, {
          outcome: verdict.outcome,
          flagCount: this.substrateFlagCount,
          failedChecks: verdict.checks.filter((c) => !c.passed).map((c) => c.law),
          ...(inTransitionWindow ? { transitionWindow: true } : {}),
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
            contentPreview: truncate(content, 400),
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
        // Goal decay every cycle so accepted goals slowly lose intensity and retire.
        if (this.goals.isEnabled()) {
          try {
            const decay = this.goals.decayStep(this.cycleCount);
            if (decay.retiredThisStep > 0) {
              this.emit('pulse', this.cycleCount, { event: 'goals-decayed', retired: decay.retiredThisStep, activeBefore: decay.activeBefore });
            }
          } catch { /* non-fatal */ }
        }
        // Goal proposal cadence — dialectic-driven new initiatives.
        const proposeEvery = this.config.goals.proposeEvery ?? 10;
        if (this.goals.isEnabled() && proposeEvery > 0 && this.cycleCount > 0 && this.cycleCount % proposeEvery === 0) {
          try {
            const recentNames = this.recentInvocations.map((a) => a.name);
            const accepted = await proposeGoalsViaDialectic(this.goals, this.dialectic, this.cycleCount, recentNames, this.renderGoalContext());
            if (accepted > 0) {
              this.emit('pulse', this.cycleCount, { event: 'goals-proposed', accepted });
            }
          } catch (e) {
            this.emit('pulse', this.cycleCount, { event: 'goals-propose-error', error: e instanceof Error ? e.message : String(e) });
          }
        }
        // Identity reflection — triggers are either CADENCE (every N cycles per
        // identity.reflectEvery, default 20) or EVENT-DRIVEN (any operator-injected
        // prompt in the just-completed decide phase). The event-driven trigger
        // captures how the agent's SelfTheory adapts to each operator pivot —
        // critical for long-horizon coherence checks where the cadence may never
        // be reached on short engagements OR where the value of reflection is
        // tied to specific external pressure points, not arbitrary cycle counts.
        const reflectEvery = this.config.identity.reflectEvery ?? 20;
        const cadenceFire = reflectEvery > 0 && this.cycleCount > 0 && this.cycleCount % reflectEvery === 0;
        const eventFire = this.operatorInjectThisCycle && (this.config.identity.reflectOnOperatorInject ?? true);
        // Consume the marker so it doesn't carry into the next cycle.
        this.operatorInjectThisCycle = false;
        if (this.identity.isEnabled() && (cadenceFire || eventFire)) {
          try {
            const snap = await reflectIdentity(this.identity, this.dialectic, this.cycleCount, this.recentInvocations, this.renderGoalContext());
            this.lastIdentitySnapshot = snap;
            this.emit('pulse', this.cycleCount, {
              event: 'identity-reflected',
              version: snap.version,
              claims: snap.claims,
              traitsKeys: Object.keys(snap.traits),
              trigger: cadenceFire ? 'cadence' : 'operator-inject',
            });
          } catch (e) {
            this.emit('pulse', this.cycleCount, { event: 'identity-reflect-error', error: e instanceof Error ? e.message : String(e) });
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
    return `Cycle ${this.cycleCount}: assess current state and choose next action.`;
  }

  /** Build deterministic post-draft validators from attached knowledge bundles.
   *  Scans each bundle for "PROHIBITED" sections and extracts banned substrings.
   *  Returns a list of validator functions; each takes a Player draft and
   *  returns specific violation messages. Empty result when no bundle has
   *  prohibition rules — no overhead added to runs that don't need this. */
  private buildBundleValidators(): Array<(draft: string) => string[]> {
    const banned = new Set<string>();
    for (const b of this.knowledgeBundles) {
      // Find the "PROHIBITED" / "PROHIBITED:" / "BANNED" section header and
      // collect lines below it up to the next blank-line-followed-by-heading.
      const lines = b.content.split('\n');
      let inProhib = false;
      for (const raw of lines) {
        const line = raw.trim();
        if (/^(PROHIBITED|BANNED)\b/i.test(line)) { inProhib = true; continue; }
        if (inProhib && /^(PREFERRED|REQUIRED|ALLOWED|---)\b/i.test(line)) { inProhib = false; continue; }
        if (!inProhib) continue;
        // Bullet items: "- foo" or "* foo" or numbered. Extract parenthesized
        // single chars like "(! anywhere ...)" and "(—)" — those are explicit
        // char rules. Also extract quoted phrases throughout the line.
        if (/^[-*•]\s/.test(line) || /^\d+[.)]\s/.test(line) || /^Phrases?:/i.test(line)) {
          // Parenthesized single chars (1-2 chars not common in english prose)
          const parens = line.match(/\(([^)]+)\)/g) ?? [];
          for (const p of parens) {
            const inside = p.slice(1, -1).split(/\s/)[0];
            if (inside && inside.length <= 3 && !/[a-zA-Z0-9]/.test(inside)) banned.add(inside);
          }
          // Explicit single-char mentions like "Exclamation marks (!)" or
          // "Em-dashes (—)" — extract the literal char
          const charMatch = line.match(/[—!]/g);
          if (charMatch) for (const c of charMatch) banned.add(c);
          // Quoted phrases: "game-changer", 'synergy', etc.
          const quoted = line.match(/["']([^"']+)["']/g) ?? [];
          for (const q of quoted) banned.add(q.slice(1, -1).toLowerCase());
        }
      }
    }
    if (banned.size === 0) return [];
    const bannedList = [...banned];
    return [(draft: string): string[] => {
      const violations: string[] = [];
      const lower = draft.toLowerCase();
      for (const b of bannedList) {
        // Char-level: exact substring match (case-insensitive for phrases)
        const target = b.length === 1 ? b : b.toLowerCase();
        const haystack = b.length === 1 ? draft : lower;
        if (haystack.includes(target)) {
          violations.push(`Output contains prohibited substring "${b}" — remove all instances. If "${b}" is "!" replace with "."; if "—" replace with comma or parentheses; if a banned phrase, rewrite to avoid it.`);
        }
      }
      return violations;
    }];
  }

  private renderGoalContext(): string {
    // Prefer the LIVE goals stack (post-decay, post-propose). Fall back to initial config
    // if the goals adapter is disabled.
    const stack = this.goals.stack(this.cycleCount);
    if (stack.length > 0) {
      return stack.map((g, i) => `${i + 1}. (${g.level}, intensity=${g.intensity.toFixed(2)}) ${g.text}`).join('\n');
    }
    if (this.config.goals.initial.length === 0) return '';
    return this.config.goals.initial
      .map((g, i) => `${i + 1}. (${g.level}) ${g.statement}`)
      .join('\n');
  }

  /** Build the decide-phase user message as an R++ v0.5 document.
   *
   *  R++ keeps the per-cycle framing consistent across rounds. Earlier prose
   *  assemblies leaked meta-narration into deliverables (CHECKLIST inside the
   *  Player's system prompt is the enforcement gate that catches "here is the
   *  revised version" preambles). See runcor-ai/rpp-parser for the language
   *  reference. */
  private makeDecideProblem(): string {
    const injectedRaw = this.injectedPrompts.splice(0);
    const hasInjected = injectedRaw.length > 0;
    if (hasInjected) {
      this.operatorInjectThisCycle = true;
      // Open a transition window so the substrate's drift detector doesn't
      // mistake the agent's re-orientation work for internal drift.
      this.operatorTransitionCounter = this.TRANSITION_WINDOW_CYCLES;
    }
    const operatorMessage = injectedRaw.join('\n\n---\n\n');

    if (hasInjected) {
      return this.rppOperatorRequest(operatorMessage);
    }
    return this.rppAutonomousAction();
  }

  // ─── R++ document builders ────────────────────────────────────────────────

  private rppOperatorRequest(operatorMessage: string): string {
    return `# Cycle ${this.cycleCount} — operator request

TARGET {
  output: the deliverable the operator requested, in the exact format the operator specified
  profile: lattice-cycle-operator-request
}

${this.rppDataBlock(operatorMessage)}

BEHAVIOR Respond {
  CONSTRAINT: the operator_message is a LIVE instruction; standing goals + identity describe long-running background priorities; when they conflict, the operator_message wins for this cycle
  CONSTRAINT: produce the operator_message's deliverable in the format the operator specified
  CONSTRAINT: when the operator gives specific parameters (numbers, names, quantities), USE THOSE PARAMETERS — do not ask for "additional data" or "validation" before computing; the knowledge_bundles plus the operator's parameters are sufficient
  CONSTRAINT: do not pivot the operator's request into a standing-goals review (e.g. operator asks "what is X for these inputs?" → answer X for those inputs; do not redirect to "we should first audit Y")
  CONSTRAINT: do not include preamble (no "here is", "we need to", "I will now", "after considering the criticisms")
  CONSTRAINT: do not include meta-headers (no "Analysis", "Response", "Output", "Accepted criticisms", "Revised analysis") wrapping the deliverable
  CONSTRAINT: do not wrap the deliverable in a JSON envelope (no \`{"output": "..."}\`); the deliverable IS the output text directly
  CONSTRAINT: when the answer comes from a knowledge_bundle, quote the supporting line directly inside the deliverable — do not narrate the consultation process
  CONSTRAINT: optionally end with one "NEXT: <one follow-up action>" line after the deliverable
  CONSTRAINT: when a capability call is needed, end with one "INVOKE <capability>" line per the capability catalog
}

CHECKLIST {
  [ ] the deliverable answers the operator_message's actual question using the parameters the operator gave
  [ ] no pivot to standing-goals review when the operator asked a specific question
  [ ] output begins with the deliverable itself, not with a header or preamble phrase
  [ ] output is plain text in the operator's specified format, NOT wrapped in a JSON envelope
  [ ] output format matches the operator_message's specified format (post→post, number→number, HTML→HTML, recommendation→recommendation)
  [ ] knowledge_bundle citations appear as direct quotes inside the deliverable, not as consultation narration
  [ ] at most one NEXT: line, only if a meaningful follow-up exists
  [ ] at most one INVOKE line, well-formed per the capability catalog if present
}`;
  }

  private rppAutonomousAction(): string {
    return `# Cycle ${this.cycleCount} — autonomous step

TARGET {
  output: a single concrete next action with a one-paragraph rationale
  profile: lattice-cycle-autonomous
}

${this.rppDataBlock(null)}

BEHAVIOR Decide {
  CONSTRAINT: choose ONE concrete next action grounded in identity, goals, or recalled_memory
  CONSTRAINT: state the action first, then the rationale in at most one paragraph
  CONSTRAINT: end with one "INVOKE <capability>" line per the capability catalog when an action is needed; omit INVOKE when no capability call is appropriate
}

CHECKLIST {
  [ ] output identifies one concrete next action, not a survey of options
  [ ] rationale references identity, goals, or recalled_memory by name
  [ ] INVOKE line, when present, matches a capability from the catalog
}`;
  }

  /** Assemble the shared DATA block (identity, knowledge bundles, goals, recall,
   *  capability catalog, and — when an operator message is present — the
   *  operator_message field). All long values are nested-indented per R++. */
  private rppDataBlock(operatorMessage: string | null): string {
    const idSnap = this.lastIdentitySnapshot;
    const identityFields = idSnap && idSnap.claims.length > 0
      ? `  identity_version: v${idSnap.version}
  identity_claims:
${idSnap.claims.map((c) => '    - ' + c).join('\n')}`
      : `  identity_description: ${escapeOneLine(this.config.identity.description)}`;

    const bundlesBlock = this.knowledgeBundles.length > 0
      ? `  knowledge_bundles (authoritative — consult before answering):
${this.knowledgeBundles
        .map((b) => `    ═══ ${b.name}${b.description ? ` (${b.description})` : ''} ═══
${indentLines(b.content, 4)}`)
        .join('\n\n')}`
      : `  knowledge_bundles: (none attached)`;

    const goalText = this.renderGoalContext();
    const goalsBlock = goalText
      ? `  goals:
${indentLines(goalText, 4)}`
      : `  goals: (none configured)`;

    const recallBlock = this.lastRecall.length > 0
      ? `  recalled_memory:
${this.lastRecall.map((r) => `    - [${r.cube}, M=${r.M.toFixed(2)}] ${r.content.slice(0, 200)}`).join('\n')}`
      : `  recalled_memory: (no relevant memory recalled)`;

    const catalog = renderCapabilityCatalog(this.capabilities);
    const capabilitiesBlock = catalog
      ? `  capabilities:
${indentLines(catalog, 4)}`
      : `  capabilities: (none registered)`;

    // When the operator has injected a message, it leads the DATA block. The model
    // sees the live instruction FIRST, before standing identity / goals / recall.
    // Earlier ordering buried operator_message at the bottom, after goals — which
    // let the agent frame the operator's request through its standing goals lens
    // (e.g. CFO asked a pricing question, pivoted to "let me review our burn rate
    // first" because burn-rate was a standing goal it saw before the operator
    // message).
    const operatorBlock = operatorMessage !== null
      ? `  operator_message (LIVE instruction — answer THIS, in the format requested, using the parameters the operator gave):
${indentLines(operatorMessage, 4)}

`
      : '';

    return `DATA {
${operatorBlock}${identityFields}

${bundlesBlock}

${goalsBlock}

${recallBlock}

${capabilitiesBlock}
}`;
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
    // Remove this cycle from the engine-flows dispatch table so the activeCycles
    // map doesn't grow unbounded as engagements complete. Dynamic import keeps
    // this side-effecting only when an engine path was actually used.
    if (this.config.engine.instance) {
      void import('./engine-flows.js').then(({ activeCycles }) => {
        activeCycles.delete(this.engagementId);
      }).catch(() => {});
    }
    return result;
  }
}
