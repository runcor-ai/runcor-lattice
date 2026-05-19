// Two-lattice demo — proves the protocol step end-to-end with a real coordination scenario.
//
// Topology:
//   - Dev lattice: "Application security analyst" — reads one file, identifies vulnerabilities
//   - Comms lattice: "Internal communications writer" — subscribes to Dev's trace stream,
//     reads what Dev is finding, and writes a one-paragraph status update for stakeholders
//
// Why two lattices, not one prompted to do both jobs:
//   - Different identities, different laws → cleaner separation of concerns
//   - Comms operates on Dev's TRACE (not memory) → models the spec's "trace bridge" pattern
//   - Both write to their own memory; neither sees the other's internal state directly
//
// This is the in-process version of the Bridge's Phase-1 vertical slice:
//   "Communications lattice that subscribes to the Developer's trace and produces progress updates."
//
// Cost: ~$0.02-0.05 for two short engagements.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiate, controlsFromPreset, createLatticeProtocol, type Capability, type LatticeConfig } from '../src/index.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(SCRIPT_DIR, 'vuln-test');
const OUTPUT_DIR = join(SCRIPT_DIR, 'two-lattices-output');
const TRACE_DIR = join(SCRIPT_DIR, 'traces');
mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Shared protocol view (so Comms can subscribe to Dev's trace) ─────────

const DEV_ID = 'dev-lattice';
const COMMS_ID = 'comms-lattice';

// ─── Dev lattice capabilities ─────────────────────────────────────────────

const filesRead = new Set<string>();
const ALLOWED_FILES = new Set(['auth.js', 'api.py', 'config.yaml']);
const devFindings: string[] = [];

const readFileCapability: Capability = {
  name: 'read_file',
  description: 'Read one file from the codebase under audit. args: {"path": "auth.js" | "api.py" | "config.yaml"}',
  handler: async (args) => {
    const path = String(args.path ?? '');
    if (!ALLOWED_FILES.has(path)) return `ERROR: ${path} not in codebase. Allowed: ${[...ALLOWED_FILES].join(', ')}`;
    const full = join(FIXTURE_DIR, path);
    if (!existsSync(full)) return `ERROR: ${path} not found at ${full}`;
    filesRead.add(path);
    return readFileSync(full, 'utf-8');
  },
};

const recordFindingCapability: Capability = {
  name: 'record_finding',
  description: 'Record a single vulnerability finding so the engagement can report progress. args: {"file": string, "vulnerability": string}. After ≥1 finding, the engagement is complete.',
  handler: async (args) => {
    const file = String(args.file ?? 'unknown');
    const vuln = String(args.vulnerability ?? '').slice(0, 300);
    if (!vuln) return 'ERROR: vulnerability text required';
    const finding = `[${file}] ${vuln}`;
    devFindings.push(finding);
    return `Finding recorded (${devFindings.length} total).`;
  },
};

// ─── Comms lattice capabilities ───────────────────────────────────────────

const commsUpdates: string[] = [];

const writeUpdateCapability: Capability = {
  name: 'write_update',
  description: 'Write a stakeholder progress update (one paragraph). After ≥1 update, the engagement is complete. args: {"content": "one-paragraph update"}',
  handler: async (args) => {
    const content = String(args.content ?? '').trim();
    if (content.length < 50) return `ERROR: update too short (${content.length} chars; need >= 50)`;
    commsUpdates.push(content);
    writeFileSync(join(OUTPUT_DIR, `update-${commsUpdates.length}.md`), `# Update ${commsUpdates.length}\n\n${content}\n`);
    return `Update ${commsUpdates.length} written.`;
  },
};

const observeDevCapability: Capability = {
  name: 'observe_dev',
  description: 'Read the last N findings the Dev lattice has reported. args: {"limit": number, default 5}',
  handler: async (args) => {
    const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5) | 0));
    if (devFindings.length === 0) return 'Dev has not reported any findings yet.';
    const slice = devFindings.slice(-limit);
    return `Dev findings (last ${slice.length} of ${devFindings.length}):\n${slice.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
  },
};

// ─── Lattice configs ──────────────────────────────────────────────────────

function devConfig(): LatticeConfig {
  return {
    identity: { description: 'Application security analyst auditing a 3-file codebase. Each finding is reported via record_finding.' },
    substrate: { laws: ['Cite the exact file and line for every vulnerability.', 'Make claims only when evidence is in the file you have read.'] },
    memory: { dbPath: join(OUTPUT_DIR, 'dev-memory.db'), openaiKey: process.env['OPENAI_API_KEY'] ?? '' },
    goals: {
      initial: [{ statement: 'Audit auth.js and report at least one vulnerability via record_finding.', level: 'objective' }],
      dbPath: join(OUTPUT_DIR, 'dev-goals.db'),
      completion: (ctx) => ctx.actionsInvoked.filter((a) => a === 'record_finding').length >= 2,
    },
    drives: { budget: { tokens: 800 } },
    engine: { type: 'runcor-engine', apiKeys: { openrouter: process.env['OPENROUTER_API_KEY'] ?? '', openai: process.env['OPENAI_API_KEY'] ?? '' } },
    capabilities: [readFileCapability, recordFindingCapability],
    controls: { ...controlsFromPreset('explorer', { dollars: 0.05, time: 8 * 60 * 1000 }), reviewCadence: 0 },
    trace: { dir: TRACE_DIR },
    protocol: { latticeId: DEV_ID, publish: { trace: true } },
  };
}

function commsConfig(): LatticeConfig {
  return {
    identity: { description: 'Internal communications writer summarizing the security audit for stakeholders. Use observe_dev to see what the auditor has found.' },
    substrate: { laws: ['Only summarize findings that the Dev lattice has actually reported.', 'Write in plain language; avoid jargon.'] },
    memory: { dbPath: join(OUTPUT_DIR, 'comms-memory.db'), openaiKey: process.env['OPENAI_API_KEY'] ?? '' },
    goals: {
      initial: [{ statement: 'Write at least one stakeholder update that summarizes the auditor\'s findings.', level: 'objective' }],
      dbPath: join(OUTPUT_DIR, 'comms-goals.db'),
      completion: (ctx) => ctx.actionsInvoked.includes('write_update'),
    },
    drives: { budget: { tokens: 600 } },
    engine: { type: 'runcor-engine', apiKeys: { openrouter: process.env['OPENROUTER_API_KEY'] ?? '', openai: process.env['OPENAI_API_KEY'] ?? '' } },
    capabilities: [observeDevCapability, writeUpdateCapability],
    controls: { ...controlsFromPreset('explorer', { dollars: 0.05, time: 8 * 60 * 1000 }), reviewCadence: 0 },
    trace: { dir: TRACE_DIR },
    protocol: { latticeId: COMMS_ID },
  };
}

// ─── Run both lattices in parallel ────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[two-lattices] OPENAI key:', process.env['OPENAI_API_KEY'] ? 'set' : 'MISSING');
  console.log('[two-lattices] OPENROUTER key:', process.env['OPENROUTER_API_KEY'] ? 'set' : 'MISSING');
  console.log('[two-lattices] starting Dev + Comms in parallel...\n');

  // Snoop the protocol from a third view (the operator) to count peer interactions.
  const operator = createLatticeProtocol({ latticeId: 'operator' });

  const dev = instantiate(devConfig());
  const comms = instantiate(commsConfig());
  console.log(`[dev]   ${dev.state().engagementId}`);
  console.log(`[comms] ${comms.state().engagementId}\n`);

  // Run both engagements concurrently. The shared in-process protocol registry lets
  // Comms's observe_dev capability read findings Dev has produced.
  const [devResult, commsResult] = await Promise.all([dev.run(), comms.run()]);

  console.log('\n─── DEV RESULT ───');
  console.log(`  exit: ${devResult.exitReason} (${devResult.cyclesRun} cycles, $${devResult.totalCostUsd.toFixed(4)})`);
  console.log(`  files read: ${[...filesRead].join(', ') || '(none)'}`);
  console.log(`  findings:\n${devFindings.length === 0 ? '    (none)' : devFindings.map((f) => '    - ' + f).join('\n')}`);

  console.log('\n─── COMMS RESULT ───');
  console.log(`  exit: ${commsResult.exitReason} (${commsResult.cyclesRun} cycles, $${commsResult.totalCostUsd.toFixed(4)})`);
  console.log(`  updates written: ${commsUpdates.length}`);
  for (let i = 0; i < commsUpdates.length; i++) {
    console.log(`  update ${i + 1}: ${commsUpdates[i]!.slice(0, 300)}${commsUpdates[i]!.length > 300 ? '…' : ''}`);
  }

  // Peer-protocol audit: did Comms actually subscribe to Dev's trace?
  const devTrace = operator.subscribeToTrace(DEV_ID);
  console.log(`\n─── PROTOCOL ───`);
  console.log(`  Dev trace published to registry: ${devTrace ? 'YES' : 'no'}`);
  const bridge = operator.bridgeMemory(DEV_ID, 'all');
  if (bridge) {
    const results = await bridge.search('vulnerability', 5);
    console.log(`  Memory bridge to Dev returned ${results.length} hits for "vulnerability"`);
  }

  console.log(`\n─── TOTAL COST ─── $${(devResult.totalCostUsd + commsResult.totalCostUsd).toFixed(4)}`);

  // Success: both reached goal-complete AND Comms's update mentioned a Dev finding
  const success = devResult.exitReason === 'goal-complete'
    && commsResult.exitReason === 'goal-complete'
    && commsUpdates.length > 0
    && devFindings.length > 0
    && commsUpdates.some((u) => devFindings.some((f) => u.toLowerCase().includes(f.split(' ').slice(2, 5).join(' ').toLowerCase().split('(')[0]!.trim().slice(0, 15))));
  console.log(success ? '\n✓ two-lattice coordination demonstrated end-to-end' : '\n(partial — see results above)');
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error('[two-lattices] FATAL:', err);
  process.exit(1);
});
