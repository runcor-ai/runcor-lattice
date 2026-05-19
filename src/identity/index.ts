// Identity adapter — wraps runcor-identity for the lattice.
//
// Provides:
//   - current()             : always-on snapshot of SelfTheory
//   - render()              : multi-line prompt-friendly identity block
//   - reflect(input)        : dialectic-driven reflective update (gated by readiness)
//
// Cycle fires reflect every IDENTITY_REFLECT_EVERY cycles when the data cube has
// sufficient entities (per V2's readiness gates — avoids self-isolation from inaction).

import { Identity as IdentityImpl } from 'runcor-identity';
import type { IdentityConfig, ActionInvocation } from '../types.js';
import type { Dialectic } from '../dialectic/index.js';

export interface SelfTheorySnapshot {
  version: number;
  claims: string[];
  traits: Record<string, number>;
  lastReflectedCycle: number;
  timestamp: string;
}

export interface Identity {
  current(): SelfTheorySnapshot;
  render(): string;
  reflect(currentCycle: number, recentActions: ActionInvocation[]): Promise<SelfTheorySnapshot>;
  isEnabled(): boolean;
}

class LatticeIdentity implements Identity {
  private readonly impl: IdentityImpl;
  constructor(config: IdentityConfig, dbPath: string) {
    this.impl = new IdentityImpl({ dbPath, seedClaims: config.initialClaims ?? [] });
  }
  current(): SelfTheorySnapshot {
    const t = this.impl.current();
    return { version: t.version, claims: t.claims, traits: t.traits, lastReflectedCycle: t.lastReflectedCycle, timestamp: t.timestamp };
  }
  render(): string {
    return this.impl.renderBlock();
  }
  async reflect(currentCycle: number, recentActions: ActionInvocation[]): Promise<SelfTheorySnapshot> {
    // Built later — needs dialectic from cycle. Placeholder returns current.
    void currentCycle; void recentActions;
    return this.current();
  }
  isEnabled(): boolean { return true; }
}

class DisabledIdentity implements Identity {
  private readonly desc: string;
  constructor(desc: string) { this.desc = desc; }
  current(): SelfTheorySnapshot {
    return { version: 0, claims: [`I am: ${this.desc}`], traits: {}, lastReflectedCycle: 0, timestamp: new Date().toISOString() };
  }
  render(): string { return `IDENTITY: ${this.desc}`; }
  async reflect(_c: number, _r: ActionInvocation[]): Promise<SelfTheorySnapshot> { return this.current(); }
  isEnabled(): boolean { return false; }
}

export function createIdentity(config: IdentityConfig, dbPath: string | undefined, dialectic: Dialectic): Identity {
  void dialectic; // reserved for future reflect() wiring
  if (!dbPath) return new DisabledIdentity(config.description);
  try {
    return new LatticeIdentity(config, dbPath);
  } catch {
    return new DisabledIdentity(config.description);
  }
}

/** Stronger Identity that supports reflect via injected dialectic. */
export function reflectIdentity(identity: Identity, dialectic: Dialectic, currentCycle: number, recentActions: ActionInvocation[], goalContext: string): Promise<SelfTheorySnapshot> {
  if (!(identity as { impl?: IdentityImpl }).impl || !dialectic.isEnabled()) {
    return Promise.resolve(identity.current());
  }
  const impl = (identity as unknown as { impl: IdentityImpl }).impl;
  return impl.reflect({
    recentActions: recentActions.map((a) => ({ action: a.name, confidence: 1, score: 0.7 })),
    context: `Cycle ${currentCycle}. Goals:\n${goalContext}`,
    dialectic: async ({ problem, maxRounds }) => {
      const r = await dialectic.decide({ problem, ...(typeof maxRounds === 'number' ? { maxRounds } : {}) });
      return { answer: r.answer };
    },
    currentCycle,
    cause: 'periodic',
  }).then((t) => ({ version: t.version, claims: t.claims, traits: t.traits, lastReflectedCycle: t.lastReflectedCycle, timestamp: t.timestamp }));
}
