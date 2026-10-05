import { models } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { createProvider, resolveFallbackModel, resolveModel } from '../../src/llm/registry.js';

function envWith(overrides: Record<string, string | undefined>) {
  return loadEnv({ ...process.env, ...overrides });
}

describe('createProvider (SPEC 9.6 provider selection)', () => {
  it('selects the provider named by LLM_PROVIDER', () => {
    expect(createProvider(envWith({ LLM_PROVIDER: 'fake' })).name).toBe('fake');
    expect(createProvider(envWith({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' })).name).toBe('anthropic');
    // The openai SDK validates that an API key is present at construction time, so a
    // real (if fake) key is needed just to select the provider.
    expect(createProvider(envWith({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' })).name).toBe('openai');
    expect(createProvider(envWith({ LLM_PROVIDER: 'claude-cli' })).name).toBe('claude-cli');
  });
});

describe('resolveModel (SPEC 9.4/9.6 - env overrides the config registry)', () => {
  it('uses config/models.ts when no override is set', () => {
    const env = envWith({ LLM_PROVIDER: 'anthropic', LLM_MODEL_FIRST_TRY: undefined, LLM_MODEL_ESCALATION: undefined });
    expect(resolveModel(env, 'firstTry')).toBe(models.anthropic.firstTry);
    expect(resolveModel(env, 'escalation')).toBe(models.anthropic.escalation);
  });

  it('prefers LLM_MODEL_FIRST_TRY/LLM_MODEL_ESCALATION when set', () => {
    const env = envWith({
      LLM_PROVIDER: 'anthropic',
      LLM_MODEL_FIRST_TRY: 'override-first-try',
      LLM_MODEL_ESCALATION: 'override-escalation',
    });
    expect(resolveModel(env, 'firstTry')).toBe('override-first-try');
    expect(resolveModel(env, 'escalation')).toBe('override-escalation');
  });

  it('resolves against whichever provider is active', () => {
    const env = envWith({ LLM_PROVIDER: 'openai', LLM_MODEL_FIRST_TRY: undefined, LLM_MODEL_ESCALATION: undefined });
    expect(resolveModel(env, 'firstTry')).toBe(models.openai.firstTry);
  });
});

describe('resolveFallbackModel / createProvider by name (SPEC 9.6 fallback)', () => {
  it('the fallback slots come from config for LLM_FALLBACK_PROVIDER, overridden by its own variables only', () => {
    const base = { LLM_PROVIDER: 'anthropic', LLM_MODEL_FIRST_TRY: 'primary-override', LLM_FALLBACK_MODEL_FIRST_TRY: undefined, LLM_FALLBACK_MODEL_ESCALATION: undefined };
    expect(resolveFallbackModel(envWith({ ...base, LLM_FALLBACK_PROVIDER: undefined }), 'firstTry')).toBeNull();
    const env = envWith({ ...base, LLM_FALLBACK_PROVIDER: 'openai' });
    expect(resolveFallbackModel(env, 'firstTry')).toBe(models.openai.firstTry);
    expect(resolveFallbackModel(env, 'escalation')).toBe(models.openai.escalation);
    expect(resolveFallbackModel(envWith({ ...base, LLM_FALLBACK_PROVIDER: 'openai', LLM_FALLBACK_MODEL_ESCALATION: 'gpt-5-mini' }), 'escalation')).toBe('gpt-5-mini');
  });

  it('createProvider builds a named provider, not only the primary', () => {
    const env = envWith({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test' });
    expect(createProvider(env, 'openai').name).toBe('openai');
    expect(createProvider(env, 'anthropic', { timeoutMs: 1000, maxRetries: 1 }).name).toBe('anthropic');
  });
});
