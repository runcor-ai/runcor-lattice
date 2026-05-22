// Skill-minting probe tests — verify the engagement-close skill synthesis path
// in src/skills/index.ts without any live API calls. Uses a stub dialectic that
// returns a canned R++ source and an in-memory SqliteSkillsLibrary.
//
// Live convention-trick verification (real OpenRouter calls) is covered by the
// Bridge eval-suite. This file only proves the wiring is correct.

import { describe, it, expect } from 'vitest';
import { SqliteSkillsLibrary } from 'runcor-skills-library';
import { mintSkillsForEngagement, buildPatternFromInvocations } from '../src/skills/index.js';
import type { Dialectic } from '../src/dialectic/index.js';
import type { Decision } from '../src/dialectic/types.js';

function stubDialectic(answers: string[]): Dialectic {
  const queue = [...answers];
  return {
    isEnabled: () => true,
    setDepth: () => undefined,
    decide: async () => {
      const answer = queue.shift() ?? '(no more stubbed answers)';
      return {
        answer,
        enabled: true,
        rounds: 1,
        converged: true,
        convergenceReason: 'stub',
        costUsd: 0,
        costByRole: { player: 0, coach: 0, judge: 0 },
      } as Decision;
    },
  } as unknown as Dialectic;
}

const TASK_SPECIFIC_RPP = `TARGET {
  output: a 150-word LinkedIn post for Pro Annual
}
BEHAVIOR Compose {
  CONSTRAINT: include the specific tier price quoted by the operator
}
CHECKLIST {
  [ ] post is approximately 150 words
}`;

const GENERALIZED_RPP = `TARGET {
  output: a short-form artifact matching the operator's specified format
}
BEHAVIOR Compose {
  CONSTRAINT: include any operator-specified quantities verbatim
}
CHECKLIST {
  [ ] output matches operator's specified format and length
}`;

describe('mintSkillsForEngagement', () => {
  it('writes both task-specific and generalized skills to the library', async () => {
    const library = new SqliteSkillsLibrary(':memory:');
    const dialectic = stubDialectic([TASK_SPECIFIC_RPP, GENERALIZED_RPP]);
    const pattern = buildPatternFromInvocations({
      blueprintName: 'Content Writer',
      operatorMessage: 'write a LinkedIn post promoting Pro Annual at $99/year',
      finalAnswer: 'Pro Annual now $99/year — best value for daily Claude users.',
      invocations: [],
      judgeOutcomes: ['pass'],
    });

    const result = await mintSkillsForEngagement({
      engagementId: 'eng-001',
      blueprintName: 'Content Writer',
      autonomy: 0.8,
      dialectic,
      library,
      pattern,
    });

    expect(result.taskSpecific).not.toBeNull();
    expect(result.taskSpecific?.flavor).toBe('task-specific');
    expect(result.taskSpecific?.status).toBe('accepted');
    expect(result.taskSpecific?.createdInBlueprintName).toBe('Content Writer');
    expect(result.taskSpecific?.createdInEngagementId).toBe('eng-001');

    expect(result.generalized).not.toBeNull();
    expect(result.generalized?.flavor).toBe('generalized');
    expect(result.generalized?.parentId).toBe(result.taskSpecific?.id);
    expect(result.generalized?.confidence).toBeLessThan(result.taskSpecific!.confidence);

    const listed = library.query({});
    expect(listed.length).toBe(2);
  });

  it('marks low-autonomy skills as pending-review', async () => {
    const library = new SqliteSkillsLibrary(':memory:');
    const dialectic = stubDialectic([TASK_SPECIFIC_RPP, GENERALIZED_RPP]);
    const pattern = buildPatternFromInvocations({
      blueprintName: 'Content Writer',
      operatorMessage: 'write a LinkedIn post',
      finalAnswer: 'short post body',
      invocations: [],
      judgeOutcomes: ['pass'],
    });

    const result = await mintSkillsForEngagement({
      engagementId: 'eng-002',
      blueprintName: 'Content Writer',
      autonomy: 0.2, // low — triggers pending-review for both
      dialectic,
      library,
      pattern,
    });

    expect(result.taskSpecific?.status).toBe('pending-review');
    expect(result.generalized?.status).toBe('pending-review');
  });

  it('returns null if dialectic synthesis fails', async () => {
    const library = new SqliteSkillsLibrary(':memory:');
    const failingDialectic = {
      isEnabled: () => true,
      setDepth: () => undefined,
      decide: async () => { throw new Error('dialectic failure'); },
    } as unknown as Dialectic;
    const pattern = buildPatternFromInvocations({
      blueprintName: 'Content Writer',
      operatorMessage: 'task',
      finalAnswer: 'response',
      invocations: [],
      judgeOutcomes: ['pass'],
    });

    const result = await mintSkillsForEngagement({
      engagementId: 'eng-003',
      blueprintName: 'Content Writer',
      autonomy: 0.8,
      dialectic: failingDialectic,
      library,
      pattern,
    });

    expect(result.taskSpecific).toBeNull();
    expect(result.generalized).toBeNull();
    expect(library.query({}).length).toBe(0);
  });

  it('falls back to generalized=null when the generalization answer has no R++ block', async () => {
    const library = new SqliteSkillsLibrary(':memory:');
    // First answer: valid R++. Second answer (generalization): empty.
    const dialectic = stubDialectic([TASK_SPECIFIC_RPP, '']);
    const pattern = buildPatternFromInvocations({
      blueprintName: 'Content Writer',
      operatorMessage: 'write a post',
      finalAnswer: 'response',
      invocations: [],
      judgeOutcomes: ['pass'],
    });

    const result = await mintSkillsForEngagement({
      engagementId: 'eng-004',
      blueprintName: 'Content Writer',
      autonomy: 0.8,
      dialectic,
      library,
      pattern,
    });

    expect(result.taskSpecific).not.toBeNull();
    expect(result.generalized).toBeNull();
    expect(library.query({}).length).toBe(1);
  });
});
