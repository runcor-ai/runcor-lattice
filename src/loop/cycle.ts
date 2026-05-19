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

export class Cycle implements Agent {
  private cycleCount = 0;
  private status: AgentState['status'] = 'running';
  private currentPhase: AgentState['currentPhase'] = 'idle';
  private stopRequested = false;
  private readonly engagementId: string;
  private readonly traceBuffer: TraceEntry[] = [];
  private readonly observers: Array<(entry: TraceEntry) => void> = [];
  private controls: ControlSurface;
  private totalCostUsd = 0;
  private totalTokens = { input: 0, output: 0 };
  private startedAt = 0;
  private readonly substrate: Substrate;
  private readonly memory: Memory;
  /** Most recent ground() output — judge() needs the same input the agent saw. */
  private lastWrappedPrompt: WrappedPrompt | null = null;
  /** Most recent recall result — decide phase will consume this in a later step. */
  private lastRecall: RecalledMemory[] = [];
  /** Cumulative substrate-flag count (judge non-pass outcomes). Drives substrate-hard-stop. */
  private substrateFlagCount = 0;
  /** Outcomes that escalate to a hard stop once flagCount exceeds the threshold. */
  private readonly HARD_STOP_FLAG_THRESHOLD = 3;

  constructor(private readonly config: LatticeConfig) {
    this.engagementId = `eng-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.controls = { ...config.controls };
    this.substrate = createSubstrate(
      config.substrate,
      config.identity.description,
      config.identity.initialClaims ?? [],
    );
    this.memory = createMemory(config.memory);
  }

  async run(): Promise<EngagementResult> {
    this.startedAt = Date.now();
    this.emit('observe', 0, { event: 'engagement-started', config: { identity: this.config.identity.description } });

    while (this.status === 'running') {
      this.cycleCount += 1;
      for (const phase of PHASES) {
        if (this.stopRequested) {
          this.status = 'stopped';
          break;
        }
        this.currentPhase = phase;
        await this.runPhase(phase);
      }

      if (this.status !== 'running') break;

      const exit = computeExit({
        cycle: this.cycleCount,
        budget: this.controls.budget,
        spent: { dollars: this.totalCostUsd, tokens: this.totalTokens.input + this.totalTokens.output },
        elapsedMs: Date.now() - this.startedAt,
        goalsComplete: false,
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
    const last = this.traceBuffer[this.traceBuffer.length - 1];
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
    const subscriber = (entry: TraceEntry): void => {
      if (closed) return;
      if (resolve) { resolve(entry); resolve = null; } else { queue.push(entry); }
    };
    this.observers.push(subscriber);
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) { yield queue.shift()!; continue; }
          if (closed) break;
          const next = await new Promise<TraceEntry | null>((res) => { resolve = res; });
          if (next === null) {
            // Close fired mid-await — drain any entries enqueued since then before exiting.
            while (queue.length > 0) yield queue.shift()!;
            break;
          }
          yield next;
        }
      },
      close() {
        closed = true;
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
      case 'observe': this.emit('observe', this.cycleCount, { stub: true }); break;
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
        try {
          this.lastRecall = await this.memory.recall(query, this.controls.memoryRecallBreadth);
          this.emit('recall', this.cycleCount, {
            queryLength: query.length,
            recalled: this.lastRecall.length,
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
      case 'decide':  this.emit('decide',  this.cycleCount, { stub: true }); break;
      case 'act':     this.emit('act',     this.cycleCount, { stub: true }); break;
      case 'judge': {
        // Skeleton mode: no real LLM output to judge yet. We evaluate a placeholder pass-string
        // so the discernment gate's wiring is exercised. When the act phase produces real output,
        // that output flows here instead. The result drives substrate-hard-stop exit when
        // judgment escalates.
        const input = this.lastWrappedPrompt?.system ?? '';
        const stubOutput = 'No action taken this cycle (skeleton mode).';
        const verdict = await this.substrate.judge(input, stubOutput);
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
        // The episodic event for the skeleton is minimal — real act-phase output will replace
        // the content string when act lands.
        const content = `Cycle ${this.cycleCount}: skeleton tick (no action). Identity: ${this.config.identity.description}.`;
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

  // ─── Helpers ───────────────────────────────────────────────────────────

  private emit(phase: Phase, cycle: number, data: Record<string, unknown>): void {
    const entry: TraceEntry = { engagementId: this.engagementId, cycle, phase, ts: Date.now(), data };
    this.traceBuffer.push(entry);
    for (const obs of this.observers) obs(entry);
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
    return {
      engagementId: this.engagementId,
      exitReason: reason,
      cyclesRun: this.cycleCount,
      totalCostUsd: this.totalCostUsd,
      totalTokens: this.totalTokens,
      durationMs: Date.now() - this.startedAt,
      finalState: this.state(),
      tracePath: `(in-memory; ${this.traceBuffer.length} entries)`,
    };
  }
}
