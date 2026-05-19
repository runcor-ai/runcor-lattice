// Substrate adapter — composes runcor-substrate primitives for the Loop's ground + judge phases.
//
// Per spec §2: the substrate wraps every engine call.
//   - PRE-call (ground phase):  inject laws + identity prior + reality slice into the prompt
//   - POST-call (judge phase):  discernment-gate evaluates the proposed output
//
// This adapter is the Lattice's clean facade over runcor-substrate. It does NOT monkey-patch
// the engine — the cycle drives substrate wraps + judgments explicitly, so the relationship
// is auditable in the trace.
//
// runcor-substrate has two APIs:
//   - Legacy primitives (`wrapSystemPrompt`, `evaluateOutput`): take simple inputs, return strings
//   - PromptStack class: V2-shaped LayerContext required (drives, goals, etc. — too coupled)
// The Lattice uses the legacy primitives so it owns its own composition.

import {
  wrapSystemPrompt,
  evaluateOutput,
  type RealitySlice,
  type DiscernmentResult,
  type Outcome,
} from 'runcor-substrate';
import type { SubstrateConfig } from '../types.js';

// ─── Public adapter surface ────────────────────────────────────────────────

export interface WrappedPrompt {
  /** The system prompt with laws + identity + reality + goal context prepended. */
  system: string;
  /** Sections that contributed non-empty text — for trace introspection. */
  layers: string[];
}

export interface SubstrateContext {
  engagementId: string;
  cycle: number;
  /** Plain-text rendering of the engagement goal(s). */
  goalContext: string;
  /** Reality slice from runcor-data, or empty when the cube is not yet wired. */
  realitySlice?: RealitySlice;
}

export interface Substrate {
  ground(input: string, context: SubstrateContext): WrappedPrompt;
  judge(input: string, output: string, realitySlice?: RealitySlice): Promise<DiscernmentResult>;
  /** Snapshot of the configured laws (for trace / Bridge inspection). */
  laws(): string[];
}

// ─── Implementation ────────────────────────────────────────────────────────

class LatticeSubstrate implements Substrate {
  private readonly compiledLaws: string[];
  private readonly lawsPrompt: string;

  constructor(
    private readonly config: SubstrateConfig,
    private readonly identityDescription: string,
    private readonly initialClaims: string[],
  ) {
    this.compiledLaws = [...config.laws];
    this.lawsPrompt = this.compileLawsPrompt();
  }

  ground(input: string, context: SubstrateContext): WrappedPrompt {
    const layers: string[] = ['laws'];
    const identityBlock = this.renderIdentityPrior();
    const goalBlock = context.goalContext ? `Goal context:\n${context.goalContext}` : '';
    const realityBlock = (context.realitySlice && context.realitySlice.entities.length > 0) ? '__reality__' : '';

    // Compose the agent-facing system text. Order: identity → goal context → input.
    // wrapSystemPrompt then wraps THIS with laws + reality slice on the outside.
    const agentSystem = [identityBlock, goalBlock, input].filter((s) => s !== '').join('\n\n');
    if (identityBlock) layers.push('identity_prior');
    if (goalBlock) layers.push('goal_context');
    const slice = context.realitySlice ?? emptyRealitySlice();
    if (slice.entities.length > 0) layers.push('reality');
    if (input) layers.push('input');

    const system = wrapSystemPrompt(agentSystem, this.lawsPrompt, slice);
    // Suppress lint var
    void realityBlock;
    return { system, layers };
  }

  async judge(input: string, output: string, realitySlice?: RealitySlice): Promise<DiscernmentResult> {
    return evaluateOutput({
      input,
      output,
      realitySlice: realitySlice ?? emptyRealitySlice(),
      config: { mode: this.config.discernmentMode === 'permissive' ? 'moderate' : 'aggressive' },
    });
  }

  laws(): string[] {
    return [...this.compiledLaws];
  }

  private renderIdentityPrior(): string {
    if (!this.identityDescription) return '';
    const lines = [`Identity prior: ${this.identityDescription}`];
    if (this.initialClaims.length > 0) {
      lines.push('Initial claims:');
      for (const c of this.initialClaims) lines.push(`  - ${c}`);
    }
    return lines.join('\n');
  }

  private compileLawsPrompt(): string {
    if (this.compiledLaws.length === 0) return '';
    const numbered = this.compiledLaws.map((law, i) => `${i + 1}. ${law}`).join('\n');
    return `Laws (binding, non-negotiable):\n${numbered}`;
  }
}

function emptyRealitySlice(): RealitySlice {
  return { entities: [], edges: [], conflicts: [], last_updated: new Date().toISOString() };
}

export function createSubstrate(
  config: SubstrateConfig,
  identityDescription: string,
  initialClaims: string[] = [],
): Substrate {
  return new LatticeSubstrate(config, identityDescription, initialClaims);
}

// Re-export DiscernmentResult + Outcome so consumers don't have to deep-import runcor-substrate.
export type { DiscernmentResult, Outcome, RealitySlice };
