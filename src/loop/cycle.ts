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

  constructor(private readonly config: LatticeConfig) {
    this.engagementId = `eng-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.controls = { ...config.controls };
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
        substrateHardStop: false,
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
      case 'ground':  this.emit('ground',  this.cycleCount, { stub: true }); break;
      case 'recall':  this.emit('recall',  this.cycleCount, { stub: true }); break;
      case 'decide':  this.emit('decide',  this.cycleCount, { stub: true }); break;
      case 'act':     this.emit('act',     this.cycleCount, { stub: true }); break;
      case 'judge':   this.emit('judge',   this.cycleCount, { stub: true }); break;
      case 'write':   this.emit('write',   this.cycleCount, { stub: true }); break;
      case 'pulse': {
        const pulseResult: PulseResult = pulse({ cycle: this.cycleCount, drivePressure: this.controls.drivePressure });
        this.emit('pulse', this.cycleCount, { ...pulseResult });
        break;
      }
    }
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
