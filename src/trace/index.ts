// Trace adapter — the sole owner of cycle trace state.
//
// Per spec §5: trace captures per cycle — substrate context injected, memory consulted,
// plan version, goals current, dialectic transcripts, tool calls, discernment results,
// memory writes, self-review triggers, identity updates. Output: JSONL per engagement
// plus indexed Postgres table (Postgres deferred to a later spec pass — day-5 only does
// JSONL + in-memory index).
//
// Three responsibilities:
//   1. Capture — every phase emission flows through here
//   2. Persist — optional JSONL per engagement when trace.dir is configured
//   3. Broadcast — drives the ObservationStream subscribers (Bridge + tests)
//
// The cycle delegates `traceBuffer` ownership to this adapter so long-running engagements
// don't grow unbounded in process memory.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EngagementResult, TraceConfig, TraceEntry } from '../types.js';

// ─── Public adapter surface ────────────────────────────────────────────────

export type TraceSubscriber = (entry: TraceEntry) => void;

export interface Trace {
  start(engagementId: string): void;
  capture(entry: TraceEntry): void;
  end(result: EngagementResult): void;
  /** Most recent entry — used by Agent.state(). */
  latest(): TraceEntry | undefined;
  /** Number of entries captured in the current engagement. */
  count(): number;
  /** Path to the on-disk JSONL file for this engagement, or '(in-memory)' when no dir configured. */
  path(): string;
  /** Subscribe to future entries. Returns unsubscribe function. */
  subscribe(fn: TraceSubscriber): () => void;
}

// ─── Implementation ────────────────────────────────────────────────────────

class LatticeTrace implements Trace {
  private engagementId: string | null = null;
  private filePath: string | null = null;
  private entriesCaptured = 0;
  private lastEntry: TraceEntry | undefined;
  /** Rolling in-memory ring of the most recent entries (bounded). */
  private readonly buffer: TraceEntry[] = [];
  private readonly subscribers = new Set<TraceSubscriber>();
  private readonly memoryBufferCap: number;

  constructor(private readonly config: TraceConfig | undefined) {
    this.memoryBufferCap = config?.memoryBufferCap ?? 10_000;
  }

  start(engagementId: string): void {
    this.engagementId = engagementId;
    this.entriesCaptured = 0;
    this.lastEntry = undefined;
    this.buffer.length = 0;
    if (this.config?.dir) {
      const dir = resolve(this.config.dir);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.filePath = join(dir, `${engagementId}.jsonl`);
    } else {
      this.filePath = null;
    }
  }

  capture(entry: TraceEntry): void {
    this.entriesCaptured += 1;
    this.lastEntry = entry;
    // Bounded ring: drop oldest when cap exceeded. Disk file (when configured) is the
    // durable record; in-memory buffer is for late subscribers / state().
    this.buffer.push(entry);
    if (this.buffer.length > this.memoryBufferCap) this.buffer.shift();
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
      } catch {
        // Persistence failure should never break the cycle — degrade silently to memory-only.
      }
    }
    for (const fn of this.subscribers) {
      try { fn(entry); } catch { /* subscriber errors are isolated from each other */ }
    }
  }

  end(result: EngagementResult): void {
    // Final entry — distinct from cycle phase entries; captured under a synthetic phase tag.
    const final: TraceEntry = {
      engagementId: this.engagementId ?? result.engagementId,
      cycle: result.cyclesRun,
      phase: 'pulse',
      ts: Date.now(),
      data: { event: 'engagement-ended', exitReason: result.exitReason, totalCostUsd: result.totalCostUsd, durationMs: result.durationMs },
    };
    this.capture(final);
  }

  latest(): TraceEntry | undefined {
    return this.lastEntry;
  }

  count(): number {
    return this.entriesCaptured;
  }

  path(): string {
    return this.filePath ?? `(in-memory; ${this.entriesCaptured} entries)`;
  }

  subscribe(fn: TraceSubscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }
}

export function createTrace(config?: TraceConfig): Trace {
  return new LatticeTrace(config);
}
