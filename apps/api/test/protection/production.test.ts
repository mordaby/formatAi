// Production mode (SPEC 9.5, 15): the learn routes exist, but only behind their protections - and the
// process refuses to start when those protections cannot work.
import { limits } from '@formatai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMemoryStore } from '../../src/protection/store.js';
import { parseTrustProxy } from '../../src/protection/index.js';
import { buildServer } from '../../src/server.js';
import { basicPayload } from '../learn/fixtures.js';
import { makeComplete, makeEnv, makeTurnstileFetch } from './harness.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const productionEnv = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({
    NODE_ENV: 'production',
    TURNSTILE_SECRET_KEY: 'prod-secret',
    IP_HASH_SECRET: 'prod-hash-secret',
    SESSION_SECRET: 'prod-session-secret',
    ...overrides,
  });

describe('production mode', () => {
  it('registers /api/learn, /api/learn/repair and /api/session (no dev-only gate any more)', async () => {
    const ts = makeTurnstileFetch(['good']);
    app = await buildServer({
      env: productionEnv(),
      db: null,
      logger: false,
      store: createMemoryStore(),
      fetch: ts.fn,
      complete: makeComplete().fn,
    });

    const learn = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: JSON.stringify({ payload: basicPayload() }), // not signed in
      headers: { 'content-type': 'application/json' },
    });
    expect(learn.statusCode).toBe(403);
    expect(learn.json()).toEqual({ error: 'signInForAi' });

    const repair = await app.inject({
      method: 'POST',
      url: '/api/learn/repair',
      payload: JSON.stringify({ payload: basicPayload(), previousRules: {}, problems: [] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(repair.statusCode).toBe(403); // reached the handler (not a 404): the AI is for signed-in users
    expect(repair.json()).toEqual({ error: 'signInForAi' });

    const session = await app.inject({ method: 'GET', url: '/api/session' });
    expect(session.statusCode).toBe(200);
  });

  it('serves a full learn to a signed-in user, and sets a Secure anonId cookie', async () => {
    const ts = makeTurnstileFetch(['good']);
    const llm = makeComplete();
    app = await buildServer({
      env: productionEnv(),
      db: null,
      logger: false,
      store: createMemoryStore(),
      fetch: ts.fn,
      complete: llm.fn,
      identify: (req) => ({ kind: 'user', userId: '00000000000000000000000a', tier: 'registered', anonId: req.anonId }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: JSON.stringify({ payload: basicPayload() }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
    expect(llm.calls).toHaveLength(1);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^anonId=/);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('still enforces the 256 KB JSON-only body limit on the learn routes', async () => {
    app = await buildServer({ env: productionEnv(), db: null, logger: false, store: createMemoryStore() });
    const big = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: JSON.stringify({ payload: 'x'.repeat(300 * 1024) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(big.statusCode).toBe(413);
    const text = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(415);
  });
});

describe('CORS for the web app', () => {
  it('allows credentials from WEB_ORIGIN and exposes Retry-After to its scripts', async () => {
    app = await buildServer({ env: makeEnv({ WEB_ORIGIN: 'http://localhost:5173' }), db: null, logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/session', headers: { origin: 'http://localhost:5173' } });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain('retry-after');
  });
});

describe('production startup requirements', () => {
  it('refuses to start without TURNSTILE_SECRET_KEY', async () => {
    await expect(
      buildServer({ env: productionEnv({ TURNSTILE_SECRET_KEY: undefined }), db: null, logger: false, store: createMemoryStore() }),
    ).rejects.toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it('refuses to start without a hashing secret (IP_HASH_SECRET or SESSION_SECRET)', async () => {
    await expect(
      buildServer({
        env: productionEnv({ IP_HASH_SECRET: undefined, SESSION_SECRET: undefined }),
        db: null,
        logger: false,
        store: createMemoryStore(),
      }),
    ).rejects.toThrow(/IP_HASH_SECRET/);
    // SESSION_SECRET is an accepted stand-in.
    app = await buildServer({
      env: productionEnv({ IP_HASH_SECRET: undefined, SESSION_SECRET: 'session-secret' }),
      db: null,
      logger: false,
      store: createMemoryStore(),
    });
  });

  it('refuses to start without a database (limits and budgets live there)', async () => {
    await expect(buildServer({ env: productionEnv(), db: null, logger: false })).rejects.toThrow(/MONGODB_URI/);
  });

  it('boots without any of them outside production', async () => {
    app = await buildServer({ env: makeEnv(), db: null, logger: false });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('parseTrustProxy (behind a proxy, req.ip must be the client)', () => {
  it('maps the env var to what Fastify takes', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    const oneHop = parseTrustProxy('1');
    expect(typeof oneHop).toBe('function');
    if (typeof oneHop === 'function') {
      expect(oneHop('10.0.0.1', 0)).toBe(true); // the socket peer is the proxy
      expect(oneHop('203.0.113.7', 1)).toBe(false); // the client it reports is not trusted further
    }
    expect(() => parseTrustProxy('lots')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('-1')).toThrow(/TRUST_PROXY/);
  });

  it('uses X-Forwarded-For for the per-IP request limit only when trusted', async () => {
    const start = async (trust: string | undefined) => {
      await app?.close();
      app = await buildServer({
        env: makeEnv({ TRUST_PROXY: trust }),
        db: null,
        logger: false,
        store: createMemoryStore(),
        complete: makeComplete().fn,
        identify: (req) => ({ kind: 'user', userId: '00000000000000000000000a', tier: 'registered', anonId: req.anonId }),
      });
      // A malformed body: it reaches the handler (400) without costing a learn, so only the rate limit can stop it.
      return (xff: string) =>
        app!.inject({
          method: 'POST',
          url: '/api/learn',
          remoteAddress: '10.0.0.1', // the proxy
          headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
          payload: JSON.stringify({ payload: 1 }),
        });
    };
    const max = limits.protection.learnRequestsPerIpPerMinute;

    // Trusted: two different clients behind one proxy do not share a per-IP allowance...
    const trusted = await start('1');
    for (let i = 0; i < max; i++) expect((await trusted('198.51.100.1')).statusCode).toBe(400);
    expect((await trusted('198.51.100.1')).statusCode).toBe(429);
    expect((await trusted('198.51.100.2')).statusCode).toBe(400);

    // Not trusted: X-Forwarded-For is ignored, so every client is the proxy - one shared allowance.
    const untrusted = await start(undefined);
    for (let i = 0; i < max; i++) expect((await untrusted(`198.51.100.${i + 1}`)).statusCode).toBe(400);
    expect((await untrusted('198.51.100.99')).statusCode).toBe(429);
  });
});
