import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { models } from '@formatai/shared';
import type { AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { buildServer } from '../../src/server.js';
import { basicPayload, correctRulesWireJson } from './fixtures.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fakeDb(): { db: AppDb; insertMany: ReturnType<typeof vi.fn> } {
  const insertMany = vi.fn().mockResolvedValue({ acknowledged: true, insertedCount: 1, insertedIds: {} });
  const db = { llmCalls: { insertMany } } as unknown as AppDb;
  return { db, insertMany };
}

describe('POST /api/learn', () => {
  it('does not exist in production (404)', async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: 'production', MONGODB_URI: '', LLM_PROVIDER: 'fake' });
    app = await buildServer({ env, db: null, logger: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: JSON.stringify({ payload: basicPayload() }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects a body that is not a valid LearnPayload with 400', async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: 'development', MONGODB_URI: '', LLM_PROVIDER: 'fake' });
    app = await buildServer({ env, db: null, logger: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn',
      payload: JSON.stringify({ payload: { not: 'a payload' } }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('learns, responds 200 with the verified rules, and writes an llm_calls ledger entry', async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: 'development', MONGODB_URI: '', LLM_PROVIDER: 'fake' });
    const fake: FakeLlmProvider = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson(), usage: { tokensIn: 100, tokensOut: 50, tokensCachedRead: 20 } });
    const { db, insertMany } = fakeDb();

    app = await buildServer({
      env,
      db,
      logger: false,
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

    expect(insertMany).toHaveBeenCalledTimes(1);
    const [docs] = insertMany.mock.calls[0] as [Record<string, unknown>[]];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      purpose: 'learn',
      model: models.fake.firstTry,
      outcome: 'verified',
      tokensIn: 100,
      tokensOut: 50,
      tokensCached: 20,
      masking: false,
    });
    expect(docs[0]!.learnId).toEqual(expect.any(String));
    expect(docs[0]!.ts).toBeInstanceOf(Date);
  });
});

describe('POST /api/learn/repair', () => {
  it('does not exist in production (404)', async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: 'production', MONGODB_URI: '', LLM_PROVIDER: 'fake' });
    app = await buildServer({ env, db: null, logger: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/learn/repair',
      payload: JSON.stringify({ payload: basicPayload(), previousRules: {}, problems: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(404);
  });
});
