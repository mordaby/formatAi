// API audit C8 (2026-10-07): with a fallback configured, BOTH SDK clients are held to `limits.llm.fallback`'s short timeout and retry count
// - the primary's (as before) and now the fallback's own, which had the SDKs' defaults (10 minutes per attempt, 2 retries).
import { limits } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/env.js';

const created = vi.hoisted(() => [] as { name: string; client: unknown }[]);

vi.mock('../../src/llm/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/registry.js')>();
  return {
    ...actual,
    createProvider: (env: unknown, name: string, client: unknown = {}) => {
      created.push({ name, client });
      return { name, complete: async () => Promise.reject(new Error('not called here')) };
    },
  };
});

const { fallbackDepsOf } = await import('../../src/llm/fallback.js');

describe('the SDK clients of a call with a fallback', () => {
  it("the fallback's client gets the short timeout and retry count too", () => {
    const env = loadEnv({ ...process.env, LLM_PROVIDER: 'anthropic', LLM_FALLBACK_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' });
    const deps = fallbackDepsOf(env);
    deps.fallback!.create();
    const { primaryTimeoutMs, primaryMaxRetries, fallbackTimeoutMs, fallbackMaxRetries } = limits.llm.fallback;
    expect({ fallbackTimeoutMs, fallbackMaxRetries }).toEqual({ fallbackTimeoutMs: 120_000, fallbackMaxRetries: 1 });
    expect(created).toEqual([
      { name: 'anthropic', client: { timeoutMs: primaryTimeoutMs, maxRetries: primaryMaxRetries } },
      { name: 'openai', client: { timeoutMs: fallbackTimeoutMs, maxRetries: fallbackMaxRetries } },
    ]);
  });
});
