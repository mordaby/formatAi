// SPEC 9.6: "the provider is chosen in config" - one place maps LLM_PROVIDER to an
// adapter. Adding a provider is one file under `providers/` plus one line here.
import { models, type LlmProviderName } from '@formatai/shared';
import type { Env } from '../env.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAiProvider } from './providers/openai.js';
import { createClaudeCliProvider } from './providers/claudeCli.js';
import { createFakeProvider } from './providers/fake.js';
import type { LlmProvider } from './types.js';

const factories: Record<LlmProviderName, (env: Env) => LlmProvider> = {
  anthropic: (env) => createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }),
  openai: (env) => createOpenAiProvider({ apiKey: env.OPENAI_API_KEY }),
  'claude-cli': (env) => createClaudeCliProvider({ cliPath: env.CLAUDE_CLI_PATH, nodeEnv: env.NODE_ENV }),
  fake: () => createFakeProvider(),
};

export function createProvider(env: Env): LlmProvider {
  return factories[env.LLM_PROVIDER](env);
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
