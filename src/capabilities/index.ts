// Capability registry — the agent's tool surface.
//
// Lattice's act phase parses a tool-call directive from the dialectic's decision text
// and executes the matching capability. The result string is captured for the judge
// phase (substrate discernment runs over it) and the write phase (episodic memory).
//
// Parse contract (the dialectic is told to emit at most ONE line in this shape):
//   INVOKE: <capability_name> {"arg1": "value", ...}
//
// Capabilities are passed in at instantiation via LatticeConfig.capabilities. There is
// no global registry — each lattice owns its own surface.

import type { ActionInvocation, Capability, CapabilityContext } from '../types.js';

export interface ParsedInvocation {
  name: string;
  args: Record<string, unknown>;
}

const INVOKE_PATTERN = /INVOKE:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*?\})/g;

/** Extract a `INVOKE: name { ... }` directive from free-text dialectic output.
 *  When multiple INVOKE lines are present, the LAST is used (so the model can show its
 *  reasoning with intermediate "what about INVOKE: ..." musings without breaking parse).
 *  Returns null when no invocation line is present or the JSON is malformed. */
export function parseInvocation(answer: string): ParsedInvocation | null {
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  // Re-anchor the global regex each call (RegExp.exec mutates lastIndex).
  INVOKE_PATTERN.lastIndex = 0;
  while ((m = INVOKE_PATTERN.exec(answer)) !== null) {
    last = m;
    // Defend against zero-width match infinite loops (paranoia).
    if (m.index === INVOKE_PATTERN.lastIndex) INVOKE_PATTERN.lastIndex += 1;
  }
  if (!last) return null;
  const name = last[1]!;
  try {
    const args = JSON.parse(last[2]!) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null) return null;
    return { name, args };
  } catch {
    return null;
  }
}

/** Format the capability list for inclusion in the decide-phase prompt. */
export function renderCapabilityCatalog(capabilities: Capability[]): string {
  if (capabilities.length === 0) return '(no capabilities — agent cannot take external actions)';
  const lines = ['Available capabilities — invoke at most ONE per cycle by emitting (on its own line, at the END of your answer):'];
  lines.push('  INVOKE: <capability_name> {"arg1": "value", ...}');
  lines.push('');
  for (const c of capabilities) {
    lines.push(`- ${c.name} — ${c.description}`);
  }
  return lines.join('\n');
}

export interface ExecutionResult {
  invocation: ActionInvocation | null;
  /** Set when the agent's answer included an INVOKE line but execution failed. */
  error: string | null;
}

/** Execute a capability by name with the parsed args. Returns the invocation record. */
export async function executeCapability(
  parsed: ParsedInvocation,
  capabilities: Capability[],
  ctx: CapabilityContext,
): Promise<ExecutionResult> {
  const cap = capabilities.find((c) => c.name === parsed.name);
  if (!cap) {
    return { invocation: null, error: `unknown capability: ${parsed.name}` };
  }
  const startedAt = Date.now();
  try {
    const result = await cap.handler(parsed.args, ctx);
    return {
      invocation: {
        name: cap.name,
        args: parsed.args,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        durationMs: Date.now() - startedAt,
      },
      error: null,
    };
  } catch (e) {
    return {
      invocation: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
