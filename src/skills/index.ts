// Skill minting at engagement close.
//
// When a Cycle exits with goal-complete AND a SkillsLibrary is wired, this
// module:
//   1. Extracts a SuccessPattern from the trace (action invocations + judge
//      verdicts + the operator's final deliverable)
//   2. Calls runcor-skills.proposeSkill() to synthesize a task-specific
//      R++ skill (Proposal A)
//   3. Runs a structured-R++ generalization pass via the lattice's dialectic
//      to abstract A into a domain-agnostic pattern (Proposal B)
//   4. Applies the autonomy-dial quality gate to each
//   5. Writes both to the SkillsLibrary, with B.parentId = A.id

import { createSkills, type SuccessPattern, type SkillProposal } from 'runcor-skills';
import { initialStatusForAutonomy, type SkillsLibrary, type LibrarySkill } from 'runcor-skills-library';
import type { Dialectic } from '../dialectic/index.js';
import type { ActionInvocation } from '../types.js';

export interface MintInputs {
  engagementId: string;
  blueprintName: string;
  autonomy: number;
  dialectic: Dialectic;
  library: SkillsLibrary;
  pattern: SuccessPattern;
}

/** Public entry point — call from Cycle.makeResult when exit is goal-complete. */
export async function mintSkillsForEngagement(args: MintInputs): Promise<{
  taskSpecific: LibrarySkill | null;
  generalized: LibrarySkill | null;
}> {
  const { engagementId, blueprintName, autonomy, dialectic, library, pattern } = args;

  // Wrap the lattice's Dialectic adapter into runcor-skills' DialecticLike shape.
  const dialecticLike = async (cfg: { problem: string; maxRounds?: number }): Promise<{ answer: string }> => {
    const decision = await dialectic.decide({
      problem: cfg.problem,
      ...(typeof cfg.maxRounds === 'number' ? { maxRounds: cfg.maxRounds } : {}),
    });
    return { answer: decision.answer };
  };

  const skills = createSkills({ dialectic: dialecticLike });
  let proposalA: SkillProposal;
  try {
    proposalA = await skills.proposeSkill({ pattern });
  } catch {
    return { taskSpecific: null, generalized: null };
  }

  // Proposal A: task-specific. Use parsedCleanly as a confidence floor.
  const confA = computeConfidenceFromProposal(proposalA);
  const statusA = initialStatusForAutonomy(autonomy, confA);
  const taskSpecific = library.add({
    rppSource: proposalA.rppSource,
    flavor: 'task-specific',
    domainTags: inferDomainTags(pattern, blueprintName),
    inputSignature: inferInputSignature(pattern),
    outputDeliverableType: inferOutputDeliverable(pattern),
    confidence: confA,
    createdInEngagementId: engagementId,
    createdInBlueprintName: blueprintName,
    status: statusA,
  });

  // Proposal B: generalized. Re-run the dialectic with a structured R++ prompt
  // asking it to abstract the task-specific skill into a domain-agnostic pattern.
  let generalized: LibrarySkill | null = null;
  try {
    const genPrompt = makeGeneralizationPrompt(proposalA.rppSource, pattern);
    const genDecision = await dialectic.decide({ problem: genPrompt });
    const genRpp = extractRppFromAnswer(genDecision.answer) ?? genDecision.answer;
    if (genRpp && genRpp.length > 50) {
      const confB = Math.min(0.85, confA * 0.9); // generalization is one step removed from evidence
      const statusB = initialStatusForAutonomy(autonomy, confB);
      generalized = library.add({
        rppSource: genRpp,
        flavor: 'generalized',
        domainTags: inferDomainTags(pattern, blueprintName).filter((t) => t !== blueprintName.toLowerCase()),
        inputSignature: 'generalized:' + inferInputSignature(pattern),
        outputDeliverableType: inferOutputDeliverable(pattern),
        confidence: confB,
        parentId: taskSpecific.id,
        createdInEngagementId: engagementId,
        createdInBlueprintName: blueprintName,
        status: statusB,
      });
    }
  } catch {
    // Generalization failed — keep the task-specific entry, return null for generalized.
  }

  return { taskSpecific, generalized };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build a SuccessPattern from the per-cycle trace data the Cycle accumulated.
 *  Callers (Cycle) pass action invocations + a description of the engagement. */
export function buildPatternFromInvocations(args: {
  blueprintName: string;
  operatorMessage: string | null;
  finalAnswer: string;
  invocations: ActionInvocation[];
  judgeOutcomes: Array<'pass' | 'escalate' | 'block'>;
}): SuccessPattern {
  const { blueprintName, operatorMessage, finalAnswer, invocations, judgeOutcomes } = args;

  // If the agent didn't use any capabilities, treat the final dialectic answer
  // as the single "action". Otherwise use the capability invocations.
  const trajectories = invocations.length > 0
    ? invocations.map((inv, i) => ({
        action: inv.name,
        input: inv.args,
        output: inv.result,
        score: judgeOutcomeToScore(judgeOutcomes[i] ?? 'pass'),
      }))
    : [{
        action: 'deliberate',
        input: operatorMessage ?? '(no operator message)',
        output: finalAnswer,
        score: judgeOutcomeToScore(judgeOutcomes[judgeOutcomes.length - 1] ?? 'pass'),
      }];

  const name = slugify(operatorMessage ?? blueprintName).slice(0, 60) || 'engagement';
  const description = operatorMessage ?? `${blueprintName} engagement completed successfully`;

  return {
    name,
    description: description.slice(0, 500),
    trajectories,
    context: `Lattice role: ${blueprintName}. Engagement closed with goal-complete.`,
  };
}

function judgeOutcomeToScore(outcome: 'pass' | 'escalate' | 'block'): number {
  if (outcome === 'pass') return 0.9;
  if (outcome === 'escalate') return 0.5;
  return 0.2;
}

function computeConfidenceFromProposal(p: SkillProposal): number {
  // No formal confidence in SkillProposal; derive from parsedCleanly +
  // diagnostic severity. Range 0.4 – 0.9.
  if (!p.parsedCleanly) return 0.4;
  const errs = (p.diagnostics ?? []).filter((d) => d.severity === 'error').length;
  const warns = (p.diagnostics ?? []).filter((d) => d.severity === 'warning').length;
  if (errs > 0) return 0.4;
  if (warns > 2) return 0.6;
  if (warns > 0) return 0.75;
  return 0.9;
}

function inferDomainTags(pattern: SuccessPattern, blueprintName: string): string[] {
  const tags = new Set<string>();
  tags.add(blueprintName.toLowerCase().replace(/\s+/g, '-'));
  // Pull lower-cased words from pattern.description as informal domain tags
  const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'with', 'for', 'in', 'on', 'is', 'we']);
  const words = pattern.description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopwords.has(w));
  for (const w of words.slice(0, 5)) tags.add(w);
  return [...tags];
}

function inferInputSignature(pattern: SuccessPattern): string {
  // Operator-message-shape slug, first 5 meaningful words.
  return slugify(pattern.description).slice(0, 60) || pattern.name;
}

function inferOutputDeliverable(pattern: SuccessPattern): string {
  // Inspect the final trajectory output to classify.
  const last = pattern.trajectories[pattern.trajectories.length - 1];
  const out = typeof last?.output === 'string' ? last.output : JSON.stringify(last?.output ?? '');
  if (/<!doctype html|<html\b/i.test(out)) return 'html-document';
  if (/^\s*[\\${]?\d/.test(out) && out.length < 200) return 'numeric-or-short-statement';
  if (out.length > 1000) return 'long-form-prose';
  if (out.length > 200) return 'short-form-prose';
  return 'short-statement';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function makeGeneralizationPrompt(taskSpecificRpp: string, pattern: SuccessPattern): string {
  return `# Skill generalization pass

TARGET {
  output: a generalized R++ skill spec abstracting the task-specific skill below into a cross-domain pattern. Output ONLY the R++ source — no preamble, no commentary, no fences.
  profile: skill-generalization
}

DATA {
  task_specific_skill (the skill to generalize):
${indentLines(taskSpecificRpp, 4)}

  origin_pattern_description: ${pattern.description.slice(0, 300)}
  origin_pattern_name: ${pattern.name}
}

BEHAVIOR Generalize {
  CONSTRAINT: identify the abstract pattern in the task-specific skill — what shape of input maps to what shape of output, regardless of domain
  CONSTRAINT: replace domain-specific tokens with role-agnostic placeholders (e.g. "LinkedIn post" → "short-form artifact"; "Pro Annual pricing" → "tier-based quantity calculation")
  CONSTRAINT: preserve the TARGET → BEHAVIOR → CHECKLIST structure but make the COMPONENT specifics domain-agnostic
  CONSTRAINT: keep CHECKLIST items abstract ("output matches operator's specified format" not "output is a 150-word LinkedIn post")
  CONSTRAINT: do not invent new abstractions — only generalize what's already in the task-specific skill
  CONSTRAINT: output ONLY the generalized R++ source. No preamble, no "here is the generalized version", no fences
}

CHECKLIST {
  [ ] output begins directly with R++ syntax (TARGET / BEHAVIOR / CHECKLIST blocks)
  [ ] no domain-specific tokens remain (specific names, products, dollar amounts, brand-specific phrases)
  [ ] the generalized skill could apply to a sibling task in a different domain
  [ ] structure mirrors the task-specific skill's structure (same block kinds)
}`;
}

function extractRppFromAnswer(answer: string): string | null {
  // Match a TARGET / BEHAVIOR / CHECKLIST / COMPONENT / STRUCTURE block at the start
  // of the answer. Strip any leading prose.
  const m = answer.match(/(?:^|\n)(TARGET|BEHAVIOR|COMPONENT|STRUCTURE)\s*\{[\s\S]+$/);
  return m ? m[0].trim() : null;
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => pad + line).join('\n');
}
