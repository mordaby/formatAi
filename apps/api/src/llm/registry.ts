// SPEC 9.6: "the provider is chosen in config" - one place maps LLM_PROVIDER to an
// adapter. Adding a provider is one file under `providers/` plus one line here.
import { models, type LlmProviderName } from '@formatai/shared';
import type { Env } from '../env.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAiProvider } from './providers/openai.js';
import { createClaudeCliProvider } from './providers/claudeCli.js';
import { createFakeProvider } from './providers/fake.js';
import type { LlmProvider } from './types.js';

/** An API provider's SDK client settings (`limits.llm.fallback`: a primary that has a fallback gives up sooner). Unset: the SDK's defaults. */
export interface ProviderClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

const factories: Record<LlmProviderName, (env: Env, client: ProviderClientOptions) => LlmProvider> = {
  anthropic: (env, client) => createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, ...client }),
  openai: (env, client) => createOpenAiProvider({ apiKey: env.OPENAI_API_KEY, ...client }),
  'claude-cli': (env) => createClaudeCliProvider({ cliPath: env.CLAUDE_CLI_PATH, nodeEnv: env.NODE_ENV }),
  fake: () => createFakeProvider(),
};

/** The adapter for `name` (default: the primary, `env.LLM_PROVIDER`). */
export function createProvider(env: Env, name: LlmProviderName = env.LLM_PROVIDER, client: ProviderClientOptions = {}): LlmProvider {
  return factories[name](env, client);
}

export type ModelPurpose = 'firstTry' | 'escalation';

/**
 * Resolves the model id for a call against the active provider (`env.LLM_PROVIDER`).
 * SPEC 9.4/9.6: `LLM_MODEL_FIRST_TRY`/`LLM_MODEL_ESCALATION` override the config
 * registry (`packages/shared/src/config/models.ts`) when set; config wins otherwise.
 */
export function resolveModel(env: Env, purpose: ModelPurpose): string {
  const override = purpose === 'firstTry' ? env.LLM_MODEL_FIRST_TRY : env.LLM_MODEL_ESCALATION;
  return override ?? models[env.LLM_PROVIDER][purpose];
}

/**
 * SPEC 9.6 "Fallback": the fallback provider's model for a slot - `LLM_FALLBACK_MODEL_FIRST_TRY` / `LLM_FALLBACK_MODEL_ESCALATION` when set,
 * else `config/models.ts` for `LLM_FALLBACK_PROVIDER`. Null when no fallback is configured.
 */
export function resolveFallbackModel(env: Env, purpose: ModelPurpose): string | null {
  if (!env.LLM_FALLBACK_PROVIDER) return null;
  const override = purpose === 'firstTry' ? env.LLM_FALLBACK_MODEL_FIRST_TRY : env.LLM_FALLBACK_MODEL_ESCALATION;
  return override ?? models[env.LLM_FALLBACK_PROVIDER][purpose];
}
