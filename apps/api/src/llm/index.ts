// SPEC 9.6: "All LLM calls go through one function in apps/api ... No provider SDK is
// imported anywhere else, and the provider is chosen in config."
import { loadEnv, type Env } from '../env.js';
import { createProvider } from './registry.js';
import type { CompleteRequest, CompleteResult } from './types.js';

export * from './types.js';
export { LlmError, type LlmErrorKind } from './errors.js';
export { computeCostUsd, resetCostWarnings } from './cost.js';
export { createProvider, resolveModel, type ModelPurpose } from './registry.js';
export { createAnthropicProvider, type CreateAnthropicProviderOptions } from './providers/anthropic.js';
export { createOpenAiProvider, type CreateOpenAiProviderOptions } from './providers/openai.js';
export { createClaudeCliProvider, type CreateClaudeCliProviderOptions } from './providers/claudeCli.js';
export {
  createFakeProvider,
  hashRequest,
  type FakeLlmProvider,
  type FakeCannedResponse,
} from './providers/fake.js';
export { toOpenAiStrictSchema, stripOpenAiNulls } from './schema/toOpenAiStrictSchema.js';

/**
 * The one entry point every learn/repair/escalation call goes through (SPEC 9.6).
 * Selects the provider from `env.LLM_PROVIDER` (or the given `env`) and delegates to it.
 */
export async function complete(req: CompleteRequest, env: Env = loadEnv()): Promise<CompleteResult> {
  const provider = createProvider(env);
  return provider.complete(req);
}
