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

  it('SPEC 9.6: LLM_FALLBACK_PROVIDER is optional (unset or blank: no fallback), must name a provider, and has its own model overrides', () => {
    expect(loadEnv({ ...process.env, LLM_FALLBACK_PROVIDER: undefined }).LLM_FALLBACK_PROVIDER).toBeUndefined();
    expect(loadEnv({ ...process.env, LLM_FALLBACK_PROVIDER: '  ' }).LLM_FALLBACK_PROVIDER).toBeUndefined();
    expect(loadEnv({ ...process.env, LLM_FALLBACK_PROVIDER: 'openai' }).LLM_FALLBACK_PROVIDER).toBe('openai');
    expect(() => loadEnv({ ...process.env, LLM_FALLBACK_PROVIDER: 'gemini' })).toThrow(/LLM_FALLBACK_PROVIDER/);
    const env = loadEnv({ ...process.env, LLM_FALLBACK_PROVIDER: 'openai', LLM_FALLBACK_MODEL_FIRST_TRY: 'gpt-5-nano', LLM_FALLBACK_MODEL_ESCALATION: 'gpt-5' });
    expect([env.LLM_FALLBACK_MODEL_FIRST_TRY, env.LLM_FALLBACK_MODEL_ESCALATION]).toEqual(['gpt-5-nano', 'gpt-5']);
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

describe('loadEnv - the public origin (one service, one origin)', () => {
  const clean = { ...process.env, WEB_ORIGIN: undefined, API_PUBLIC_URL: undefined, PUBLIC_ORIGIN: undefined, RENDER_EXTERNAL_URL: undefined };

  it('keeps the development defaults when nothing names an origin', () => {
    const env = loadEnv(clean);
    expect(env.WEB_ORIGIN).toBe('http://localhost:5173');
    expect(env.API_PUBLIC_URL).toBeUndefined();
  });

  it('PUBLIC_ORIGIN is the default for both the web origin and the API public URL (a trailing slash or path is dropped)', () => {
    const env = loadEnv({ ...clean, PUBLIC_ORIGIN: 'https://formatai.example.com/' });
    expect(env.WEB_ORIGIN).toBe('https://formatai.example.com');
    expect(env.API_PUBLIC_URL).toBe('https://formatai.example.com');
  });

  it("falls back to Render's own RENDER_EXTERNAL_URL, which PUBLIC_ORIGIN overrides", () => {
    expect(loadEnv({ ...clean, RENDER_EXTERNAL_URL: 'https://formatai-abcd.onrender.com' }).WEB_ORIGIN).toBe('https://formatai-abcd.onrender.com');
    const both = loadEnv({ ...clean, RENDER_EXTERNAL_URL: 'https://formatai-abcd.onrender.com', PUBLIC_ORIGIN: 'https://formatai.example.com' });
    expect(both.WEB_ORIGIN).toBe('https://formatai.example.com');
    expect(both.API_PUBLIC_URL).toBe('https://formatai.example.com');
  });

  it('an explicit WEB_ORIGIN or API_PUBLIC_URL still wins (development: the web on 5173, the API on 8787)', () => {
    const env = loadEnv({ ...clean, PUBLIC_ORIGIN: 'https://formatai.example.com', WEB_ORIGIN: 'http://localhost:5173', API_PUBLIC_URL: 'http://localhost:8787' });
    expect(env.WEB_ORIGIN).toBe('http://localhost:5173');
    expect(env.API_PUBLIC_URL).toBe('http://localhost:8787');
  });

  it('refuses an origin that is not a URL, naming the variable and not echoing it back', () => {
    expect(() => loadEnv({ ...clean, PUBLIC_ORIGIN: 'formatai.example.com' })).toThrow(/Invalid PUBLIC_ORIGIN/);
    expect(() => loadEnv({ ...clean, RENDER_EXTERNAL_URL: 'ftp://x.example.com' })).toThrow(/Invalid RENDER_EXTERNAL_URL/);
    expect(() => loadEnv({ ...clean, PUBLIC_ORIGIN: 'not a url with a secret' })).toThrow(/^(?!.*secret)/s);
  });
});
