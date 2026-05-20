// Goals adapter — wraps runcor-goals (Purpose / Objective / Initiative stack).
//
// Cycle calls:
//   - goals.decayStep(cycle) every cycle — accepted goals slowly lose intensity, retire below threshold
//   - goals.propose(...) every N cycles via dialectic — operator-tunable cadence
//
// Initial goals in LatticeConfig.goals.initial[] are accepted at construction so the
// agent has something to ground decision-making on from cycle 0.

import { Goals as GoalsImpl, type GoalLevel } from 'runcor-goals';
import type { GoalConfig } from '../types.js';
import type { Dialectic } from '../dialectic/index.js';

export interface GoalSnapshot {
  id: number;
  level: 'purpose' | 'objective' | 'initiative';
  text: string;
  intensity: number;
  createdAt: string;
  parentId?: number;
}

export interface GoalsAdapter {
  /** Active goals across all levels, sorted purpose→objective→initiative then by intensity DESC. */
  stack(currentCycle: number): GoalSnapshot[];
  /** Cycle-end decay step. Returns counts of what got retired. */
  decayStep(currentCycle: number): { activeBefore: number; retiredThisStep: number };
  /** Run dialectic-driven proposal + accept top candidates. Returns # accepted. */
  proposeAndAccept(currentCycle: number, recentActionNames: string[], context: string, level?: 'initiative' | 'objective'): Promise<number>;
  isEnabled(): boolean;
}

class LatticeGoals implements GoalsAdapter {
  private readonly impl: GoalsImpl;
  constructor(dbPath: string) {
    this.impl = new GoalsImpl({ dbPath });
  }
  init(initial: GoalConfig['initial']): void {
    // Dedup-on-init: runcor-goals.accept() does NOT check for duplicate
    // (level + text) entries — it always inserts. Since LatticeConfig.goals.dbPath
    // is typically shared across engagements (e.g. './data/ceo-goals.db' for the
    // CEO blueprint), this previously caused each engagement to ADD another copy
    // of every initial goal. After N runs the stack contained N copies, blowing
    // up the agent's prompt context with duplicated purpose/objective entries.
    // Fix: check the existing stack for an entry with the same (level + text);
    // if present, REINFORCE it (re-asserts priority semantically); if absent,
    // accept it as a new entry. Either way, exactly one copy per (level + text).
    const existing = this.impl.stack(0);
    const seen = new Map<string, number>(); // key = level|text → id
    for (const g of [...existing.purposes, ...existing.objectives, ...existing.initiatives]) {
      seen.set(`${g.level}|${g.text}`, g.id);
    }
    for (const g of initial) {
      const key = `${g.level}|${g.statement}`;
      const existingId = seen.get(key);
      if (existingId !== undefined) {
        try {
          this.impl.reinforce(existingId, { currentCycle: 0 });
        } catch { /* non-fatal — goal exists, that's the important property */ }
        continue;
      }
      try {
        const newId = this.impl.accept({ level: g.level as GoalLevel, text: g.statement }, { currentCycle: 0 });
        seen.set(key, newId);
      } catch { /* non-fatal */ }
    }
  }
  stack(currentCycle: number): GoalSnapshot[] {
    const s = this.impl.stack(currentCycle);
    const flat: GoalSnapshot[] = [
      ...s.purposes.map(toSnap),
      ...s.objectives.map(toSnap),
      ...s.initiatives.map(toSnap),
    ];
    return flat;
  }
  decayStep(currentCycle: number): { activeBefore: number; retiredThisStep: number } {
    return this.impl.decayStep(currentCycle);
  }
  async proposeAndAccept(currentCycle: number, recentActionNames: string[], context: string, level: 'initiative' | 'objective' = 'initiative'): Promise<number> {
    void recentActionNames; void context; void level;
    return 0; // delegated to the cycle's propose helper below
  }
  isEnabled(): boolean { return true; }
}

class DisabledGoals implements GoalsAdapter {
  private readonly seeded: GoalSnapshot[];
  constructor(initial: GoalConfig['initial']) {
    this.seeded = initial.map((g, i) => ({
      id: i + 1,
      level: g.level,
      text: g.statement,
      intensity: 1.0,
      createdAt: new Date().toISOString(),
    }));
  }
  stack(_c: number): GoalSnapshot[] { return [...this.seeded]; }
  decayStep(_c: number): { activeBefore: number; retiredThisStep: number } { return { activeBefore: this.seeded.length, retiredThisStep: 0 }; }
  async proposeAndAccept(): Promise<number> { return 0; }
  isEnabled(): boolean { return false; }
}

function toSnap(g: { id: number; level: string; text: string; intensity: number; createdAt: string; parentId?: number }): GoalSnapshot {
  const out: GoalSnapshot = {
    id: g.id,
    level: g.level as 'purpose' | 'objective' | 'initiative',
    text: g.text,
    intensity: g.intensity,
    createdAt: g.createdAt,
  };
  if (g.parentId !== undefined) out.parentId = g.parentId;
  return out;
}

export function createGoalsAdapter(config: GoalConfig, dialectic: Dialectic): GoalsAdapter {
  void dialectic;
  if (!config.dbPath || config.dbPath === ':memory:') {
    return new DisabledGoals(config.initial);
  }
  try {
    const g = new LatticeGoals(config.dbPath);
    g.init(config.initial);
    return g;
  } catch {
    return new DisabledGoals(config.initial);
  }
}

/** Helper for the cycle to drive proposal via the dialectic. Returns # accepted. */
export async function proposeGoalsViaDialectic(
  goals: GoalsAdapter,
  dialectic: Dialectic,
  currentCycle: number,
  recentActionNames: string[],
  context: string,
): Promise<number> {
  if (!goals.isEnabled() || !dialectic.isEnabled()) return 0;
  // We talk to runcor-goals.propose directly because the LatticeGoals wraps it
  // but the cycle owns the dialectic injection (so we can show it in the trace).
  const impl = (goals as unknown as { impl: GoalsImpl }).impl;
  if (!impl || typeof impl.propose !== 'function') return 0;
  try {
    const candidates = await impl.propose({
      recentActions: recentActionNames.map((a) => ({ action: a })),
      context,
      level: 'initiative',
      dialectic: async ({ problem, maxRounds }) => {
        const r = await dialectic.decide({ problem, ...(typeof maxRounds === 'number' ? { maxRounds } : {}) });
        return { answer: r.answer };
      },
    });
    let accepted = 0;
    for (const c of candidates.slice(0, 2)) {
      try { impl.accept(c, { currentCycle }); accepted += 1; } catch { /* skip */ }
    }
    return accepted;
  } catch {
    return 0;
  }
}
