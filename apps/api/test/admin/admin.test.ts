// The admin API end to end (SPEC 14.2, M4): fastify inject against a real MongoDB (skipped without MONGODB_URI), the identity stubbed with
// request headers (who is an admin is `Identity.isAdmin`, which the session sets from ADMIN_EMAILS: `access.test.ts` covers that path
// through real sign-ins). Covers the overview numbers on seeded data, users and the tier change with its audit log, function requests with
// the GitHub issue link (value-free), leads and feedback, the rate limit and the origin check.
import { randomUUID } from 'node:crypto';
import { limits, type AdminAuditResponse, type AdminContactsResponse, type AdminFunctionRequestsResponse, type AdminOverview, type AdminUsersResponse } from '@formatai/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { countProblems } from '../../src/learn/learn.js';
import type { FunctionRequestDoc, LlmCallDoc, UserDoc } from '../../src/models.js';
import type { Identity } from '../../src/protection/identity.js';
import { aiLearnsKey } from '../../src/protection/keys.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv, mongoUri, nextIp, testUserId } from '../protection/harness.js';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const at = (iso: string): Date => new Date(iso);

const ADMIN = testUserId(100);
const U1 = testUserId(1);
const U2 = testUserId(2);
const U3 = testUserId(3);
const WEB_ORIGIN = 'http://localhost:5173';

/** Who is calling, from two test headers: `x-test-user` (an id) and `x-test-admin: 1`. */
function identify(req: FastifyRequest): Identity {
  const user = req.headers['x-test-user'];
  if (typeof user !== 'string') return { kind: 'anon', anonId: req.anonId };
  return { kind: 'user', userId: user, tier: 'registered', anonId: req.anonId, isAdmin: req.headers['x-test-admin'] === '1' };
}

interface CallOptions {
  /** Default: the admin. `null`: not signed in. */
  user?: string | null;
  admin?: boolean;
  ip?: string;
  origin?: string;
}

describe.skipIf(!mongoUri)('admin API (MongoDB)', () => {
  let db: AppDb;
  let app: FastifyInstance;

  async function start(): Promise<void> {
    await app?.close();
    app = await buildServer({ env: makeEnv({ WEB_ORIGIN }), db, logger: false, store: createMemoryStore(() => NOW), now: () => new Date(NOW), identify });
  }

  async function call<T = any>(method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, body?: unknown, o: CallOptions = {}): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
    const user = o.user === undefined ? ADMIN : o.user;
    const res = await app.inject({
      method,
      url,
      remoteAddress: o.ip ?? nextIp(),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(user ? { 'x-test-user': user, ...(o.admin === false ? {} : { 'x-test-admin': '1' }) } : {}),
        ...(o.origin ? { origin: o.origin } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = res.body === '' ? null : res.json();
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers };
  }

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: `formatai_test_admin_${randomUUID().slice(0, 8)}` });
    const connected = await connectDb(env);
    if (!connected) throw new Error('MongoDB not configured');
    db = connected;
    await ensureIndexes(db);
  });

  afterAll(async () => {
    await app?.close();
    await db.db.dropDatabase();
    await db.client.close();
  });

  // ---------------------------------------------------------------- seeds

  const user = (id: string, over: Partial<UserDoc> & { email: string }): UserDoc & { _id: ObjectId } => {
    const { email, ...rest } = over;
    return {
      _id: new ObjectId(id),
      identities: [{ provider: 'google', subject: `sub-${id}`, email, emailVerified: true }],
      tier: 'registered',
      createdAt: at('2026-08-01T00:00:00Z'),
      lastSeenAt: at('2026-08-01T00:00:00Z'),
      anonIds: [],
      ...rest,
    };
  };

  const call_ = (over: Partial<LlmCallDoc> & Pick<LlmCallDoc, 'learnId' | 'ts' | 'model' | 'outcome'>, cost: number | null | 'none', problems: Record<string, number> = {}): LlmCallDoc => ({
    purpose: 'learn',
    promptVersion: 'learn-v7',
    masking: true,
    tokensIn: 1000,
    tokensOut: 100,
    tokensCached: 0,
    costUsd: 0,
    ...(cost === 'none' ? {} : { estimate: { inputTokens: 800, cachedInputTokens: 150, cacheWriteTokens: 50, outputTokens: 100, costUsd: cost } }),
    latencyMs: 10,
    cacheHit: false,
    problemCounts: { ...countProblems([]), ...problems },
    ...over,
  });

  async function seedActivity(): Promise<void> {
    await db.users.insertMany([
      user(ADMIN, { email: 'boss@example.com', name: 'The Boss', createdAt: at('2026-07-01T00:00:00Z'), lastSeenAt: at('2026-07-02T00:00:00Z') }),
      user(U1, { email: 'dana@example.com', name: 'Dana Levi', createdAt: at('2026-10-01T08:00:00Z'), lastSeenAt: at('2026-10-04T08:00:00Z') }),
      user(U2, { email: 'omar@example.org', name: 'Omar Haddad', createdAt: at('2026-09-01T08:00:00Z'), lastSeenAt: at('2026-09-10T08:00:00Z') }),
      user(U3, { email: 'noa@corp.example', name: 'Noa Peretz', tier: 'paid', createdAt: at('2026-10-03T08:00:00Z'), lastSeenAt: at('2026-10-05T08:00:00Z') }),
    ]);
    await db.llmCalls.insertMany([
      // L1: a learn that was repaired and verified (7 days)
      call_({ learnId: 'learn-secret-id-1', ts: at('2026-10-04T09:00:00Z'), model: 'gpt-5', outcome: 'needsRepair' }, 0.01, { formula: 2, diff: 1 }),
      call_({ learnId: 'learn-secret-id-1', ts: at('2026-10-04T09:01:00Z'), model: 'gpt-5', outcome: 'verified', purpose: 'repair' }, 0.02),
      // L2: answered, never passed the checks
      call_({ learnId: 'learn-secret-id-2', ts: at('2026-10-03T09:00:00Z'), model: 'claude-haiku-4-5', outcome: 'needsRepair' }, 0.005, { formula: 1, schema: 1 }),
      // L3: the provider failed (one call on a model with no price, one written before estimates existed)
      call_({ learnId: 'learn-secret-id-3', ts: at('2026-10-02T09:00:00Z'), model: 'mystery-model', outcome: 'error:timeout' }, null),
      call_({ learnId: 'learn-secret-id-3', ts: at('2026-10-02T09:05:00Z'), model: 'claude-haiku-4-5', outcome: 'error:providerError' }, 'none'),
      // L4: in the 30 days, not in the 7
      call_({ learnId: 'learn-secret-id-4', ts: at('2026-09-20T09:00:00Z'), model: 'claude-haiku-4-5', outcome: 'verified' }, 0.003),
      // two learns answered from the structure cache (no model: not calls)
      call_({ learnId: 'learn-secret-id-5', ts: at('2026-10-04T10:00:00Z'), model: 'cache', outcome: 'cacheHit', cacheHit: true }, 0),
      call_({ learnId: 'learn-secret-id-6', ts: at('2026-10-05T10:00:00Z'), model: 'cache', outcome: 'cacheHit', cacheHit: true }, 0),
    ]);
    await db.formats.insertMany([
      { _id: new ObjectId(), ownerId: new ObjectId(U1), name: 'a', createdAt: at('2026-10-02T00:00:00Z') },
      { _id: new ObjectId(), ownerId: new ObjectId(U1), name: 'b', createdAt: at('2026-09-01T00:00:00Z') },
      { _id: new ObjectId(), ownerId: new ObjectId(U3), name: 'c', createdAt: at('2026-09-15T00:00:00Z') },
    ] as never);
    await db.conversions.insertMany([
      { _id: new ObjectId(), ownerId: new ObjectId(U1), runCount: 4, lastRunAt: at('2026-10-04T00:00:00Z') },
      { _id: new ObjectId(), ownerId: new ObjectId(U3), runCount: 6, lastRunAt: at('2026-09-10T00:00:00Z') },
      { _id: new ObjectId(), ownerId: new ObjectId(U3), runCount: 0 },
    ] as never);
    await db.events.insertMany([
      { ts: at('2026-10-01T08:00:00Z'), type: 'signed_up', props: { provider: 'google' } },
      { ts: at('2026-10-03T08:00:00Z'), type: 'signed_up', props: { provider: 'microsoft' } },
      { ts: at('2026-10-04T08:00:00Z'), type: 'signed_in', props: { provider: 'google' } },
      { ts: at('2026-08-04T08:00:00Z'), type: 'signed_in', props: { provider: 'google' } },
    ]);
  }

  const request = (over: Partial<FunctionRequestDoc> & Pick<FunctionRequestDoc, 'key' | 'name'>): FunctionRequestDoc => ({
    purpose: 'Finds the storage site of an item from an external reference table.',
    args: [{ name: 'item', type: 'text' }],
    returns: 'text',
    topic: 'lookups',
    count: 1,
    distinctOwners: 1,
    ownerHashes: ['hash-aaaa1111'],
    firstSeen: at('2026-10-01T00:00:00Z'),
    lastSeen: at('2026-10-04T00:00:00Z'),
    status: 'new',
    ...over,
  });

  beforeEach(async () => {
    await Promise.all(
      [db.users, db.llmCalls, db.formats, db.conversions, db.events, db.functionRequests, db.adminAudit, db.usageCounters].map((c) => (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({})),
    );
    await db.db.collection('leads').deleteMany({});
    await db.db.collection('feedback').deleteMany({});
    await start();
  });

  // ---------------------------------------------------------------- the gate

  describe('the gate', () => {
    const routes: ['GET' | 'PATCH', string, unknown?][] = [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/function-requests'],
      ['PATCH', `/api/admin/function-requests/${new ObjectId().toHexString()}`, { status: 'issueOpened' }],
      ['GET', '/api/admin/users'],
      ['PATCH', `/api/admin/users/${U1}`, { tier: 'paid' }],
      ['GET', '/api/admin/contacts'],
      ['GET', '/api/admin/audit'],
    ];

    it('answers 401 signInRequired to a visitor and 403 forbidden to a user who is not an admin, on every route', async () => {
      await seedActivity();
      for (const [method, url, body] of routes) {
        const visitor = await call(method, url, body, { user: null });
        expect(visitor.status, `${method} ${url}`).toBe(401);
        expect(visitor.body).toEqual({ error: 'signInRequired' });
        const plain = await call(method, url, body, { admin: false, user: U1 });
        expect(plain.status, `${method} ${url}`).toBe(403);
        expect(plain.body).toEqual({ error: 'forbidden' });
      }
      // ...and nothing was changed by the refused PATCHes
      expect((await db.users.findOne({ _id: new ObjectId(U1) }))!.tier).toBe('registered');
      expect(await db.adminAudit.countDocuments()).toBe(0);
    });

    it('answers 503 unavailable without a database, after the gate', async () => {
      const bare = await buildServer({ env: makeEnv({ WEB_ORIGIN }), db: null, logger: false, store: createMemoryStore(), identify });
      try {
        const send = (admin: boolean, user = ADMIN) =>
          bare.inject({ method: 'GET', url: '/api/admin/overview', headers: { 'x-test-user': user, ...(admin ? { 'x-test-admin': '1' } : {}) } });
        expect((await send(true)).statusCode).toBe(503);
        expect((await send(false)).statusCode).toBe(403);
        expect((await bare.inject({ method: 'GET', url: '/api/admin/overview' })).statusCode).toBe(401);
      } finally {
        await bare.close();
      }
    });

    it('never lets a response be cached', async () => {
      const res = await call('GET', '/api/admin/overview');
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await call('GET', '/api/admin/overview', undefined, { user: null })).headers['cache-control']).toBe('no-store');
    });

    it('is rate limited per IP like the other routes: 429 with Retry-After, before anything else is looked at', async () => {
      const original = limits.admin.requestsPerIpPerMinute;
      (limits.admin as { requestsPerIpPerMinute: number }).requestsPerIpPerMinute = 3;
      try {
        await start();
        const ip = '198.51.100.250';
        for (let i = 0; i < 3; i++) expect((await call('GET', '/api/admin/audit', undefined, { ip })).status).toBe(200);
        const limited = await call('GET', '/api/admin/audit', undefined, { ip });
        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({ error: 'rateLimited' });
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        // a visitor probing from the same address is counted too, and another address is not affected
        expect((await call('GET', '/api/admin/audit', undefined, { ip, user: null })).status).toBe(429);
        expect((await call('GET', '/api/admin/audit', undefined, { ip: '198.51.100.251' })).status).toBe(200);
      } finally {
        (limits.admin as { requestsPerIpPerMinute: number }).requestsPerIpPerMinute = original;
      }
    });

    it('refuses a change that comes from another origin, and accepts our own', async () => {
      await seedActivity();
      const foreign = await call('PATCH', `/api/admin/users/${U1}`, { tier: 'paid' }, { origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      expect((await db.users.findOne({ _id: new ObjectId(U1) }))!.tier).toBe('registered');
      const ours = await call('PATCH', `/api/admin/users/${U1}`, { tier: 'paid' }, { origin: WEB_ORIGIN });
      expect(ours.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- overview

  describe('GET /api/admin/overview', () => {
    it('adds up the last 7 days on seeded data', async () => {
      await seedActivity();
      const { status, body } = await call<AdminOverview>('GET', '/api/admin/overview?days=7');
      expect(status).toBe(200);
      expect(body.days).toBe(7);
      expect([body.from, body.to]).toEqual(['2026-09-29', '2026-10-05']);

      // users: the admin is a user too
      expect(body.users).toEqual({ total: 4, registered: 3, paid: 1, newInPeriod: 2, activeInPeriod: 2 });

      // learns: L1 verified, L2 failed, L3 errored; two from the cache; none local is known
      expect(body.learns).toEqual({ ai: 3, aiVerified: 1, aiFailed: 1, aiErrored: 1, cache: 2, local: null });

      // calls and cost: gpt-5 (0.01 + 0.02), haiku (0.005 priced; one with no estimate), an unpriced model
      expect(body.llm.calls).toBe(5);
      expect(body.llm.costUsd).toBeCloseTo(0.035, 6);
      expect(body.llm.unpriced).toBe(2);
      expect(body.llm.byModel).toEqual([
        { model: 'claude-haiku-4-5', calls: 2, inputTokens: 1000, outputTokens: 100, costUsd: 0.005, unpriced: 1 },
        { model: 'gpt-5', calls: 2, inputTokens: 2000, outputTokens: 200, costUsd: 0.03, unpriced: 0 },
        { model: 'mystery-model', calls: 1, inputTokens: 1000, outputTokens: 100, costUsd: null, unpriced: 1 },
      ]);
      expect(body.llm.byDay.map((d) => d.day)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
      expect(body.llm.byDay.map((d) => [d.aiCalls, d.costUsd])).toEqual([
        [0, null],
        [0, null],
        [0, null],
        [2, null], // two calls, neither priced: n/a, not 0
        [1, 0.005],
        [2, 0.03],
        [0, null],
      ]);

      // problems: zeros left out, the most frequent first
      expect(body.problems).toEqual([
        { kind: 'formula', count: 3 },
        { kind: 'diff', count: 1 },
        { kind: 'schema', count: 1 },
      ]);

      // registry
      expect(body.conversions).toEqual({ formats: 3, formatsNew: 1, ranInPeriod: 1, runsAllTime: 10 });

      // events by type in the period
      expect(body.events).toEqual([
        { type: 'signed_up', count: 2 },
        { type: 'signed_in', count: 1 },
      ]);
    });

    it('widens with the period: 30 days also holds the older learn and its call', async () => {
      await seedActivity();
      const { body } = await call<AdminOverview>('GET', '/api/admin/overview?days=30');
      expect(body.days).toBe(30);
      expect(body.llm.byDay).toHaveLength(30);
      expect(body.learns).toMatchObject({ ai: 4, aiVerified: 2, aiFailed: 1, aiErrored: 1, cache: 2 });
      expect(body.llm.calls).toBe(6);
      expect(body.llm.costUsd).toBeCloseTo(0.038, 6);
      expect(body.users).toMatchObject({ newInPeriod: 2, activeInPeriod: 3 });
    });

    it('defaults to 30 days and refuses a period that is not offered', async () => {
      expect((await call<AdminOverview>('GET', '/api/admin/overview')).body.days).toBe(30);
      for (const days of ['0', '1', '8', '-7', 'abc', '7.5', '30%20', '']) {
        const res = await call('GET', `/api/admin/overview?days=${days}`);
        expect(res.status, days).toBe(400);
        expect(res.body).toEqual({ error: 'invalidRequest' });
      }
      expect((await call<AdminOverview>('GET', '/api/admin/overview?days=90')).status).toBe(200);
    });

    it('is all zeros and "not known" on an empty database', async () => {
      const { status, body } = await call<AdminOverview>('GET', '/api/admin/overview?days=7');
      expect(status).toBe(200);
      expect(body.users).toEqual({ total: 0, registered: 0, paid: 0, newInPeriod: 0, activeInPeriod: 0 });
      expect(body.learns).toEqual({ ai: 0, aiVerified: 0, aiFailed: 0, aiErrored: 0, cache: 0, local: null });
      expect(body.llm).toMatchObject({ calls: 0, costUsd: null, unpriced: 0, byModel: [] });
      expect(body.llm.byDay.every((d) => d.aiCalls === 0 && d.costUsd === null)).toBe(true);
      expect(body.problems).toEqual([]);
      expect(body.functionRequests).toEqual({ groups: 0, requests: 0, atThreshold: 0, issueOpened: 0, newInPeriod: 0 });
    });

    it('knows the local learns only from learn_completed events (and says null until there are some)', async () => {
      await db.events.insertMany([
        { ts: at('2026-10-04T00:00:00Z'), type: 'learn_completed', props: { path: 'local' } },
        { ts: at('2026-10-04T00:00:00Z'), type: 'learn_completed', props: { path: 'local' } },
        { ts: at('2026-10-04T00:00:00Z'), type: 'learn_completed', props: { path: 'llm' } },
      ]);
      const { body } = await call<AdminOverview>('GET', '/api/admin/overview?days=7');
      expect(body.learns.local).toBe(2);
    });

    it('counts function requests: groups, times, the ones at the threshold, opened issues, new ones', async () => {
      const threshold = limits.learn.functionRequests.issueThreshold;
      await db.functionRequests.insertMany([
        request({ key: 'a(text):text', name: 'a', count: 9, distinctOwners: threshold, firstSeen: at('2026-10-01T00:00:00Z') }),
        request({ key: 'b(text):text', name: 'b', count: 3, distinctOwners: 2, firstSeen: at('2026-08-01T00:00:00Z') }),
        request({ key: 'c(text):text', name: 'c', count: 12, distinctOwners: threshold + 3, status: 'issueOpened', firstSeen: at('2026-08-01T00:00:00Z') }),
      ]);
      const { body } = await call<AdminOverview>('GET', '/api/admin/overview?days=7');
      expect(body.functionRequests).toEqual({ groups: 3, requests: 24, atThreshold: 2, issueOpened: 1, newInPeriod: 1 });
    });

    it('shows counts only: no ledger text, learn id, user id or email is anywhere in the answer', async () => {
      await seedActivity();
      const res = await call('GET', '/api/admin/overview?days=30');
      const text = JSON.stringify(res.body);
      for (const secret of ['learn-secret-id', 'dana@example.com', 'noa@corp.example', U1, U3, 'sub-', 'ownerHashes', 'promptVersion']) {
        expect(text, secret).not.toContain(secret);
      }
    });
  });

  // ---------------------------------------------------------------- function requests

  describe('function requests', () => {
    const threshold = limits.learn.functionRequests.issueThreshold;

    async function seedRequests(): Promise<{ top: ObjectId; low: ObjectId; opened: ObjectId; approved: ObjectId }> {
      const docs = [
        request({ key: 'lookupstoragesite(text):text', name: 'lookupStorageSite', count: 9, distinctOwners: threshold + 1, ownerHashes: ['hash-secret-aaa', 'hash-secret-bbb'] }),
        request({ key: 'quarterofdate(date):integer', name: 'quarterOfDate', purpose: 'Gives the calendar quarter of a date.', args: [{ name: 'when', type: 'date' }], returns: 'integer', topic: 'dates', count: 3, distinctOwners: 2, lastSeen: at('2026-10-05T00:00:00Z') }),
        request({ key: 'splitnames(text):text', name: 'splitNames', count: 20, distinctOwners: threshold, status: 'issueOpened', topic: 'extraction' }),
        request({ key: 'oldone(text):text', name: 'oldOne', count: 30, distinctOwners: 30, status: 'approved' }),
      ];
      const res = await db.functionRequests.insertMany(docs);
      const ids = Object.values(res.insertedIds);
      return { top: ids[0]!, low: ids[1]!, opened: ids[2]!, approved: ids[3]! };
    }

    it('lists each group (name + signature) with count, first and last seen, topic, status - the most asked first', async () => {
      await seedRequests();
      const { status, body } = await call<AdminFunctionRequestsResponse>('GET', '/api/admin/function-requests');
      expect(status).toBe(200);
      expect(body.threshold).toBe(threshold);
      expect(body.requests.map((r) => r.name)).toEqual(['oldOne', 'lookupStorageSite', 'splitNames', 'quarterOfDate']);
      const top = body.requests.find((r) => r.name === 'lookupStorageSite')!;
      expect(top).toMatchObject({
        signature: 'lookupStorageSite(item: text): text',
        purpose: 'Finds the storage site of an item from an external reference table.',
        topic: 'lookups',
        count: 9,
        distinctOwners: threshold + 1,
        firstSeen: '2026-10-01T00:00:00.000Z',
        lastSeen: '2026-10-04T00:00:00.000Z',
        status: 'new',
        atThreshold: true,
      });
      const low = body.requests.find((r) => r.name === 'quarterOfDate')!;
      expect(low).toMatchObject({ signature: 'quarterOfDate(when: date): integer', topic: 'dates', atThreshold: false });
      expect(low.issueUrl).toBeUndefined();
    });

    it('offers the GitHub issue link only to a new group at the threshold, and it holds only the value-free request', async () => {
      await seedRequests();
      await db.users.insertOne(user(U1, { email: 'dana@example.com' }));
      const { body } = await call<AdminFunctionRequestsResponse>('GET', '/api/admin/function-requests');
      const byName = new Map(body.requests.map((r) => [r.name, r] as const));
      expect(byName.get('lookupStorageSite')!.issueUrl).toBeDefined();
      expect(byName.get('quarterOfDate')!.issueUrl).toBeUndefined(); // below the threshold
      expect(byName.get('splitNames')!.issueUrl).toBeUndefined(); // already opened: not offered twice
      expect(byName.get('oldOne')!.issueUrl).toBeUndefined();

      const link = new URL(byName.get('lookupStorageSite')!.issueUrl!);
      expect(link.origin + link.pathname).toBe('https://github.com/mordaby/formatAi/issues/new');
      expect([...link.searchParams.keys()].sort()).toEqual(['body', 'title']);
      expect(link.searchParams.get('title')).toBe('Function request: lookupStorageSite(item: text): text');
      const text = link.searchParams.get('body')!;
      expect(text).toContain('lookupStorageSite');
      expect(text).toContain('Finds the storage site of an item from an external reference table.');
      expect(text).toContain('lookupStorageSite(item: text): text');
      expect(text).toContain(`${threshold + 1} different users`);
      expect(text).toContain('9 times');

      // nothing about who asked, in the link or anywhere in the list
      const all = JSON.stringify(body) + link.href;
      expect(all).not.toContain('hash-secret');
      expect(all).not.toContain('ownerHashes');
      expect(all).not.toContain('dana@example.com');
      expect(all).not.toContain(U1);
    });

    it('marks a group "issue opened" (once, with the audit log), and takes it back', async () => {
      const { top } = await seedRequests();
      const url = `/api/admin/function-requests/${top.toHexString()}`;
      await db.users.insertOne(user(ADMIN, { email: 'boss@example.com' }));

      const marked = await call('PATCH', url, { status: 'issueOpened' });
      expect(marked.status).toBe(200);
      expect(marked.body.request).toMatchObject({ name: 'lookupStorageSite', status: 'issueOpened' });
      expect(marked.body.request.issueUrl).toBeUndefined();
      expect((await db.functionRequests.findOne({ _id: top }))!.status).toBe('issueOpened');

      // asking again changes nothing and writes nothing
      expect((await call('PATCH', url, { status: 'issueOpened' })).status).toBe(200);
      expect(await db.adminAudit.countDocuments()).toBe(1);

      const audit = (await db.adminAudit.find({}).toArray())[0]!;
      expect(audit).toMatchObject({ action: 'functionRequest.status', targetKind: 'functionRequest', before: 'new', after: 'issueOpened', adminEmail: 'boss@example.com' });
      expect(audit.adminId.toHexString()).toBe(ADMIN);
      expect(audit.targetId.equals(top)).toBe(true);
      expect(audit.ts).toEqual(NOW);

      // the list no longer offers it
      const list = await call<AdminFunctionRequestsResponse>('GET', '/api/admin/function-requests');
      expect(list.body.requests.find((r) => r.name === 'lookupStorageSite')).toMatchObject({ status: 'issueOpened', atThreshold: true });
      expect(list.body.requests.find((r) => r.name === 'lookupStorageSite')!.issueUrl).toBeUndefined();

      // ...unless the admin takes the mark back
      const undone = await call('PATCH', url, { status: 'new' });
      expect(undone.body.request.issueUrl).toContain('https://github.com/mordaby/formatAi/issues/new?');
      expect(await db.adminAudit.countDocuments()).toBe(2);
    });

    it('does not touch what the build pipeline owns, and refuses bad input', async () => {
      const { approved, low } = await seedRequests();
      expect((await call('PATCH', `/api/admin/function-requests/${approved.toHexString()}`, { status: 'new' })).status).toBe(409);
      expect((await db.functionRequests.findOne({ _id: approved }))!.status).toBe('approved');
      for (const body of [{ status: 'approved' }, { status: 'declined' }, { status: 'bogus' }, {}, { status: 'issueOpened', count: 0 }, [], null]) {
        expect((await call('PATCH', `/api/admin/function-requests/${low.toHexString()}`, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await call('PATCH', '/api/admin/function-requests/not-an-id', { status: 'issueOpened' })).status).toBe(404);
      expect((await call('PATCH', `/api/admin/function-requests/${new ObjectId().toHexString()}`, { status: 'issueOpened' })).status).toBe(404);
      expect(await db.adminAudit.countDocuments()).toBe(0);
    });
  });

  // ---------------------------------------------------------------- users

  describe('users', () => {
    beforeEach(async () => {
      await seedActivity();
      await db.usageCounters.insertOne({ key: aiLearnsKey(U1, 'month', NOW), count: 2 });
    });

    it('lists users newest first with tier, created date, AI learns used this period and formats', async () => {
      const { status, body } = await call<AdminUsersResponse>('GET', '/api/admin/users');
      expect(status).toBe(200);
      expect(body).toMatchObject({ total: 4, page: 1, pageSize: limits.admin.usersPageSize });
      expect(body.users.map((u) => u.name)).toEqual(['Noa Peretz', 'Dana Levi', 'Omar Haddad', 'The Boss']);
      const dana = body.users[1]!;
      expect(dana).toMatchObject({
        id: U1,
        emails: ['dana@example.com'],
        providers: ['google'],
        tier: 'registered',
        createdAt: '2026-10-01T08:00:00.000Z',
        lastSeenAt: '2026-10-04T08:00:00.000Z',
        aiLearns: { used: 2, limit: 3, period: 'month' },
        formats: 2,
        limitOverrides: {},
      });
      const noa = body.users[0]!;
      expect(noa).toMatchObject({ tier: 'paid', aiLearns: { used: 0, limit: 150, period: 'month' }, formats: 1 });
    });

    it('searches by email or name, case-insensitively, as text and never as a pattern', async () => {
      const names = async (q: string): Promise<string[]> => (await call<AdminUsersResponse>('GET', `/api/admin/users?q=${encodeURIComponent(q)}`)).body.users.map((u) => u.name ?? '');
      expect(await names('DANA@')).toEqual(['Dana Levi']);
      expect(await names('corp.example')).toEqual(['Noa Peretz']);
      expect(await names('haddad')).toEqual(['Omar Haddad']);
      expect(await names('example.org')).toEqual(['Omar Haddad']);
      expect(await names('nobody')).toEqual([]);
      expect(await names('.*')).toEqual([]);
      expect(await names('(')).toEqual([]);
      expect((await call<AdminUsersResponse>('GET', `/api/admin/users?q=${encodeURIComponent('example')}`)).body.total).toBe(4);
    });

    it('pages the list', async () => {
      const first = await call<AdminUsersResponse>('GET', '/api/admin/users?pageSize=3&page=1');
      const second = await call<AdminUsersResponse>('GET', '/api/admin/users?pageSize=3&page=2');
      expect(first.body.users).toHaveLength(3);
      expect(second.body.users.map((u) => u.name)).toEqual(['The Boss']);
      expect(second.body.total).toBe(4);
      for (const q of ['pageSize=0', `pageSize=${limits.admin.maxUsersPageSize + 1}`, 'page=0', 'page=x']) {
        expect((await call('GET', `/api/admin/users?${q}`)).status, q).toBe(400);
      }
    });

    it('sets the tier, records who/when/what, and does nothing (and logs nothing) when nothing changes', async () => {
      const res = await call('PATCH', `/api/admin/users/${U1}`, { tier: 'paid' });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: U1, tier: 'paid', aiLearns: { used: 2, limit: 150, period: 'month' } });
      expect((await db.users.findOne({ _id: new ObjectId(U1) }))!.tier).toBe('paid');

      const lines = await db.adminAudit.find({}).toArray();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ action: 'user.tier', targetKind: 'user', before: 'registered', after: 'paid', adminEmail: 'boss@example.com' });
      expect(lines[0]!.adminId.toHexString()).toBe(ADMIN);
      expect(lines[0]!.targetId.toHexString()).toBe(U1);
      expect(lines[0]!.ts).toEqual(NOW);

      expect((await call('PATCH', `/api/admin/users/${U1}`, { tier: 'paid' })).status).toBe(200);
      expect(await db.adminAudit.countDocuments()).toBe(1);

      // and back
      expect((await call('PATCH', `/api/admin/users/${U1}`, { tier: 'registered' })).body.user.tier).toBe('registered');
      expect(await db.adminAudit.countDocuments()).toBe(2);
    });

    it('cannot make a user anonymous, nor change anything but the tier and the overrides', async () => {
      for (const body of [{ tier: 'anonymous' }, { tier: 'admin' }, { tier: '' }, { tier: null }, { name: 'x' }, { tier: 'paid', identities: [] }, {}, [], 'paid', null]) {
        const res = await call('PATCH', `/api/admin/users/${U1}`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body).toEqual({ error: 'invalidRequest' });
      }
      const stored = await db.users.findOne({ _id: new ObjectId(U1) });
      expect(stored!.tier).toBe('registered');
      expect(stored!.identities).toHaveLength(1);
      expect(await db.adminAudit.countDocuments()).toBe(0);
    });

    it('sets and clears limitOverrides (aiLearns), and the new limit shows at once', async () => {
      const set = await call('PATCH', `/api/admin/users/${U1}`, { limitOverrides: { aiLearns: 10 } });
      expect(set.status).toBe(200);
      expect(set.body.user).toMatchObject({ limitOverrides: { aiLearns: 10 }, aiLearns: { used: 2, limit: 10 } });
      expect((await db.users.findOne({ _id: new ObjectId(U1) }))!.limitOverrides).toEqual({ aiLearns: 10 });

      // tier and override in one request: two log lines
      const both = await call('PATCH', `/api/admin/users/${U1}`, { tier: 'paid', limitOverrides: { aiLearns: 400 } });
      expect(both.body.user).toMatchObject({ tier: 'paid', aiLearns: { limit: 400 } });
      expect(await db.adminAudit.countDocuments()).toBe(3);
      const overrideLines = (await db.adminAudit.find({ action: 'user.limitOverrides' }).sort({ _id: 1 }).toArray()).map((l) => [l.before, l.after]);
      expect(overrideLines).toEqual([
        [null, { aiLearns: 10 }],
        [{ aiLearns: 10 }, { aiLearns: 400 }],
      ]);

      // null (or {}) takes the override away
      const cleared = await call('PATCH', `/api/admin/users/${U1}`, { limitOverrides: null });
      expect(cleared.body.user).toMatchObject({ limitOverrides: {}, aiLearns: { limit: 150 } });
      expect((await db.users.findOne({ _id: new ObjectId(U1) }))!.limitOverrides).toBeUndefined();
      expect((await call('PATCH', `/api/admin/users/${U1}`, { limitOverrides: {} })).status).toBe(200);
      expect(await db.adminAudit.countDocuments()).toBe(4); // clearing what is already clear is not a change
    });

    it('refuses an override nothing reads, a fraction, a negative, a text or a huge number', async () => {
      for (const limitOverrides of [{ savedFormats: 5 }, { aiLearns: 1.5 }, { aiLearns: -1 }, { aiLearns: '5' }, { aiLearns: limits.admin.maxOverride + 1 }, { aiLearns: null }, [], 'x', 5]) {
        const res = await call('PATCH', `/api/admin/users/${U1}`, { limitOverrides });
        expect(res.status, JSON.stringify(limitOverrides)).toBe(400);
      }
      expect((await call('PATCH', `/api/admin/users/${U1}`, { limitOverrides: { aiLearns: 0 } })).status).toBe(200); // zero is a limit
      expect((await call('PATCH', `/api/admin/users/${U1}`, { limitOverrides: { aiLearns: limits.admin.maxOverride } })).status).toBe(200);
    });

    it('answers 404 for an unknown user, and does not log it', async () => {
      expect((await call('PATCH', `/api/admin/users/${new ObjectId().toHexString()}`, { tier: 'paid' })).status).toBe(404);
      expect((await call('PATCH', '/api/admin/users/nope', { tier: 'paid' })).status).toBe(404);
      expect(await db.adminAudit.countDocuments()).toBe(0);
    });

    it('lists the audit log newest first with who changed what, and the target named now', async () => {
      await call('PATCH', `/api/admin/users/${U1}`, { tier: 'paid' });
      await call('PATCH', `/api/admin/users/${U3}`, { limitOverrides: { aiLearns: 500 } });
      const { status, body } = await call<AdminAuditResponse>('GET', '/api/admin/audit');
      expect(status).toBe(200);
      expect(body.entries).toHaveLength(2);
      expect(body.entries.map((e) => e.action).sort()).toEqual(['user.limitOverrides', 'user.tier']);
      const tier = body.entries.find((e) => e.action === 'user.tier')!;
      expect(tier).toMatchObject({ adminEmail: 'boss@example.com', adminId: ADMIN, targetKind: 'user', targetId: U1, targetLabel: 'dana@example.com', before: 'registered', after: 'paid', ts: NOW.toISOString() });
    });
  });

  // ---------------------------------------------------------------- leads and feedback

  describe('leads and feedback', () => {
    it('lists them newest first, read-only, whichever shape the form wrote', async () => {
      await db.db.collection('leads').insertMany([
        { ts: at('2026-10-01T00:00:00Z'), name: 'Ruth', email: 'ruth@firm.example', company: 'Firm', role: 'CFO', message: 'We get 40 supplier files a month.', language: 'he', ipHash: 'secret-ip-hash' },
        { createdAt: at('2026-10-04T00:00:00Z'), kind: 'business', name: 'Sam', email: 'sam@big.example', company: 'Big', message: 'Pricing?', page: '/business' },
      ]);
      await db.db.collection('feedback').insertMany([
        { ts: at('2026-10-03T00:00:00Z'), rating: 4, text: 'Nice.', userId: new ObjectId(U1), formatId: new ObjectId() },
        { createdAt: at('2026-10-05T00:00:00Z'), kind: 'bug', message: 'The preview was empty.', page: '/result', rating: 2 },
      ]);
      const { status, body } = await call<AdminContactsResponse>('GET', '/api/admin/contacts');
      expect(status).toBe(200);
      expect(body.items.map((i) => [i.source, i.kind, i.createdAt])).toEqual([
        ['feedback', 'bug', '2026-10-05T00:00:00.000Z'],
        ['lead', 'business', '2026-10-04T00:00:00.000Z'],
        ['feedback', 'feedback', '2026-10-03T00:00:00.000Z'],
        ['lead', 'lead', '2026-10-01T00:00:00.000Z'],
      ]);
      expect(body.items[0]).toMatchObject({ message: 'The preview was empty.', page: '/result', rating: 2 });
      expect(body.items[1]).toMatchObject({ name: 'Sam', email: 'sam@big.example', company: 'Big', message: 'Pricing?', page: '/business' });
      expect(body.items[2]).toMatchObject({ message: 'Nice.', rating: 4 });
      expect(body.items[3]).toMatchObject({ name: 'Ruth', company: 'Firm', role: 'CFO', language: 'he' });
      // only the whitelisted fields travel
      const text = JSON.stringify(body);
      expect(text).not.toContain('secret-ip-hash');
      expect(text).not.toContain(U1);

      const onlyLeads = await call<AdminContactsResponse>('GET', '/api/admin/contacts?source=lead');
      expect(onlyLeads.body.items.map((i) => i.source)).toEqual(['lead', 'lead']);
      expect((await call('GET', '/api/admin/contacts?source=other')).status).toBe(400);
    });

    it('is empty when nobody has written yet', async () => {
      expect((await call<AdminContactsResponse>('GET', '/api/admin/contacts')).body).toEqual({ items: [] });
    });

    afterEach(async () => {
      await db.db.collection('leads').deleteMany({});
      await db.db.collection('feedback').deleteMany({});
    });
  });
});
