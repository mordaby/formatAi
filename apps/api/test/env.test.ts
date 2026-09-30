import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('loadEnv - LLM config (SPEC 9.6)', () => {
  it('defaults LLM_PROVIDER to "claude-cli" when unset', () => {
    const env = loadEnv({ ...process.env, LLM_PROVIDER: undefined });
    expect(env.LLM_PROVIDER).toBe('claude-cli');
  });

  it('accepts every documented provider name', () => {
    for (const provider of ['anthropic', 'openai', 'claude-cli', 'fake']) {
      const env = loadEnv({ ...process.env, LLM_PROVIDER: provider });
      expect(env.LLM_PROVIDER).toBe(provider);
    }
  });

  it('throws on an unknown LLM_PROVIDER value', () => {
    expect(() => loadEnv({ ...process.env, LLM_PROVIDER: 'made-up-provider' })).toThrow(/Invalid LLM_PROVIDER/);
  });

  it('leaves LLM_MODEL_FIRST_TRY/LLM_MODEL_ESCALATION unset when not provided', () => {
    const env = loadEnv({
      ...process.env,
      LLM_MODEL_FIRST_TRY: undefined,
      LLM_MODEL_ESCALATION: undefined,
    });
    expect(env.LLM_MODEL_FIRST_TRY).toBeUndefined();
    expect(env.LLM_MODEL_ESCALATION).toBeUndefined();
  });

  it('passes through LLM_MODEL_FIRST_TRY/LLM_MODEL_ESCALATION overrides verbatim', () => {
    const env = loadEnv({
      ...process.env,
      LLM_MODEL_FIRST_TRY: 'my-custom-first-try-model',
      LLM_MODEL_ESCALATION: 'my-custom-escalation-model',
    });
    expect(env.LLM_MODEL_FIRST_TRY).toBe('my-custom-first-try-model');
    expect(env.LLM_MODEL_ESCALATION).toBe('my-custom-escalation-model');
  });

  it('trims whitespace-only overrides to "unset", same as other optional keys', () => {
    const env = loadEnv({ ...process.env, LLM_MODEL_FIRST_TRY: '   ' });
    expect(env.LLM_MODEL_FIRST_TRY).toBeUndefined();
  });

  it('passes through OPENAI_API_KEY and CLAUDE_CLI_PATH', () => {
    const env = loadEnv({
      ...process.env,
      OPENAI_API_KEY: 'sk-test',
      CLAUDE_CLI_PATH: '/usr/local/bin/claude',
    });
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.CLAUDE_CLI_PATH).toBe('/usr/local/bin/claude');
  });
});
