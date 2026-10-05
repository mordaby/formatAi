// The production start-up check (SPEC 21 v13): every missing setting listed at once, never a value.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { checkProductionConfig, formatProductionProblems, webDistDir } from '../src/productionConfig.js';

const SECRET = 'a-long-random-secret-0123456789-abcdefghij';

/** A complete production environment (made-up values). */
const complete: Record<string, string> = {
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://formatai.example.onrender.com',
  MONGODB_URI: 'mongodb+srv://user:pw@cluster.example.mongodb.net',
  MONGODB_DB: 'formatai',
  LLM_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-made-up',
  SESSION_SECRET: SECRET,
  IP_HASH_SECRET: `${SECRET}-other`,
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_SITE_KEY: 'turnstile-site',
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  TRUST_PROXY: 'true',
  ADMIN_EMAILS: 'owner@example.com',
};

function check(overrides: Record<string, string | undefined> = {}, built = true) {
  const source: NodeJS.ProcessEnv = { ...complete, ...overrides };
  // Undefined removes a variable (a real environment has no `undefined` values).
  for (const key of Object.keys(source)) if (source[key] === undefined) delete source[key];
  return checkProductionConfig(loadEnv(source), source, { webDistExists: () => built });
}

describe('checkProductionConfig', () => {
  it('accepts a complete production environment, with nothing to warn about', () => {
    expect(check()).toEqual({ problems: [], warnings: [] });
  });

  it('lists every missing setting at once, by name', () => {
    const { problems } = check({
      MONGODB_URI: undefined,
      SESSION_SECRET: undefined,
      IP_HASH_SECRET: undefined,
      TURNSTILE_SECRET_KEY: undefined,
      TURNSTILE_SITE_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      PUBLIC_ORIGIN: undefined,
    });
    const text = problems.join('\n');
    for (const name of ['MONGODB_URI', 'SESSION_SECRET', 'IP_HASH_SECRET', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY', 'ANTHROPIC_API_KEY', 'sign-in provider', 'PUBLIC_ORIGIN']) {
      expect(text, name).toContain(name);
    }
    expect(problems).toHaveLength(8);
  });

  it('never prints a value: not a secret, not the connection string', () => {
    const { problems } = check({ SESSION_SECRET: 'short-secret-value', MONGODB_URI: undefined, GOOGLE_CLIENT_SECRET: undefined });
    const text = formatProductionProblems(problems)!;
    expect(text).toContain('SESSION_SECRET is too short');
    for (const value of ['short-secret-value', 'google-id', 'turnstile-secret', 'sk-ant-made-up', SECRET]) expect(text).not.toContain(value);
  });

  it('wants signing secrets of at least 32 characters', () => {
    expect(check({ SESSION_SECRET: 'x'.repeat(31) }).problems.join()).toMatch(/SESSION_SECRET is too short/);
    expect(check({ IP_HASH_SECRET: 'x'.repeat(31) }).problems.join()).toMatch(/IP_HASH_SECRET is too short/);
    expect(check({ SESSION_SECRET: 'x'.repeat(32) }).problems).toEqual([]);
  });

  it('wants the production LLM provider, with its key (not the dev CLI or the fake)', () => {
    expect(check({ LLM_PROVIDER: 'claude-cli', ANTHROPIC_API_KEY: undefined }).problems.join()).toMatch(/LLM_PROVIDER=claude-cli is for development/);
    expect(check({ LLM_PROVIDER: 'fake' }).problems.join()).toMatch(/LLM_PROVIDER=fake is for development/);
    expect(check({ ANTHROPIC_API_KEY: undefined }).problems.join()).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(check({ LLM_PROVIDER: 'openai' }).problems.join()).toMatch(/OPENAI_API_KEY is not set/);
    expect(check({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: undefined }).problems).toEqual([]);
  });

  it('needs one sign-in provider, and no provider with only half its credentials', () => {
    expect(check({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }).problems.join()).toMatch(/no sign-in provider/);
    expect(check({ MICROSOFT_CLIENT_ID: 'ms-id' }).problems.join()).toMatch(/MICROSOFT_CLIENT_SECRET is not set/);
    expect(check({ MICROSOFT_CLIENT_SECRET: 'ms-secret' }).problems.join()).toMatch(/MICROSOFT_CLIENT_ID is not set/);
    expect(check({ MICROSOFT_CLIENT_ID: 'ms-id', MICROSOFT_CLIENT_SECRET: 'ms-secret' }).problems).toEqual([]);
    // The only provider is half there: one line about the missing half, not a second one saying "no provider".
    const onlyHalf = check({ GOOGLE_CLIENT_SECRET: undefined }).problems;
    expect(onlyHalf).toHaveLength(1);
    expect(onlyHalf[0]).toMatch(/^GOOGLE_CLIENT_SECRET is not set/);
  });

  it('wants the public origin named, as https (this machine excepted)', () => {
    expect(check({ PUBLIC_ORIGIN: undefined }).problems.join()).toMatch(/public origin is not set/);
    // Render names it itself.
    expect(check({ PUBLIC_ORIGIN: undefined, RENDER_EXTERNAL_URL: 'https://formatai-abcd.onrender.com' }).problems).toEqual([]);
    // The two explicit variables of a split deployment are enough.
    expect(check({ PUBLIC_ORIGIN: undefined, WEB_ORIGIN: 'https://app.example.com', API_PUBLIC_URL: 'https://api.example.com' }).problems).toEqual([]);
    expect(check({ PUBLIC_ORIGIN: 'http://formatai.example.com' }).problems.join()).toMatch(/WEB_ORIGIN must be an https/);
    expect(check({ PUBLIC_ORIGIN: 'http://localhost:8790' }).problems).toEqual([]);
  });

  it('wants the web app built', () => {
    const { problems } = check({}, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/web app is not built/);
    expect(problems[0]).toContain('index.html');
  });

  it('only warns about TRUST_PROXY and the admin lists', () => {
    const { problems, warnings } = check({ TRUST_PROXY: undefined, ADMIN_EMAILS: undefined });
    expect(problems).toEqual([]);
    expect(warnings.join('\n')).toMatch(/TRUST_PROXY/);
    expect(warnings.join('\n')).toMatch(/ADMIN_EMAILS/);
    expect(check({ ADMIN_EMAILS: undefined, MICROSOFT_ADMIN_OIDS: 'some-oid' }).warnings).toEqual([]);
  });
});

describe('formatProductionProblems', () => {
  it('is null when there is nothing to fix, else one line per problem', () => {
    expect(formatProductionProblems([])).toBeNull();
    const text = formatProductionProblems(['A is not set', 'B is not set'])!;
    expect(text).toMatch(/2 settings need attention/);
    expect(text).toContain('  - A is not set');
    expect(text).toContain('  - B is not set');
  });
});

describe('webDistDir', () => {
  it('defaults to apps/web/dist in the repository, and resolves WEB_DIST from the repo root', () => {
    const repo = path.resolve(import.meta.dirname, '../../..');
    expect(webDistDir(loadEnv({}))).toBe(path.join(repo, 'apps/web/dist'));
    expect(webDistDir(loadEnv({ WEB_DIST: 'somewhere/else' }))).toBe(path.join(repo, 'somewhere/else'));
    const abs = path.resolve(repo, 'abs-dist');
    expect(webDistDir(loadEnv({ WEB_DIST: abs }))).toBe(abs);
  });
});
