// The public forms end to end (fastify inject): POST /api/leads, /api/waitlist and /api/feedback (SPEC 16.1 screen 7, 11, 13).
// Every suite runs against the in-memory stores, and against a real local MongoDB when MONGODB_URI is set.
import { randomUUID } from 'node:crypto';
import { limits } from '@formatai/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { contactDayKey } from '../../src/contact/routes.js';
import { createMemoryContactStore, createMongoContactStore, type ContactStore } from '../../src/contact/store.js';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import type { FeedbackDoc, LeadDoc } from '../../src/models.js';
import { hashIp } from '../../src/protection/ip.js';
import { dayKey } from '../../src/protection/keys.js';
import { createMemoryStore, createMongoStore, type ProtectionStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { anonCookie, makeEnv, makeTurnstileFetch, nextIp, stubIdentify, testUserId, type TurnstileCall } from '../protection/harness.js';
import { dropTestDb } from '../setup/testDbs.js';

const mongoUri = process.env.MONGODB_URI;
const SECRET = 'contact-test-secret';
const USER = testUserId(7);
const NOW = new Date('2026-10-05T10:00:00.000Z');

interface Handle {
  protectionStore: ProtectionStore;
  contactStore: ContactStore;
  leads(): Promise<LeadDoc[]>;
  feedback(): Promise<FeedbackDoc[]>;
  counter(key: string): Promise<number>;
  /** Every document and counter key the forms left behind, as text, for "no raw IP anywhere" checks. */
  everything(): Promise<string>;
}

interface Kit {
  name: string;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  make(now: () => Date): Promise<Handle>;
}

const memoryKit: Kit = {
  name: 'memory',
  async make(now) {
    const protectionStore = createMemoryStore(now);
    const contactStore = createMemoryContactStore();
    return {
      protectionStore,
      contactStore,
      leads: async () => contactStore.leads.map((d) => ({ ...d })),
      feedback: async () => contactStore.feedback.map((d) => ({ ...d })),
      counter: async (key) => protectionStore.counter(key),
      everything: async () => JSON.stringify([contactStore.leads, contactStore.feedback, protectionStore.ledger]),
    };
  },
};

function mongoKit(): Kit {
  let appDb: AppDb | null = null;
  const dbName = `formatai_test_${randomUUID().slice(0, 8)}`;
  return {
    name: 'mongo',
    async setup() {
      appDb = await connectDb(loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: dbName }));
      if (!appDb) throw new Error('MongoDB not configured');
      await ensureIndexes(appDb);
    },
    async teardown() {
      const db = appDb;
      appDb = null;
      await dropTestDb(db);
    },
    async make() {
      const db = appDb!;
      await Promise.all([db.leads.deleteMany({}), db.feedback.deleteMany({}), db.usageCounters.deleteMany({})]);
      return {
        protectionStore: createMongoStore(db),
        contactStore: createMongoContactStore(db),
        leads: () => db.leads.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray() as Promise<LeadDoc[]>,
        feedback: () => db.feedback.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray() as Promise<FeedbackDoc[]>,
        counter: async (key) => (await db.usageCounters.findOne({ key }))?.count ?? 0,
        everything: async () =>
          JSON.stringify(await Promise.all([db.leads.find().toArray(), db.feedback.find().toArray(), db.usageCounters.find().toArray()])),
      };
    },
  };
}

interface Options {
  /** Set to turn Turnstile on (a siteverify that accepts only the token 'good'). */
  turnstile?: boolean;
}

interface Harness {
  app: FastifyInstance;
  handle: Handle;
  clock: { current: Date };
  turnstileCalls: TurnstileCall[];
  post(url: string, body: unknown, o?: { ip?: string; user?: string | null; cookie?: string }): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

async function createHarness(kit: Kit, opts: Options = {}): Promise<Harness> {
  const clock = { current: new Date(NOW) };
  const now = (): Date => new Date(clock.current);
  const handle = await kit.make(now);
  const turnstile = makeTurnstileFetch(['good']);
  const app = await buildServer({
    env: makeEnv({ IP_HASH_SECRET: SECRET, ...(opts.turnstile ? { TURNSTILE_SECRET_KEY: 'turnstile-secret' } : {}) }),
    db: null,
    logger: false,
    store: handle.protectionStore,
    contactStore: handle.contactStore,
    fetch: turnstile.fn,
    now,
    identify: stubIdentify,
  });
  return {
    app,
    handle,
    clock,
    turnstileCalls: turnstile.calls,
    post: (url, body, o = {}) =>
      app.inject({
        method: 'POST',
        url,
        remoteAddress: o.ip ?? nextIp(),
        headers: {
          'content-type': 'application/json',
          ...(o.cookie ? { cookie: o.cookie } : {}),
          ...(o.user ? { 'x-test-user': o.user } : {}),
        },
        payload: JSON.stringify(body),
      }),
    close: () => app.close(),
  };
}

const lead = { name: 'Dana Levi', email: 'dana@example.com', company: 'Acme Ltd', message: 'We receive 30 supplier files a month.', page: '/business' };
const waitlist = { email: 'dana@example.com', message: 'More formats, please.', trigger: 'savedFormats', page: '/formats' };
const feedback = { message: 'The preview is great.', page: '/result' };

function defineSuite(kit: Kit): void {
  beforeAll(async () => {
    await kit.setup?.();
  });
  afterAll(async () => {
    await kit.teardown?.();
  });

  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });
  async function setup(opts: Options = {}): Promise<Harness> {
    harness = await createHarness(kit, opts);
    return harness;
  }

  describe('POST /api/leads', () => {
    it('stores exactly { createdAt, kind, name, email, company, message, page, anonId } and answers ok', async () => {
      const h = await setup();
      const first = await h.post('/api/leads', { ...lead, email: ' Dana@Example.com ' }, { user: null });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ok: true });

      const [stored, ...rest] = await h.handle.leads();
      expect(rest).toHaveLength(0);
      expect(stored).toEqual({
        createdAt: NOW,
        kind: 'lead',
        name: 'Dana Levi',
        email: 'dana@example.com',
        company: 'Acme Ltd',
        message: 'We receive 30 supplier files a month.',
        page: '/business',
        anonId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
      });
      expect(await h.handle.feedback()).toEqual([]);
    });

    it('takes the anonId from the visitor cookie, and never stores the IP', async () => {
      const h = await setup();
      const cookie = anonCookie(await h.app.inject({ method: 'GET', url: '/api/session' }));
      const ip = '203.0.113.77';
      expect((await h.post('/api/leads', lead, { cookie, ip, user: null })).statusCode).toBe(200);
      const [stored] = await h.handle.leads();
      expect(stored!.anonId).toBe(cookie.slice('anonId='.length));
      expect(await h.handle.everything()).not.toContain(ip);
      // The durable per-IP limit counts on a keyed hash of the address.
      expect(await h.handle.counter(contactDayKey(hashIp(ip, SECRET), dayKey(NOW)))).toBe(1);
    });

    it('leaves out a company and a message that were not given, and stores nothing else that was sent', async () => {
      const h = await setup();
      const res = await h.post('/api/leads', { name: 'Dana', email: 'd@x.co', page: '/business?utm=1', rules: { x: 1 }, rows: [[1]], ip: '1.2.3.4', userId: USER, isAdmin: true, kind: 'waitlist', turnstileToken: 't' }, { user: null });
      expect(res.statusCode).toBe(200);
      const [stored] = await h.handle.leads();
      expect(Object.keys(stored!).sort()).toEqual(['anonId', 'createdAt', 'email', 'kind', 'name', 'page']);
      expect(stored).toMatchObject({ kind: 'lead', page: '/business' });
    });

    it.each([
      ['a missing name', { ...lead, name: undefined }],
      ['a blank name', { ...lead, name: '   ' }],
      ['a missing email', { ...lead, email: undefined }],
      ['an invalid email', { ...lead, email: 'dana@' }],
      ['a name that is not text', { ...lead, name: 12 }],
      ['a message that is an object', { ...lead, message: { a: 1 } }],
      ['a missing page', { ...lead, page: undefined }],
      ['a page that is not a path', { ...lead, page: 'https://evil.example/x' }],
      ['a name over its cap', { ...lead, name: 'n'.repeat(limits.contact.nameMaxChars + 1) }],
      ['an email over its cap', { ...lead, email: `${'a'.repeat(limits.contact.emailMaxChars)}@example.com` }],
      ['a company over its cap', { ...lead, company: 'c'.repeat(limits.contact.companyMaxChars + 1) }],
      ['a message over its cap', { ...lead, message: 'm'.repeat(limits.contact.leadMessageMaxChars + 1) }],
    ])('refuses %s with invalidRequest and stores nothing', async (_what, body) => {
      const h = await setup();
      const res = await h.post('/api/leads', body, { user: null });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalidRequest' });
      expect(await h.handle.leads()).toEqual([]);
    });

    it('accepts a message exactly at its cap', async () => {
      const h = await setup();
      const res = await h.post('/api/leads', { ...lead, message: 'א'.repeat(limits.contact.leadMessageMaxChars) }, { user: null });
      expect(res.statusCode).toBe(200);
      expect((await h.handle.leads())[0]!.message).toHaveLength(limits.contact.leadMessageMaxChars);
    });

    it('refuses a body that is not a JSON object', async () => {
      const h = await setup();
      for (const body of [null, [], 'text', 7]) {
        const res = await h.post('/api/leads', body, { user: null });
        expect(res.statusCode).toBe(400);
      }
      expect(await h.handle.leads()).toEqual([]);
    });
  });

  describe('POST /api/waitlist', () => {
    it('stores a waitlist entry in the leads collection, with the user and the trigger', async () => {
      const h = await setup();
      const res = await h.post('/api/waitlist', waitlist, { user: USER });
      expect(res.statusCode).toBe(200);
      const [stored, ...rest] = await h.handle.leads();
      expect(rest).toHaveLength(0);
      expect(stored).toMatchObject({ createdAt: NOW, kind: 'waitlist', email: 'dana@example.com', message: 'More formats, please.', trigger: 'savedFormats', page: '/formats' });
      expect(String(stored!.userId)).toBe(USER);
      expect(stored).not.toHaveProperty('name');
      expect(await h.handle.feedback()).toEqual([]);
    });

    it('defaults the trigger to "other", needs no message, and has no user for a visitor', async () => {
      const h = await setup();
      expect((await h.post('/api/waitlist', { email: 'a@b.co', page: '/' }, { user: null })).statusCode).toBe(200);
      const [stored] = await h.handle.leads();
      expect(stored).toMatchObject({ kind: 'waitlist', trigger: 'other', email: 'a@b.co' });
      expect(stored).not.toHaveProperty('userId');
      expect(stored).not.toHaveProperty('message');
    });

    it.each([
      ['no email', { ...waitlist, email: undefined }],
      ['a bad email', { ...waitlist, email: 'nope' }],
      ['an unknown trigger', { ...waitlist, trigger: 'something else' }],
      ['a message over its cap', { ...waitlist, message: 'm'.repeat(limits.contact.waitlistMessageMaxChars + 1) }],
    ])('refuses %s', async (_what, body) => {
      const h = await setup();
      expect((await h.post('/api/waitlist', body, { user: USER })).statusCode).toBe(400);
      expect(await h.handle.leads()).toEqual([]);
    });
  });

  describe('POST /api/feedback', () => {
    it('stores { createdAt, kind, message, page } for a visitor, in the feedback collection only', async () => {
      const h = await setup();
      expect((await h.post('/api/feedback', feedback, { user: null })).statusCode).toBe(200);
      expect(await h.handle.feedback()).toEqual([{ createdAt: NOW, kind: 'feedback', message: 'The preview is great.', page: '/result' }]);
      expect(await h.handle.leads()).toEqual([]);
    });

    it('adds the email when given and the user when signed in', async () => {
      const h = await setup();
      expect((await h.post('/api/feedback', { ...feedback, email: 'Me@Example.com' }, { user: USER })).statusCode).toBe(200);
      const [stored] = await h.handle.feedback();
      expect(stored).toMatchObject({ kind: 'feedback', email: 'me@example.com' });
      expect(String(stored!.userId)).toBe(USER);
    });

    it('keeps no file data, rules or rows even when the body carries them', async () => {
      const h = await setup();
      const res = await h.post('/api/feedback', { ...feedback, rules: { columns: [] }, rows: [['secret']], fileName: 'payroll.xlsx', payload: { samples: [] }, anonId: 'x' }, { user: null });
      expect(res.statusCode).toBe(200);
      const [stored] = await h.handle.feedback();
      expect(Object.keys(stored!).sort()).toEqual(['createdAt', 'kind', 'message', 'page']);
      expect(await h.handle.everything()).not.toMatch(/payroll|secret/);
    });

    it.each([
      ['no message', { ...feedback, message: undefined }],
      ['a blank message', { ...feedback, message: ' \n ' }],
      ['a message over its cap', { ...feedback, message: 'm'.repeat(limits.contact.feedbackMessageMaxChars + 1) }],
      ['a bad email', { ...feedback, email: 'x' }],
      ['a page with a space', { ...feedback, page: '/a b' }],
      ['a page over its cap', { ...feedback, page: `/${'p'.repeat(limits.contact.pageMaxChars)}` }],
    ])('refuses %s', async (_what, body) => {
      const h = await setup();
      expect((await h.post('/api/feedback', body, { user: null })).statusCode).toBe(400);
      expect(await h.handle.feedback()).toEqual([]);
    });
  });

  describe('Turnstile', () => {
    it.each([
      ['/api/leads', lead],
      ['/api/waitlist', waitlist],
      ['/api/feedback', feedback],
    ])('%s: a visitor without a token is refused (turnstileFailed) and nothing is stored', async (url, body) => {
      const h = await setup({ turnstile: true });
      const res = await h.post(url, body, { user: null });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'turnstileFailed' });
      expect(await h.handle.leads()).toEqual([]);
      expect(await h.handle.feedback()).toEqual([]);
    });

    it('refuses a token Cloudflare rejects, and accepts one it accepts, passing the visitor IP', async () => {
      const h = await setup({ turnstile: true });
      const ip = nextIp();
      expect((await h.post('/api/leads', { ...lead, turnstileToken: 'bad' }, { user: null, ip })).statusCode).toBe(403);
      expect((await h.post('/api/leads', { ...lead, turnstileToken: 'good' }, { user: null, ip })).statusCode).toBe(200);
      expect((await h.handle.leads()).length).toBe(1);
      const calls = h.turnstileCalls;
      expect(calls.map((c) => c.body.get('response'))).toEqual(['bad', 'good']);
      expect(calls[1]!.body.get('remoteip')).toBe(ip);
      // The token is never stored.
      expect(await h.handle.everything()).not.toContain('good');
    });

    it('does not ask a signed-in user for a token (the rate limits still apply to them)', async () => {
      const h = await setup({ turnstile: true });
      expect((await h.post('/api/feedback', feedback, { user: USER })).statusCode).toBe(200);
      expect((await h.post('/api/waitlist', waitlist, { user: USER })).statusCode).toBe(200);
      expect(h.turnstileCalls).toHaveLength(0);
    });

    it('checks the body before it calls Cloudflare: a malformed request costs no verification', async () => {
      const h = await setup({ turnstile: true });
      expect((await h.post('/api/leads', { ...lead, email: 'nope', turnstileToken: 'good' }, { user: null })).statusCode).toBe(400);
      expect(h.turnstileCalls).toHaveLength(0);
    });

    it('is skipped when no secret is configured (development)', async () => {
      const h = await setup();
      expect((await h.post('/api/leads', lead, { user: null })).statusCode).toBe(200);
    });
  });

  describe('rate limits', () => {
    it('answers 429 rateLimited (with Retry-After) past the per-IP allowance in a window, for everyone', async () => {
      const h = await setup();
      const ip = nextIp();
      for (let i = 0; i < limits.contact.perIpPerWindow; i += 1) {
        expect((await h.post('/api/feedback', feedback, { user: i % 2 === 0 ? USER : null, ip })).statusCode).toBe(200);
      }
      const over = await h.post('/api/feedback', feedback, { user: USER, ip });
      expect(over.statusCode).toBe(429);
      expect(over.json()).toEqual({ error: 'rateLimited' });
      expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // The three forms share the allowance; a different IP is unaffected.
      expect((await h.post('/api/leads', lead, { user: null, ip })).statusCode).toBe(429);
      expect((await h.post('/api/leads', lead, { user: null, ip: nextIp() })).statusCode).toBe(200);
      expect(await h.handle.feedback()).toHaveLength(limits.contact.perIpPerWindow);
    });

    it('lets the same IP send again once the window has passed', async () => {
      const h = await setup();
      const ip = nextIp();
      for (let i = 0; i < limits.contact.perIpPerWindow; i += 1) await h.post('/api/feedback', feedback, { user: null, ip });
      expect((await h.post('/api/feedback', feedback, { user: null, ip })).statusCode).toBe(429);
      h.clock.current = new Date(h.clock.current.getTime() + limits.protection.rateLimitWindowMs + 1);
      expect((await h.post('/api/feedback', feedback, { user: null, ip })).statusCode).toBe(200);
    });

    it('a flood is refused before Cloudflare is asked', async () => {
      const h = await setup({ turnstile: true });
      const ip = nextIp();
      for (let i = 0; i < limits.contact.perIpPerWindow + 3; i += 1) await h.post('/api/feedback', { ...feedback, turnstileToken: 'good' }, { user: null, ip });
      expect(h.turnstileCalls).toHaveLength(limits.contact.perIpPerWindow);
    });

    it('caps the stored forms of one IP per UTC day (a keyed hash of it), and starts again the next day', async () => {
      const h = await setup();
      const ip = nextIp();
      let stored = 0;
      for (let i = 0; i < limits.contact.perIpPerDay; i += 1) {
        // (a new window every few requests keeps the per-window limit out of the way)
        if (i % limits.contact.perIpPerWindow === 0) h.clock.current = new Date(h.clock.current.getTime() + limits.protection.rateLimitWindowMs + 1);
        const res = await h.post('/api/feedback', feedback, { user: null, ip });
        expect(res.statusCode).toBe(200);
        stored += 1;
      }
      expect(stored).toBe(limits.contact.perIpPerDay);
      h.clock.current = new Date(h.clock.current.getTime() + limits.protection.rateLimitWindowMs + 1);
      const over = await h.post('/api/feedback', feedback, { user: null, ip });
      expect(over.statusCode).toBe(429);
      expect(over.json()).toEqual({ error: 'rateLimited' });
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(60);
      expect(await h.handle.feedback()).toHaveLength(limits.contact.perIpPerDay);
      expect(await h.handle.everything()).not.toContain(ip);

      // Next UTC day: the counter is a different one.
      h.clock.current = new Date('2026-10-06T00:30:00.000Z');
      expect((await h.post('/api/feedback', feedback, { user: null, ip })).statusCode).toBe(200);
    });

    it('a refused (malformed) request does not use up the daily allowance', async () => {
      const h = await setup();
      const ip = nextIp();
      await h.post('/api/feedback', { ...feedback, message: '' }, { user: null, ip });
      expect(await h.handle.counter(contactDayKey(hashIp(ip, SECRET), dayKey(NOW)))).toBe(0);
    });
  });
}

describe('public forms (in-memory)', () => {
  defineSuite(memoryKit);
});

describe.skipIf(!mongoUri)('public forms (MongoDB)', () => {
  defineSuite(mongoKit());
});

describe.skipIf(!mongoUri)('MongoDB indexes for the public forms (SPEC 13)', () => {
  it('creates the leads (createdAt, kind) and feedback (createdAt) indexes', async () => {
    const dbName = `formatai_test_${randomUUID().slice(0, 8)}`;
    const db = await connectDb(loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: dbName }));
    try {
      await ensureIndexes(db!);
      const leadIndexes = (await db!.leads.indexes()).map((i) => i.name);
      expect(leadIndexes).toEqual(expect.arrayContaining(['leads_createdAt', 'leads_kind_createdAt']));
      expect((await db!.feedback.indexes()).map((i) => i.name)).toContain('feedback_createdAt');
    } finally {
      await dropTestDb(db);
    }
  });
});
