// Self-review adapter — runs a higher-altitude dialectic over a recent memory window
// every N cycles per spec §6.
//
// The review's job is to ask "is the trajectory aligned with identity + goals, or are
// we drifting?" — and emit a verdict that downstream phases can act on (plan rewrite,
// goal retirement, identity reflection). For day-6 the verdict is captured in the trace
// but doesn't yet drive further behavior — the steering wiring comes when plan-rewrite
// + identity adapters land.
//
// Disabled-mode rules:
//   - Memory disabled → no window can be pulled → review is a no-op
//   - Dialectic disabled → window is still summarized but the verdict is a placeholder
//
// Cadence is owned by the cycle, not this adapter: cycle.ts calls runReview() when
// `cycleCount % controls.reviewCadence === 0` (and reviewCadence > 0).

import type { Memory } from '../memory/index.js';
import type { Dialectic } from '../dialectic/index.js';

// ─── Public adapter surface ────────────────────────────────────────────────

export interface ReviewVerdict {
  /** One-paragraph summary of the trajectory. */
  summary: string;
  /** What the dialectic recommends — a single concrete steering recommendation. */
  recommendation: string;
  /** True when the review fully fired (memory window + dialectic). */
  enabled: boolean;
  /** Cost incurred for this review (dialectic cost only — window pull is free). */
  costUsd: number;
  /** Source counts for the window. */
  window: { nodesIncluded: number; charsCompressed: number };
}

export interface SelfReview {
  runReview(currentCycle: number): Promise<ReviewVerdict>;
}

// ─── Implementation ────────────────────────────────────────────────────────

const MAX_WINDOW_NODES = 20;
const MAX_COMPRESSED_CHARS = 4_000;

class LatticeSelfReview implements SelfReview {
  constructor(
    private readonly memory: Memory,
    private readonly dialectic: Dialectic,
    private readonly identityDescription: string,
    private readonly goalContextSource: () => string,
  ) {}

  async runReview(currentCycle: number): Promise<ReviewVerdict> {
    // 1. Pull window from memory. recall() is semantic; for day-6 we query with the
    //    identity description as a generic anchor. Future improvement: chronological
    //    "recent N cycles" window via a dedicated memory.recent() API.
    const memoryEnabled = this.memory.isEnabled();
    const nodes = memoryEnabled ? await this.memory.recall(this.identityDescription, MAX_WINDOW_NODES) : [];

    // 2. Compress the window into a single text block bounded by MAX_COMPRESSED_CHARS.
    const compressed = this.compress(nodes.map((n) => n.content));
    const window = { nodesIncluded: nodes.length, charsCompressed: compressed.length };

    // 3. Run dialectic on the compressed window. When dialectic is disabled, fall back
    //    to a placeholder verdict so the trace entry is still informative.
    if (!this.dialectic.isEnabled() || !memoryEnabled) {
      return {
        summary: nodes.length > 0
          ? `Recent window: ${nodes.length} nodes, ${compressed.length} chars. Dialectic disabled — no recommendation generated.`
          : 'No memory window available (memory disabled or empty).',
        recommendation: '(disabled — no steering recommendation)',
        enabled: false,
        costUsd: 0,
        window,
      };
    }

    const goalContext = this.goalContextSource();
    const problem = [
      `Identity: ${this.identityDescription}`,
      goalContext ? `Goals:\n${goalContext}` : 'Goals: (none configured)',
      `Recent activity window (last ${nodes.length} memory nodes, cycle ${currentCycle}):`,
      compressed,
      '',
      'Question: Is the trajectory aligned with identity + goals, or are we drifting? Provide a one-paragraph summary AND a single concrete steering recommendation prefixed with "RECOMMEND:".',
    ].join('\n');

    const decision = await this.dialectic.decide({ problem });
    const recommendation = extractRecommendation(decision.answer) ?? '(no explicit recommendation parsed)';
    return {
      summary: decision.answer.length > 400 ? decision.answer.slice(0, 400) + '…' : decision.answer,
      recommendation,
      enabled: true,
      costUsd: decision.costUsd,
      window,
    };
  }

  private compress(contents: string[]): string {
    if (contents.length === 0) return '(empty window)';
    const lines = contents.map((c, i) => `${i + 1}. ${c.replace(/\s+/g, ' ').slice(0, 200)}`);
    const joined = lines.join('\n');
    return joined.length > MAX_COMPRESSED_CHARS ? joined.slice(0, MAX_COMPRESSED_CHARS) + '…' : joined;
  }
}

function extractRecommendation(answer: string): string | null {
  const match = answer.match(/RECOMMEND:\s*([^\n]+)/i);
  return match ? match[1]!.trim() : null;
}

export function createSelfReview(
  memory: Memory,
  dialectic: Dialectic,
  identityDescription: string,
  goalContextSource: () => string,
): SelfReview {
  return new LatticeSelfReview(memory, dialectic, identityDescription, goalContextSource);
}
