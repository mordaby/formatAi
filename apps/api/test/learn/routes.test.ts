// The learn endpoints' own behavior (validation, the response, the llm_calls ledger). Their
// protections - Turnstile, limits, budgets, cache, rate limit, production mode - are tested in
// test/protection/.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { models } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import type { Identity } from '../../src/protection/identity.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { allUnsupportedWireJson, basicPayload, correctRulesWireJson, externalColumnPayload, externalColumnWireJson } from './fixtures.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// The AI is for signed-in users only (SPEC 21 v5): every test here calls as a registered user.
const USER = '00000000000000000000000a';
const asUser = (req: FastifyRequest): Identity => ({ kind: 'user', userId: USER, tier: 'registered', anonId: req.anonId });

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
    app = await buildServer({ env: devEnv(), db: null, logger: false, identify: asUser });

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
      identify: asUser,
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
      // SPEC 9.6: the provider that answered; a call the primary served has no fallback fields
      provider: 'fake',
      outcome: 'verified',
      tokensIn: 100,
      tokensOut: 50,
      tokensCached: 20,
      masking: false,
      // SPEC 13: a signed-in user's calls carry their userId (and the browser's anonId).
      anonId: expect.any(String),
      userId: expect.anything(),
      // `cacheHit` is the structure cache (SPEC 9.5); prompt-cache tokens are in `tokensCached`.
      cacheHit: false,
    });
    expect('fallback' in doc).toBe(false);
    expect('fallbackReason' in doc).toBe(false);
    expect(doc.learnId).toEqual(expect.any(String));
    expect(doc.ts).toBeInstanceOf(Date);
    // Our own token estimate: counts and a price only (the fake provider's model has no price, so no cost).
    expect(doc.estimate).toEqual({ inputTokens: expect.any(Number), cachedInputTokens: 0, cacheWriteTokens: expect.any(Number), outputTokens: expect.any(Number), costUsd: null });
    expect(doc.estimate!.cacheWriteTokens).toBeGreaterThan(0);
    // SPEC 9.2: the ledger tracks how often models write invalid formulas - counts
    // only, never message text or any other payload/response content.
    expect(doc.problemCounts).toEqual({
      formula: 0,
      schema: 0,
      reference: 0,
      type: 0,
      limit: 0,
      formatMismatch: 0,
      fixedMismatch: 0,
      diff: 0,
      rowCount: 0,
      layout: 0,
      unsupportedDespiteEvidence: 0,
      // prompt audit X2: an answer cut off at the output-token limit (none here)
      truncated: 0,
      // SPEC 9.2 layer 6: a rule that copies rows of the example - the repair it asks for, and the columns code reported after it (none here)
      overfit: 0,
      overfitFallback: 0,
      // docs/proposals/saved-format-contents.md section 4: the browser's one round for a list column (never raised by the server's checks)
      list: 0,
    });
  });
});

describe('POST /api/learn: an honest "cannot produce this column"', () => {
  const learnOnce = async (payload: unknown, fake: FakeLlmProvider) => {
    app = await buildServer({ env: devEnv(), db: null, logger: false, store: createMemoryStore(), identify: asUser, complete: (req: CompleteRequest) => fake.complete(req) });
    return app.inject({ method: 'POST', url: '/api/learn', payload: JSON.stringify({ payload }), headers: { 'content-type': 'application/json' } });
  };

  it('is a success: one call, verified, and the learn counts against the quota (not a failed attempt)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: externalColumnWireJson() });
    const res = await learnOnce(externalColumnPayload(), fake);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(fake.calls).toHaveLength(1);
    expect(body).toMatchObject({ verified: true, problems: [], counted: true, failedAttempts: 0 });
    expect(body.rules.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
  });

  it('every column unsupported is a failed attempt: not verified, not counted, one failure recorded', async () => {
    const fake = createFakeProvider();
    for (let i = 0; i < 3; i++) fake.enqueue({ json: allUnsupportedWireJson() });
    const res = await learnOnce(externalColumnPayload(), fake);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verified: false, counted: false, failedAttempts: 1 });
  });
});

describe('POST /api/learn/repair', () => {
  it('rejects a body with no valid previousRules with 400', async () => {
    app = await buildServer({ env: devEnv(), db: null, logger: false, identify: asUser });

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
    app = await buildServer({ env: devEnv(), db: null, logger: false, identify: asUser });

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
