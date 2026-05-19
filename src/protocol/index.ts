// Lattice protocol — peer-to-peer interaction between lattices.
//
// Per spec §9 + the operator's MCP-as-coordination decision (see project memory
// `lattice-rebuild-status-2026-05-18-evening`): each lattice exposes its operational
// surface as an MCP server; other lattices' runcor-integration discovers those tools at
// boot. Agent in lattice-B sees `dev-lattice.memory.search` as just another tool in its
// capability list. The Bridge orchestrates topology but does NOT route messages.
//
// Day-9 scope:
//   1. Define the LatticeProtocol adapter surface (publishTrace, subscribeToTrace,
//      bridgeMemory, sendMessage) — verbatim from spec
//   2. In-process implementation via a process-local registry — two lattices in the
//      same process can interact for tests + smoke runs
//   3. MCP server/discovery wiring is marked DEFERRED with a clear path: each method
//      already has the right shape to become an MCP tool call
//
// Real MCP integration follows when the Bridge needs cross-process peering — until
// then, single-process tests prove the wiring is correct.

import type { Agent, LatticeProtocolConfig, ObservationStream, TraceEntry } from '../types.js';
import type { Memory } from '../memory/index.js';
import type { Trace } from '../trace/index.js';
import { createLatticeMcpServer, type LatticeMcpServer } from './mcp-server.js';
import { connectPeer, type PeerClient } from './mcp-client.js';

// ─── Public adapter surface (matches spec §9 interface) ────────────────────

export interface LatticeMessage {
  /** Sender lattice ID. Populated by the protocol when forwarded to a recipient. */
  from: string;
  /** Free-text payload. Future versions may add structured fields. */
  text: string;
  /** Wall-clock send time (ms). */
  ts: number;
}

export interface PublishedTrace {
  latticeId: string;
  stream: ObservationStream;
}

export type MemoryScope = 'all' | 'short' | 'long' | 'tagged';

export interface MemoryBridge {
  /** Read peer memory via the bridge. The implementation determines what's accessible. */
  search(query: string, k?: number): Promise<Array<{ content: string; M: number; cube: 'short' | 'long' }>>;
}

export interface LatticeProtocol {
  /** Make this lattice's trace stream available to other lattices. Idempotent. */
  publishTrace(latticeId: string, stream: ObservationStream): void;
  /** Get the latest published trace for a peer (returns null if peer hasn't published). */
  subscribeToTrace(latticeId: string): ObservationStream | null;
  /** Establish a read-only memory bridge to a peer (in-process or via MCP URL). */
  bridgeMemory(latticeId: string, scope: MemoryScope): MemoryBridge | null;
  /** Async variant — required for cross-process MCP bridges where the underlying call is HTTP. */
  bridgeMemoryAsync(latticeId: string, scope: MemoryScope): Promise<MemoryBridge | null>;
  /** Send a message to a peer's inbox. Returns true when delivered (sync — local registry path). */
  sendMessage(latticeId: string, message: Omit<LatticeMessage, 'from' | 'ts'> & { from: string }): boolean;
  /** Async variant — required for cross-process MCP sends (HTTP round-trip). */
  sendMessageAsync(latticeId: string, message: Omit<LatticeMessage, 'from' | 'ts'> & { from: string }): Promise<boolean>;
  /** Drain this lattice's inbox — typically called by the cycle in the observe phase. */
  drainInbox(): LatticeMessage[];
  /** Start the MCP server (if config.publish.endpoint is set) + connect to remote peers. */
  initialize(memory: Memory, trace: Trace): Promise<void>;
  /** Stop the MCP server + close peer clients. */
  shutdown(): Promise<void>;
}

// ─── In-process registry (placeholder for MCP) ────────────────────────────

interface RegistryEntry {
  stream: ObservationStream | null;
  memory: Memory | null;
  inbox: LatticeMessage[];
}

const REGISTRY = new Map<string, RegistryEntry>();

/** For tests + cross-lattice in-process setups: register a lattice's memory so peers
 *  can bridgeMemory() to it. Called by the cycle when protocol is configured. */
export function registerPeerMemory(latticeId: string, memory: Memory): void {
  const entry = ensureEntry(latticeId);
  entry.memory = memory;
}

function ensureEntry(latticeId: string): RegistryEntry {
  let entry = REGISTRY.get(latticeId);
  if (!entry) {
    entry = { stream: null, memory: null, inbox: [] };
    REGISTRY.set(latticeId, entry);
  }
  return entry;
}

/** Test utility — wipe the in-process registry. Not exported as a public API. */
export function __resetProtocolRegistry(): void {
  REGISTRY.clear();
}

// ─── Implementation ────────────────────────────────────────────────────────

class LatticeProtocolImpl implements LatticeProtocol {
  private mcpServer: LatticeMcpServer | null = null;
  private readonly peerClients = new Map<string, PeerClient>();

  constructor(private readonly config: LatticeProtocolConfig) {
    ensureEntry(config.latticeId);
  }

  publishTrace(latticeId: string, stream: ObservationStream): void {
    const entry = ensureEntry(latticeId);
    entry.stream = stream;
  }

  subscribeToTrace(latticeId: string): ObservationStream | null {
    return REGISTRY.get(latticeId)?.stream ?? null;
  }

  bridgeMemory(latticeId: string, scope: MemoryScope): MemoryBridge | null {
    const peerMemory = REGISTRY.get(latticeId)?.memory;
    if (!peerMemory || !peerMemory.isEnabled()) return null;
    return this.makeInProcessBridge(peerMemory, scope);
  }

  async bridgeMemoryAsync(latticeId: string, scope: MemoryScope): Promise<MemoryBridge | null> {
    // Try in-process first (fast path).
    const local = this.bridgeMemory(latticeId, scope);
    if (local) return local;
    // Fall back to MCP client.
    const peer = this.peerClients.get(latticeId);
    if (!peer) return null;
    return {
      async search(query, k = 5) {
        const results = await peer.bridge.search(query, k);
        return (scope === 'all' || scope === 'tagged') ? results : results.filter((r) => r.cube === scope);
      },
    };
  }

  sendMessage(latticeId: string, message: Omit<LatticeMessage, 'from' | 'ts'> & { from: string }): boolean {
    const entry = REGISTRY.get(latticeId);
    if (!entry) return false;
    entry.inbox.push({ from: message.from, text: message.text, ts: Date.now() });
    return true;
  }

  async sendMessageAsync(latticeId: string, message: Omit<LatticeMessage, 'from' | 'ts'> & { from: string }): Promise<boolean> {
    // In-process first.
    if (this.sendMessage(latticeId, message)) return true;
    // MCP fallback.
    const peer = this.peerClients.get(latticeId);
    if (!peer) return false;
    return peer.send({ from: message.from, text: message.text });
  }

  drainInbox(): LatticeMessage[] {
    const entry = REGISTRY.get(this.config.latticeId);
    if (!entry) return [];
    const messages = [...entry.inbox];
    entry.inbox = [];
    return messages;
  }

  async initialize(memory: Memory, trace: Trace): Promise<void> {
    // Start MCP server if publish.endpoint is configured.
    if (this.config.publish?.endpoint !== undefined) {
      this.mcpServer = createLatticeMcpServer({
        latticeId: this.config.latticeId,
        memory,
        trace,
        enqueueMessage: (msg) => {
          const entry = ensureEntry(this.config.latticeId);
          entry.inbox.push(msg);
        },
      });
      await this.mcpServer.listen(this.config.publish.endpoint);
    }
    // Connect to subscribed peers over MCP.
    for (const sub of this.config.subscriptions ?? []) {
      if (sub.url) {
        try {
          const client = await connectPeer({ endpoint: { latticeId: sub.latticeId, url: sub.url } });
          this.peerClients.set(sub.latticeId, client);
        } catch {
          // Connection failure is non-fatal — the in-process fallback may still work.
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const client of this.peerClients.values()) await client.close().catch(() => {});
    this.peerClients.clear();
    if (this.mcpServer) await this.mcpServer.close().catch(() => {});
    this.mcpServer = null;
  }

  private makeInProcessBridge(peerMemory: Memory, scope: MemoryScope): MemoryBridge {
    return {
      async search(query, k = 5) {
        const results = await peerMemory.recall(query, k);
        const filtered = scope === 'all' || scope === 'tagged' ? results : results.filter((r) => r.cube === scope);
        return filtered.map((r) => ({ content: r.content, M: r.M, cube: r.cube }));
      },
    };
  }
}

class DisabledProtocol implements LatticeProtocol {
  publishTrace(): void { /* no-op */ }
  subscribeToTrace(): ObservationStream | null { return null; }
  bridgeMemory(): MemoryBridge | null { return null; }
  async bridgeMemoryAsync(): Promise<MemoryBridge | null> { return null; }
  sendMessage(): boolean { return false; }
  async sendMessageAsync(): Promise<boolean> { return false; }
  drainInbox(): LatticeMessage[] { return []; }
  async initialize(): Promise<void> { /* no-op */ }
  async shutdown(): Promise<void> { /* no-op */ }
}

export function createLatticeProtocol(config: LatticeProtocolConfig | undefined): LatticeProtocol {
  if (!config) return new DisabledProtocol();
  return new LatticeProtocolImpl(config);
}

// ─── MCP integration (DEFERRED) ────────────────────────────────────────────
//
// The cross-process MCP wiring lives here when it lands. The plan, captured to make the
// scope explicit:
//
// 1. Each LatticeProtocolImpl spins up an MCP server exposing the same operations
//    (publishTrace → MCP resource subscription; bridgeMemory → MCP tool call;
//    sendMessage → MCP tool call into the peer's inbox).
//
// 2. LatticeProtocolConfig.subscriptions is fed to runcor-integration's ReachableSource
//    list with kind='mcp_server'. The integration discovers the tools at boot.
//
// 3. subscribeToTrace + bridgeMemory + sendMessage check the local registry first
//    (in-process peering, fast path), then fall back to MCP if no local peer matches.
//
// 4. The Bridge issues capability tokens that gate which MCP tools each lattice can
//    invoke on a peer — orchestrating topology without routing messages.
//
// Until those land, in-process peering covers the test surface and smoke runs.

// Public type re-export so consumers don't have to deep-import.
export type { ObservationStream, TraceEntry, Agent };
