// `limit_hit` (SPEC 14.1): ONE hook sees every `limitHit` answer. Checked on a bare app (what it does and does not record, that it never touches
// the answer, and that a visitor's is stored with no id) and through the real learn routes (the AI-learn quota and the AI requests a day).
import { LIMIT_CODES, tiers } from '@formatai/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventRecorder, createMemoryEventStore, registerLimitHitEvents } from '../../src/events/index.js';
import type { Identity } from '../../src/protection/identity.js';
import { createHarness, makeComplete, memoryKit, TEST_USER, type Harness } from '../protection/harness.js';

const USER = TEST_USER;

describe('registerLimitHitEvents (bare app)', () => {
  async function app(identity: Identity) {
    const store = createMemoryEventStore();
    const recorder = createEventRecorder({ store, now: () => new Date('2026-10-08T00:00:00Z'), identify: () => identity });
    const server = Fastify();
    registerLimitHitEvents(server, recorder);
    server.get('/limit/:code', async (req, reply) => reply.code(429).send({ error: 'limitHit', limit: (req.params as { code: string }).code, quota: { remaining: 0 } }));
    server.get('/forbidden-limit', async (_req, reply) => reply.code(403).send({ error: 'limitHit', limit: 'savedFormats' }));
    server.get('/wrong-status', async (_req, reply) => reply.code(200).send({ error: 'limitHit', limit: 'savedFormats' }));
    server.get('/other-error', async (_req, reply) => reply.code(429).send({ error: 'rateLimited' }));
    server.get('/mentions', async (_req, reply) => reply.code(429).send({ error: 'rateLimited', note: 'limitHit' }));
    server.get('/text', async (_req, reply) => reply.code(429).type('text/plain').send('"limitHit"'));
    server.get('/broken', async (_req, reply) => reply.code(429).type('application/json').send('{"error":"limitHit",'));
    await server.ready();
    return { server, store };
  }

  it('records the limit of a 429 or a 403 limitHit, whatever route sent it, and leaves the answer as it was', async () => {
    const { server, store } = await app({ kind: 'user', userId: USER, tier: 'registered' });
    const a = await server.inject({ method: 'GET', url: '/limit/aiLearns' });
    expect(a.statusCode).toBe(429);
    expect(a.json()).toEqual({ error: 'limitHit', limit: 'aiLearns', quota: { remaining: 0 } });
    const b = await server.inject({ method: 'GET', url: '/forbidden-limit' });
    expect(b.statusCode).toBe(403);
    expect(b.json()).toEqual({ error: 'limitHit', limit: 'savedFormats' });
    expect(store.events.map((e) => [e.type, e.props])).toEqual([
      ['limit_hit', { limit: 'aiLearns' }],
      ['limit_hit', { limit: 'savedFormats' }],
    ]);
  });

  it.each(LIMIT_CODES)('knows the limit %s', async (code) => {
    const { server, store } = await app({ kind: 'user', userId: USER, tier: 'registered' });
    await server.inject({ method: 'GET', url: `/limit/${code}` });
    expect(store.events.map((e) => e.props)).toEqual([{ limit: code }]);
  });

  it('records nothing for a limit nobody listed, another error, another status or a body that only mentions it', async () => {
    const { server, store } = await app({ kind: 'user', userId: USER, tier: 'registered' });
    for (const url of ['/limit/not-a-limit', '/limit/my%20file.xlsx', '/wrong-status', '/other-error', '/mentions', '/text', '/broken']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).not.toBe(500);
    }
    expect(store.events).toEqual([]);
  });

  it('stores a visitor\'s with no id at all', async () => {
    const { server, store } = await app({ kind: 'anon', anonId: 'AAAAAAAAAAAAAAAAAAAAAA' });
    await server.inject({ method: 'GET', url: '/limit/savedFormats' });
    expect(store.events).toHaveLength(1);
    expect(Object.keys(store.events[0]!).sort()).toEqual(['props', 'ts', 'type']);
  });
});

describe('limit_hit through the learn routes', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const originalQuota = structuredClone(tiers.registered.aiLearns);
  afterEach(() => {
    tiers.registered.aiLearns = structuredClone(originalQuota);
  });

  it('is written when the AI-learn quota is used up, for that user, and not for the learns that went through', async () => {
    const store = createMemoryEventStore();
    const llm = makeComplete();
    h = await createHarness(memoryKit, { complete: llm.fn, eventStore: store });
    expect(tiers.registered.aiLearns).toEqual({ count: 3, period: 'month' });
    for (let i = 0; i < 3; i++) expect((await h.learn({ noCache: true })).statusCode).toBe(200);
    expect(store.events).toEqual([]);
    const fourth = await h.learn({ noCache: true });
    expect(fourth.statusCode).toBe(429);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ type: 'limit_hit', props: { limit: 'aiLearns' } });
    expect(String(store.events[0]!.userId)).toBe(USER);
    // The answer is the one the web app already reads.
    expect(fourth.json()).toMatchObject({ error: 'limitHit', limit: 'aiLearns', period: 'month' });
  });
});
