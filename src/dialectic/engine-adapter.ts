// EngineProviderAdapter — bridges runcor-dialectic's ProviderAdapter contract to
// the runcor engine. When a lattice is instantiated with EngineRef.instance set
// to a live Runcor engine, this adapter is registered under the names that the
// dialectic library expects (e.g. "openrouter"). Every model call dialectic
// makes therefore routes through the engine's ModelRouter — getting provider
// fallback, cost ledger entries, telemetry spans, policy guardrails, and
// quality evaluation for free.
//
// Mechanism: a one-shot 'model.complete' flow is registered on the engine on
// first use. Each adapter call triggers that flow, which simply calls
// ctx.model.complete(input). Triggering inside an engine flow is the only way
// to get a ModelInterface (ctx.model) outside the engine's internals.

import type { ProviderAdapter, ProviderMessage, ProviderCallOptions, ProviderResult } from 'runcor-dialectic';
import { computeCost } from 'runcor-dialectic';
import type { Runcor } from 'runcor';
import { randomUUID } from 'node:crypto';

const MODEL_COMPLETE_FLOW = 'lattice.model.complete';
const registeredEngines = new WeakSet<object>();

/** Register the engine-side 'model.complete' flow once per engine instance.
 *  Idempotent — safe to call multiple times for the same engine.
 *  Flow timeout is bumped from the engine default 30s to 300s — Player/Coach
 *  calls against Sonnet or larger nemotron variants routinely exceed 30s. */
function ensureModelCompleteFlow(engine: Runcor): void {
  if (registeredEngines.has(engine as object)) return;
  engine.register(MODEL_COMPLETE_FLOW, async (ctx) => {
    const req = ctx.input as Parameters<typeof ctx.model.complete>[0];
    return await ctx.model.complete(req);
  }, { timeout: 300000, maxRetries: 0 });
  registeredEngines.add(engine as object);
}

export interface EngineProviderAdapterOptions {
  /** Name to register this adapter under in dialectic's ProviderRegistry.
   *  Match the provider prefix in the model names you use — e.g. "openrouter"
   *  for "openrouter/nvidia/nemotron-3-super-120b-a12b". */
  name: string;
  /** Pin every request to a specific engine provider name. When omitted, the
   *  engine's routing strategy picks. */
  pinProvider?: string;
}

export class EngineProviderAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly engine: Runcor;
  private readonly pinProvider: string | undefined;

  constructor(engine: Runcor, options: EngineProviderAdapterOptions) {
    this.engine = engine;
    this.name = options.name;
    this.pinProvider = options.pinProvider;
    ensureModelCompleteFlow(engine);
  }

  /** engine.trigger() returns immediately with state 'queued'; the flow runs
   *  asynchronously via dispatch(). Listen for 'execution:complete' and resolve
   *  with the fresh execution record (containing the final result/error). */
  private async awaitExecutionCompletion(executionId: string): Promise<Awaited<ReturnType<Runcor['getExecution']>> & object> {
    return new Promise((resolve, reject) => {
      const onComplete = (event: { executionId: string }): void => {
        if (event.executionId !== executionId) return;
        this.engine.off('execution:complete', onComplete);
        void this.engine.getExecution(executionId).then((exec) => {
          if (!exec) {
            reject(new Error(`execution ${executionId} not found after completion event`));
            return;
          }
          resolve(exec);
        });
      };
      this.engine.on('execution:complete', onComplete);
    });
  }

  async complete(messages: ProviderMessage[], options: ProviderCallOptions): Promise<ProviderResult> {
    const started = Date.now();
    // Default to 4096 max output tokens (the engine's OpenAIProvider default is
    // only 1024 which truncates Player drafts mid-answer). The legacy direct-
    // OpenRouter adapter used 2048; 4096 covers HTML-deliverable tests too.
    const maxTokens = (options.providerOptions?.['maxTokens'] as number | undefined) ?? 4096;
    const queuedExecution = await this.engine.trigger(MODEL_COMPLETE_FLOW, {
      idempotencyKey: randomUUID(),
      input: {
        model: options.model,
        messages,
        maxTokens,
        ...(this.pinProvider ? { provider: this.pinProvider } : {}),
        ...(options.providerOptions?.['temperature'] !== undefined ? { temperature: options.providerOptions['temperature'] as number } : {}),
      },
    });
    // engine.trigger() returns the queued execution and dispatches async. Wait for
    // the terminal-state notification via the engine's 'execution:complete' event.
    const execution = await this.awaitExecutionCompletion(queuedExecution.id);
    if (execution.state !== 'complete') {
      const errMsg = execution.error?.message ?? `engine execution ended in state "${execution.state}"`;
      throw new Error(`EngineProviderAdapter(${this.name}): ${errMsg}`);
    }
    const result = execution.result as { text: string; usage: { promptTokens: number; completionTokens: number } };
    const tokens = { input: result.usage.promptTokens, output: result.usage.completionTokens };
    // Cost note: dialectic's BudgetTracker reads cost_usd from each call. We
    // compute it here from dialectic's own price table so the in-call budget
    // gate keeps working. The engine's cost ledger is the source of truth for
    // cross-execution accounting and is independently tracked via
    // engine.getCostLedger().
    const fullModelName = this.pinProvider ? `${this.pinProvider}/${options.model}` : options.model;
    const cost_usd = computeCost(fullModelName, tokens);
    return {
      content: result.text,
      tokens,
      cost_usd,
      duration_ms: Date.now() - started,
    };
  }
}
