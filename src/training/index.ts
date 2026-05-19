// Training mode adapter — implements the cold-start humility cap + the adversarial-review
// cadence from spec §7.
//
// Spec calls out three mechanisms:
//   1. Cold-start humility — autonomy capped low until N validated engagements complete
//   2. Procedural promotion gating — long-cube promotions enter as candidates needing
//      external validation
//   3. Adversarial memory review — periodic "would we still promote this?"
//
// Day-7 ships #1 and #3. #2 needs a memory-side "candidate" state that runcor-memory
// doesn't currently expose — tracked as a separate piece of work.
//
// Validation count is set at instantiation (TrainingModeConfig.priorValidatedEngagements).
// The Bridge updates this between engagements; within an engagement, the count is
// immutable. This keeps the adapter stateless and the cold-start decision deterministic.

import type { Memory, RecalledMemory } from '../memory/index.js';
import type { Dialectic } from '../dialectic/index.js';
import type { TrainingModeConfig } from '../types.js';

// ─── Public adapter surface ────────────────────────────────────────────────

export interface AdversarialReviewResult {
  /** Nodes the review re-examined. */
  examined: number;
  /** Recommendations the review surfaced (e.g. "demote node N", "expire claim C"). */
  recommendations: string[];
  /** Whether dialectic actually ran (vs. disabled-mode placeholder). */
  enabled: boolean;
  /** Cost of the dialectic call (0 when disabled or no candidates). */
  costUsd: number;
}

export interface TrainingMode {
  isEnabled(): boolean;
  /** Cold-start cap applied to the configured autonomy dial. Returns clamped value 0..1. */
  effectiveAutonomy(configuredAutonomy: number): number;
  /** True while priorValidatedEngagements < validatedEngagementsRequired. */
  isColdStart(): boolean;
  /** Whether an adversarial review should fire on this cycle. */
  shouldAdversarialReview(cycle: number): boolean;
  /** Run an adversarial review over the agent's current memory state. */
  runAdversarialReview(cycle: number): Promise<AdversarialReviewResult>;
  /** Snapshot for trace introspection. */
  snapshot(): { isColdStart: boolean; validated: number; required: number; cap: number };
}

// ─── Implementation ────────────────────────────────────────────────────────

class LatticeTrainingMode implements TrainingMode {
  private readonly cap: number;
  private readonly required: number;
  private readonly validated: number;
  private readonly cadence: number;

  constructor(
    config: TrainingModeConfig,
    private readonly memory: Memory,
    private readonly dialectic: Dialectic,
    private readonly identityDescription: string,
  ) {
    this.cap = clamp01(config.coldStartAutonomyCap);
    this.required = Math.max(0, config.validatedEngagementsRequired | 0);
    this.validated = Math.max(0, config.priorValidatedEngagements | 0);
    this.cadence = Math.max(0, config.adversarialReviewCadence | 0);
  }

  isEnabled(): boolean { return true; }

  effectiveAutonomy(configuredAutonomy: number): number {
    if (!this.isColdStart()) return clamp01(configuredAutonomy);
    return Math.min(clamp01(configuredAutonomy), this.cap);
  }

  isColdStart(): boolean {
    return this.validated < this.required;
  }

  shouldAdversarialReview(cycle: number): boolean {
    return this.cadence > 0 && cycle > 0 && cycle % this.cadence === 0;
  }

  async runAdversarialReview(cycle: number): Promise<AdversarialReviewResult> {
    // Pull candidates: nodes currently in the long cube (already promoted). Adversarial
    // review asks "would we promote these again given what we know now?"
    if (!this.memory.isEnabled()) {
      return { examined: 0, recommendations: [], enabled: false, costUsd: 0 };
    }
    const recent = await this.memory.recall(this.identityDescription, 30);
    const candidates: RecalledMemory[] = recent.filter((n) => n.cube === 'long');
    if (candidates.length === 0) {
      return { examined: 0, recommendations: [], enabled: false, costUsd: 0 };
    }
    if (!this.dialectic.isEnabled()) {
      return { examined: candidates.length, recommendations: ['(dialectic disabled — no recommendations)'], enabled: false, costUsd: 0 };
    }
    const itemized = candidates.slice(0, 10)
      .map((c, i) => `${i + 1}. [M=${c.M.toFixed(2)}] ${c.content.replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
    const problem = [
      `Identity: ${this.identityDescription}`,
      `Cycle ${cycle} adversarial memory review.`,
      `Currently-promoted memory nodes (long cube, ${candidates.length} total):`,
      itemized,
      '',
      'Adversarial question: For each node, would we still promote it given current trajectory? Surface concrete recommendations as separate lines prefixed with "DEMOTE:" or "KEEP:" or "EXPIRE:".',
    ].join('\n');
    const decision = await this.dialectic.decide({ problem });
    return {
      examined: candidates.length,
      recommendations: extractAdversarialLines(decision.answer),
      enabled: true,
      costUsd: decision.costUsd,
    };
  }

  snapshot(): { isColdStart: boolean; validated: number; required: number; cap: number } {
    return { isColdStart: this.isColdStart(), validated: this.validated, required: this.required, cap: this.cap };
  }
}

class DisabledTrainingMode implements TrainingMode {
  isEnabled(): boolean { return false; }
  effectiveAutonomy(configuredAutonomy: number): number { return clamp01(configuredAutonomy); }
  isColdStart(): boolean { return false; }
  shouldAdversarialReview(_cycle: number): boolean { return false; }
  async runAdversarialReview(_cycle: number): Promise<AdversarialReviewResult> {
    return { examined: 0, recommendations: [], enabled: false, costUsd: 0 };
  }
  snapshot(): { isColdStart: boolean; validated: number; required: number; cap: number } {
    return { isColdStart: false, validated: 0, required: 0, cap: 1 };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function extractAdversarialLines(answer: string): string[] {
  const lines: string[] = [];
  for (const raw of answer.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^(DEMOTE|KEEP|EXPIRE):/i.test(trimmed)) lines.push(trimmed);
  }
  return lines;
}

export function createTrainingMode(
  config: TrainingModeConfig | undefined,
  memory: Memory,
  dialectic: Dialectic,
  identityDescription: string,
): TrainingMode {
  if (!config) return new DisabledTrainingMode();
  return new LatticeTrainingMode(config, memory, dialectic, identityDescription);
}
