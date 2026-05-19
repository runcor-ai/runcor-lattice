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

import { dialectic, canonicalRoleSet, type DialecticResult } from 'runcor-dialectic';
import type { EngineRef } from '../types.js';

/** Per-role model overrides — when a role's model differs from the canonical default,
 *  build a RoleConfig override using the canonical prompts but with the substituted model. */
export type DialecticModels = { player?: string; coach?: string; judge?: string };

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
  /** Per-role cost rollup from the transcript (player/coach/judge → usd). */
  costByRole: Record<string, number>;
}

export type DialecticDepth = 'shallow' | 'medium' | 'deep';

export interface Dialectic {
  decide(input: DecisionInput): Promise<Decision>;
  isEnabled(): boolean;
  /** The current depth setting; cycle re-reads this each decide() to pick up dial adjusts. */
  setDepth(depth: DialecticDepth): void;
  /** Set per-role model overrides for subsequent decide() calls. Pass {} or undefined to
   *  fall back to canonical defaults. */
  setModels(models: DialecticModels | undefined): void;
  /** Current effective models (overrides merged onto canonical defaults). */
  currentModels(): { player: string; coach: string; judge: string };
}

// ─── Implementation ────────────────────────────────────────────────────────

const DEPTH_TO_ROUNDS: Record<DialecticDepth, number> = { shallow: 1, medium: 3, deep: 5 };

class LatticeDialectic implements Dialectic {
  private depth: DialecticDepth;
  private models: DialecticModels;

  constructor(initialDepth: DialecticDepth, initialModels: DialecticModels = {}) {
    this.depth = initialDepth;
    this.models = { ...initialModels };
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const maxRounds = input.maxRounds ?? DEPTH_TO_ROUNDS[this.depth];
    const result: DialecticResult = await dialectic({
      problem: input.problem,
      maxRounds,
      ...(typeof input.budgetCapUsd === 'number' ? { budget_cap_usd: input.budgetCapUsd } : {}),
      ...(this.hasOverrides() ? { roles: this.buildRoleOverrides() } : {}),
    });
    const costByRole: Record<string, number> = {};
    for (const r of result.transcript ?? []) {
      costByRole[r.role] = (costByRole[r.role] ?? 0) + (r.cost_usd ?? 0);
    }
    return {
      answer: result.answer,
      rounds: result.rounds,
      converged: result.converged,
      convergenceReason: String(result.convergence_reason ?? 'unknown'),
      costUsd: result.cost?.usd ?? 0,
      durationMs: result.duration_ms ?? 0,
      enabled: true,
      costByRole,
    };
  }

  isEnabled(): boolean { return true; }

  setDepth(depth: DialecticDepth): void { this.depth = depth; }

  setModels(models: DialecticModels | undefined): void {
    this.models = models ? { ...models } : {};
  }

  currentModels(): { player: string; coach: string; judge: string } {
    return {
      player: this.models.player ?? canonicalRoleSet.roles['player']!.model,
      coach: this.models.coach ?? canonicalRoleSet.roles['coach']!.model,
      judge: this.models.judge ?? canonicalRoleSet.roles['judge']!.model,
    };
  }

  private hasOverrides(): boolean {
    return !!(this.models.player || this.models.coach || this.models.judge);
  }

  private buildRoleOverrides(): Record<string, { role: string; model: string; systemPrompt: string; revisionSystemPrompt?: string }> {
    const overrides: Record<string, { role: string; model: string; systemPrompt: string; revisionSystemPrompt?: string }> = {};
    for (const roleName of ['player', 'coach', 'judge'] as const) {
      const override = this.models[roleName];
      if (!override) continue;
      const canonical = canonicalRoleSet.roles[roleName]!;
      overrides[roleName] = {
        role: roleName,
        model: override,
        systemPrompt: canonical.systemPrompt,
        ...(canonical.revisionSystemPrompt ? { revisionSystemPrompt: canonical.revisionSystemPrompt } : {}),
      };
    }
    return overrides;
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
      costByRole: {},
    };
  }
  isEnabled(): boolean { return false; }
  setDepth(_depth: DialecticDepth): void { /* no-op */ }
  setModels(_models: DialecticModels | undefined): void { /* no-op */ }
  currentModels(): { player: string; coach: string; judge: string } {
    return {
      player: canonicalRoleSet.roles['player']!.model,
      coach: canonicalRoleSet.roles['coach']!.model,
      judge: canonicalRoleSet.roles['judge']!.model,
    };
  }
}

export function createDialectic(engine: EngineRef, depth: DialecticDepth, models?: DialecticModels): Dialectic {
  const hasProviderKey = !!(engine.apiKeys.openrouter || engine.apiKeys.anthropic || process.env['OPENROUTER_API_KEY'] || process.env['ANTHROPIC_API_KEY']);
  if (!hasProviderKey) return new DisabledDialectic();
  return new LatticeDialectic(depth, models);
}
