// The learn endpoints' own behavior (validation, the response, the llm_calls ledger). Their
// protections - Turnstile, limits, budgets, cache, rate limit, production mode - are tested in
// test/protection/.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { models } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { basicPayload, correctRulesWireJson } from './fixtures.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// No TURNSTILE_SECRET_KEY / secrets here: this is development mode, where Turnstile is skipped.
const devEnv = () =>
  loadEnv({
    ...process.env,
    NODE_ENV: 'development',
    MONGODB_URI: '',
    LLM_PROVIDER: 'fake',
    TURNSTILE_SECRET_KEY: undefined,
  });

describe('POST /api/learn', () => {
  it('rejects a body that is not a valid LearnPayload with 400', async () => {
    app = await buildServer({ env: devEnv(), db: null, logger: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: JSON.stringify({ payload: { not: 'a payload' } }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalidPayload' });
  });

  it('learns, responds 200 with the verified rules, and writes an llm_calls ledger entry', async () => {
    const fake: FakeLlmProvider = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson(), usage: { tokensIn: 100, tokensOut: 50, tokensCachedRead: 20 } });
    const store = createMemoryStore();

    app = await buildServer({
      env: devEnv(),
      db: null,
      logger: false,
      store,
      complete: (req: CompleteRequest) => fake.complete(req),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: JSON.stringify({ payload: basicPayload() }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verified).toBe(true);
    expect(body.problems).toEqual([]);
    expect(body.rules).toBeTruthy();
    expect(body.cached).toBe(false);
    expect(body.learnId).toEqual(expect.any(String));

    expect(store.ledger).toHaveLength(1);
    const doc = store.ledger[0]!;
    expect(doc).toMatchObject({
      purpose: 'learn',
      model: models.fake.firstTry,
      outcome: 'verified',
      tokensIn: 100,
      tokensOut: 50,
      tokensCached: 20,
      masking: false,
      // SPEC 13: an anonymous visitor's calls carry their anonId.
      anonId: expect.any(String),
      // `cacheHit` is the structure cache (SPEC 9.5); prompt-cache tokens are in `tokensCached`.
      cacheHit: false,
    });
    expect(doc.learnId).toEqual(expect.any(String));
    expect(doc.ts).toBeInstanceOf(Date);
    // SPEC 9.2: the ledger tracks how often models write invalid formulas - counts
    // only, never message text or any other payload/response content.
    expect(doc.problemCounts).toEqual({
      formula: 0,
      schema: 0,
      reference: 0,
      type: 0,
      limit: 0,
      formatMismatch: 0,
      diff: 0,
      rowCount: 0,
      layout: 0,
    });
  });
});

describe('POST /api/learn/repair', () => {
  it('rejects a body with no valid previousRules with 400', async () => {
    app = await buildServer({ env: devEnv(), db: null, logger: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn/repair',
      payload: JSON.stringify({ payload: basicPayload(), previousRules: {}, problems: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalidPreviousRules' });
  });

  it('rejects a body that is not a valid LearnPayload with 400', async () => {
    app = await buildServer({ env: devEnv(), db: null, logger: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn/repair',
      payload: JSON.stringify({ payload: 'nope', previousRules: {}, problems: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalidPayload' });
  });
});
