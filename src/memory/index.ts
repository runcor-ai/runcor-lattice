// Memory adapter — wraps runcor-memory for the Loop's recall + write phases.
//
// Per spec §3, three faces:
//   - Past — short-term + long-term cubes governed by M = R·ln(f+1)·e^(-t/(τ·D))
//   - Present — working state during current cycle
//   - Future — rolling plan, rewritten when cubes shift
//
// Day-3 status: cubes + record + recall + cycle() are wired. Plan rewrite + procedural memory
// are deferred to later spec passes (the spec marks procedural as "external validation signal"
// dependent — fits later when skills + meta come online).
//
// Embeddings require an OpenAI key. When the key is absent (tests, smoke runs without an
// API key), the adapter returns a no-op implementation that emits trace entries but performs
// no actual record/recall — the cycle stays runnable.

import { MemorySystem, MemoryDatabase, type QueryResult, type RecordOptions } from 'runcor-memory';
import type { MemoryConfig } from '../types.js';

// ─── Public adapter surface ────────────────────────────────────────────────

export interface RecalledMemory {
  id: string;
  content: string;
  M: number;
  similarity: number;
  cube: 'short' | 'long';
}

export interface RecordResult {
  action: 'created' | 'reinforced' | 'disabled';
  nodeId: string | null;
}

export interface Memory {
  /** Top-k semantic recall against the current cycle's query. */
  recall(query: string, k?: number): Promise<RecalledMemory[]>;
  /** Persist an event with reinforcement strength `R` (default 0.5). */
  record(content: string, opts?: RecordOptions): Promise<RecordResult>;
  /** Reinforce an existing node's `f` by `amount` (default 1). Returns true if found. */
  reinforce(id: string, amount?: number): boolean;
  /** Run R9 consolidation cycle (decay + promotion + plan refresh). */
  cycle(currentCycle: number): Promise<{ promoted: number; forgotten: number }>;
  /** Snapshot of in-memory counts for trace / dashboard inspection. */
  stats(): { total: number; shortCube: number; longCube: number };
  /** Whether the adapter is operating in disabled (no-key) mode. */
  isEnabled(): boolean;
}

// ─── Implementation ────────────────────────────────────────────────────────

class LatticeMemory implements Memory {
  private readonly system: MemorySystem;
  private readonly db: MemoryDatabase;

  constructor(config: MemoryConfig, private readonly openaiKey: string) {
    this.db = new MemoryDatabase(config.dbPath);
    this.system = new MemorySystem({
      db: this.db,
      openaiApiKey: openaiKey,
      ...(typeof config.tau === 'number' || typeof config.depth === 'number'
        ? { config: { ...(typeof config.tau === 'number' ? { tau: config.tau } : {}), ...(typeof config.depth === 'number' ? { D: config.depth } : {}) } }
        : {}),
    });
  }

  async recall(query: string, k = 5): Promise<RecalledMemory[]> {
    if (!query) return [];
    const results: QueryResult[] = await this.system.query(query, k);
    return results.map((r) => ({
      id: r.node.id,
      content: r.node.content,
      M: r.node.M,
      similarity: r.similarity,
      cube: r.node.cube as 'short' | 'long',
    }));
  }

  async record(content: string, opts: RecordOptions = {}): Promise<RecordResult> {
    const res = await this.system.record(content, opts);
    return { action: res.action, nodeId: res.nodeId };
  }

  reinforce(id: string, amount = 1): boolean {
    return this.system.reinforce(id, amount);
  }

  async cycle(currentCycle: number): Promise<{ promoted: number; forgotten: number }> {
    this.system.setCycle(currentCycle);
    const report = await this.system.cycle();
    // CycleReport shape varies across versions; pick the load-bearing counts defensively.
    const r = report as unknown as { promotions?: { count: number }; forgotten?: number; promoted?: number };
    return {
      promoted: r.promoted ?? r.promotions?.count ?? 0,
      forgotten: r.forgotten ?? 0,
    };
  }

  stats(): { total: number; shortCube: number; longCube: number } {
    const all = this.system.getAll();
    let short = 0;
    let long = 0;
    for (const n of all) {
      if (n.cube === 'long') long += 1;
      else short += 1;
    }
    return { total: all.length, shortCube: short, longCube: long };
  }

  isEnabled(): boolean {
    return !!this.openaiKey;
  }
}

class DisabledMemory implements Memory {
  async recall(_query: string, _k?: number): Promise<RecalledMemory[]> { return []; }
  async record(_content: string, _opts?: RecordOptions): Promise<RecordResult> { return { action: 'disabled', nodeId: null }; }
  reinforce(_id: string, _amount?: number): boolean { return false; }
  async cycle(_currentCycle: number): Promise<{ promoted: number; forgotten: number }> { return { promoted: 0, forgotten: 0 }; }
  stats(): { total: number; shortCube: number; longCube: number } { return { total: 0, shortCube: 0, longCube: 0 }; }
  isEnabled(): boolean { return false; }
}

export function createMemory(config: MemoryConfig): Memory {
  const key = config.openaiKey ?? process.env['OPENAI_API_KEY'] ?? '';
  if (!key) return new DisabledMemory();
  return new LatticeMemory(config, key);
}
