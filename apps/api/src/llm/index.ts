// SPEC 9.6: "All LLM calls go through one function in apps/api ... No provider SDK is
// imported anywhere else, and the provider is chosen in config."
import { loadEnv, type Env } from '../env.js';
import { completeWithFallback, fallbackDepsOf } from './fallback.js';
import type { CompleteRequest, CompleteResult } from './types.js';

export * from './types.js';
export {
  LlmError,
  type LlmErrorKind,
  type UnavailableReason,
  type FallbackReason,
  type CallFallback,
} from './errors.js';
export { computeCostUsd, resetCostWarnings } from './cost.js';
export { createProvider, resolveModel, resolveFallbackModel, type ModelPurpose, type ProviderClientOptions } from './registry.js';
export {
  breakerFor,
  completeWithFallback,
  createCircuitBreaker,
  fallbackDepsOf,
  resetCircuitBreakers,
  slotOf,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type FallbackDeps,
  type FallbackTarget,
} from './fallback.js';
export { createAnthropicProvider, type CreateAnthropicProviderOptions } from './providers/anthropic.js';
export { createOpenAiProvider, openAiParamsOf, promptCacheKeyOf, type CreateOpenAiProviderOptions } from './providers/openai.js';
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
 * Selects the provider from `env.LLM_PROVIDER` (or the given `env`) and delegates to it - and, when `env.LLM_FALLBACK_PROVIDER` is set,
 * makes the same call on the fallback when the primary cannot serve it (`fallback.ts`).
 */
export async function complete(req: CompleteRequest, env: Env = loadEnv()): Promise<CompleteResult> {
  return completeWithFallback(req, fallbackDepsOf(env));
}
