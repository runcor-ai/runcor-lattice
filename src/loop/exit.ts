// Exit-condition evaluator — checks between cycles whether the loop should terminate.
//
// Per spec §1, four exit conditions:
//   1. goal-complete         — completion predicate satisfied
//   2. budget-exhausted      — any budget cap reached
//   3. substrate-hard-stop   — substrate raised a non-recoverable Law violation
//   4. manual-stop           — agent.stop() called (handled inside the loop itself)
//
// Returns the first matching reason, or null if the loop should continue.

export type ExitReason =
  | 'goal-complete'
  | 'budget-exhausted'
  | 'substrate-hard-stop'
  | 'manual-stop';

export interface ExitCheckInput {
  cycle: number;
  budget: { tokens?: number; dollars?: number; time?: number };
  spent: { tokens: number; dollars: number };
  elapsedMs: number;
  goalsComplete: boolean;
  substrateHardStop: boolean;
}

export function computeExit(input: ExitCheckInput): ExitReason | null {
  if (input.goalsComplete) return 'goal-complete';
  if (input.substrateHardStop) return 'substrate-hard-stop';
  if (typeof input.budget.dollars === 'number' && input.spent.dollars >= input.budget.dollars) return 'budget-exhausted';
  if (typeof input.budget.tokens === 'number' && input.spent.tokens >= input.budget.tokens) return 'budget-exhausted';
  if (typeof input.budget.time === 'number' && input.elapsedMs >= input.budget.time) return 'budget-exhausted';
  return null;
}
