// Dialectic adapter — wraps runcor-dialectic for the Loop's decide phase.
//
// Per spec §4: Player drafts, Coach challenges, Judge selects. Each role can run on a
// different model; convergence is a confidence signal.
//
// The Lattice's decide phase calls dialectic.decide() each cycle. Cost is the dominant
// constraint here — a default canonical-topology call is ~$0.005 (Player+Coach+Judge with
// nemotron-120b/qwen3-32b/llama-8b). The ControlSurface.dialecticDepth dial maps to
// maxRounds (shallow=1, medium=3, deep=5).
//
// When no OpenRouter key is configured, the adapter goes into disabled-mode and returns
// a no-op DecisionResult so the cycle stays runnable in tests + smoke runs.

import { dialectic, type DialecticResult } from 'runcor-dialectic';
import type { EngineRef } from '../types.js';

// ─── Public adapter surface ────────────────────────────────────────────────

export interface DecisionInput {
  /** Problem statement (e.g. "Given the recall + goals, what's the next action?"). */
  problem: string;
  /** Optional override of the dial-mapped depth. */
  maxRounds?: number;
  /** Optional hard budget cap in USD for this single decide call. */
  budgetCapUsd?: number;
}

export interface Decision {
  answer: string;
  rounds: number;
  converged: boolean;
  convergenceReason: string;
  costUsd: number;
  durationMs: number;
  enabled: boolean;
}

export type DialecticDepth = 'shallow' | 'medium' | 'deep';

export interface Dialectic {
  decide(input: DecisionInput): Promise<Decision>;
  isEnabled(): boolean;
  /** The current depth setting; cycle re-reads this each decide() to pick up dial adjusts. */
  setDepth(depth: DialecticDepth): void;
}

// ─── Implementation ────────────────────────────────────────────────────────

const DEPTH_TO_ROUNDS: Record<DialecticDepth, number> = { shallow: 1, medium: 3, deep: 5 };

class LatticeDialectic implements Dialectic {
  private depth: DialecticDepth;
  constructor(initialDepth: DialecticDepth) {
    this.depth = initialDepth;
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const maxRounds = input.maxRounds ?? DEPTH_TO_ROUNDS[this.depth];
    const result: DialecticResult = await dialectic({
      problem: input.problem,
      maxRounds,
      ...(typeof input.budgetCapUsd === 'number' ? { budget_cap_usd: input.budgetCapUsd } : {}),
    });
    return {
      answer: result.answer,
      rounds: result.rounds,
      converged: result.converged,
      convergenceReason: String(result.convergence_reason ?? 'unknown'),
      costUsd: result.cost?.usd ?? 0,
      durationMs: result.duration_ms ?? 0,
      enabled: true,
    };
  }

  isEnabled(): boolean {
    return true;
  }

  setDepth(depth: DialecticDepth): void {
    this.depth = depth;
  }
}

class DisabledDialectic implements Dialectic {
  async decide(input: DecisionInput): Promise<Decision> {
    return {
      answer: `(dialectic disabled — no provider key configured. Problem was: ${input.problem.slice(0, 80)}...)`,
      rounds: 0,
      converged: false,
      convergenceReason: 'disabled',
      costUsd: 0,
      durationMs: 0,
      enabled: false,
    };
  }
  isEnabled(): boolean { return false; }
  setDepth(_depth: DialecticDepth): void { /* no-op */ }
}

export function createDialectic(engine: EngineRef, depth: DialecticDepth): Dialectic {
  const hasProviderKey = !!(engine.apiKeys.openrouter || engine.apiKeys.anthropic || process.env['OPENROUTER_API_KEY'] || process.env['ANTHROPIC_API_KEY']);
  if (!hasProviderKey) return new DisabledDialectic();
  return new LatticeDialectic(depth);
}
