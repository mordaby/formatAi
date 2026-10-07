// Test harness for sign-in: kits (in-memory always, real MongoDB when MONGODB_URI is set), a fake local OIDC
// issuer, a controllable clock and a "browser" with a cookie jar that drives the routes like a real one.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll } from 'vitest';
import { createMemoryAuthStore, createMongoAuthStore, type AuthStore } from '../../src/auth/index.js';
import { PROVIDER_TABLE, type ProviderConfig } from '../../src/auth/providers.js';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import type { EventDoc, UserDoc } from '../../src/models.js';
import { identityOf } from '../../src/protection/identity.js';
import { createMemoryStore, createMongoStore, type ProtectionStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv } from '../protection/harness.js';
import { startFakeIssuer, type FakeIssuer } from './fakeIssuer.js';
import { dropTestDb } from '../setup/testDbs.js';

export const mongoUri = process.env.MONGODB_URI;

export const GOOGLE_CLIENT = { clientId: 'google-client-id', clientSecret: 'google-client-secret' };
export const MICROSOFT_CLIENT = { clientId: 'microsoft-client-id', clientSecret: 'microsoft-client-secret' };
export const WEB_ORIGIN = 'http://localhost:5173';
/** The API's public URL in tests (the default: http://localhost:<PORT>). */
export const API_BASE = 'http://localhost:8787';

/** Both providers, pointing at the fake issuer (`/google/...`, `/microsoft/...`), with the real identity mapping. */
export function fakeProviders(issuer: FakeIssuer, which: Array<'google' | 'microsoft'> = ['google', 'microsoft']): ProviderConfig[] {
  return which.map((id) => ({
    ...PROVIDER_TABLE[id],
    id,
    issuer: issuer.issuerUrl(id),
    ...(id === 'google' ? GOOGLE_CLIENT : MICROSOFT_CLIENT),
  }));
}

export function startTestIssuer(): Promise<FakeIssuer> {
  return startFakeIssuer({ google: GOOGLE_CLIENT, microsoft: MICROSOFT_CLIENT });
}

// ---------- kits ----------

export interface AuthHandle {
  db: AppDb | null;
  protectionStore: ProtectionStore;
  authStore: AuthStore;
  users(): Promise<UserDoc[]>;
  events(): Promise<EventDoc[]>;
  sessionCount(): Promise<number>;
  setTier(userId: string, tier: 'registered' | 'paid'): Promise<void>;
  /** Stores rules for a structure hash under an owner (`anon:<id>` / `user:<id>`) - what a learn's cache write does. */
  putCache(owner: string, key: string): Promise<void>;
  hasCache(owner: string, key: string): Promise<boolean>;
}

export interface AuthKit {
  name: string;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  make(now: () => Date): Promise<AuthHandle>;
}

export const memoryKit: AuthKit = {
  name: 'memory',
  async make(now) {
    const protectionStore = createMemoryStore(now);
    const authStore = createMemoryAuthStore();
    return {
      db: null,
      protectionStore,
      authStore,
      users: async () => [...authStore.users.values()],
      events: async () => authStore.events,
      sessionCount: async () => authStore.sessions.size,
      setTier: async (userId, tier) => {
        authStore.users.get(userId)!.tier = tier;
      },
      putCache: (owner, key) => protectionStore.putCachedRules({ owner, key, rules: { r: 1 }, promptVersion: 'test', createdAt: now() }),
      hasCache: async (owner, key) => (await protectionStore.getCachedRules(owner, key, new Date(0))) !== null,
    };
  },
};

/** Real MongoDB, in a throwaway database (never the dev one), dropped when the suite ends. */
export function mongoKit(): AuthKit {
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
    async make(now) {
      const db = appDb!;
      await Promise.all([
        db.users.deleteMany({}),
        db.sessions.deleteMany({}),
        db.events.deleteMany({}),
        db.learnCache.deleteMany({}),
      ]);
      const protectionStore = createMongoStore(db);
      return {
        db,
        protectionStore,
        authStore: createMongoAuthStore(db),
        users: () => db.users.find({}).toArray(),
        events: () => db.events.find({}).toArray(),
        sessionCount: () => db.sessions.countDocuments(),
        setTier: async (userId, tier) => {
          await db.users.updateOne({ _id: new ObjectId(userId) }, { $set: { tier } });
        },
        putCache: (owner, key) => protectionStore.putCachedRules({ owner, key, rules: { r: 1 }, promptVersion: 'test', createdAt: now() }),
        hasCache: async (owner, key) => (await protectionStore.getCachedRules(owner, key, new Date(0))) !== null,
      };
    },
  };
}

export function useKit(kit: AuthKit): void {
  beforeAll(async () => {
    await kit.setup?.();
  });
  afterAll(async () => {
    await kit.teardown?.();
  });
}

// ---------- a browser ----------

export interface Reply {
  status: number;
  /** The redirect target, when the response is a redirect. */
  location?: URL;
  json: () => unknown;
  raw: LightMyRequestResponse;
  /** Every raw Set-Cookie header. */
  setCookies: string[];
}

/** Keeps cookies like a browser (host-only, no expiry handling except deletion) and follows nothing on its own. */
export class Browser {
  readonly jar = new Map<string, string>();
  constructor(private readonly app: FastifyInstance) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  private async send(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const raw = await this.app.inject({
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of raw.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() <= Date.now())) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    const setCookie = raw.headers['set-cookie'];
    const location = raw.headers.location;
    return {
      status: raw.statusCode,
      location: typeof location === 'string' ? new URL(location, 'http://localhost') : undefined,
      json: () => raw.json(),
      raw,
      setCookies: setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [String(setCookie)],
    };
  }

  get = (url: string, headers?: Record<string, string>) => this.send('GET', url, undefined, headers);
  post = (url: string, body?: unknown, headers?: Record<string, string>) => this.send('POST', url, body, headers);
  patch = (url: string, body: unknown, headers?: Record<string, string>) => this.send('PATCH', url, body, headers);
}

// ---------- the app ----------

export interface AuthHarnessOptions {
  env?: Record<string, string | undefined>;
  providers?: Array<'google' | 'microsoft'>;
  /** Also build the server in production mode (needs an injected store: see `productionEnv`). */
  production?: boolean;
}

export interface AuthHarness extends AuthHandle {
  app: FastifyInstance;
  issuer: FakeIssuer;
  clock: { current: Date };
  browser(): Browser;
  /**
   * A whole sign-in in `b`: /start, the person approves at the provider with `claims`, /callback.
   * Returns the callback's reply (a redirect to the web app).
   */
  signIn(b: Browser, provider: 'google' | 'microsoft', claims: Record<string, unknown>, returnTo?: string): Promise<Reply>;
  close(): Promise<void>;
}

export async function createAuthHarness(kit: AuthKit, issuer: FakeIssuer, opts: AuthHarnessOptions = {}): Promise<AuthHarness> {
  const clock = { current: new Date() };
  const now = (): Date => new Date(clock.current);
  const handle = await kit.make(now);
  const env = makeEnv({
    SESSION_SECRET: 'test-session-secret-0123456789',
    WEB_ORIGIN,
    ADMIN_EMAILS: 'Boss@Example.com, other-admin@example.com',
    MICROSOFT_ADMIN_OIDS: 'ms-admin-oid',
    ...(opts.production
      ? { NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 'ts', IP_HASH_SECRET: 'ip-secret', API_PUBLIC_URL: 'https://api.example.test' }
      : {}),
    ...opts.env,
  });
  const app = await buildServer({
    env,
    db: handle.db,
    logger: process.env.AUTH_TEST_LOG === '1', // AUTH_TEST_LOG=1 to see server logs
    store: handle.protectionStore,
    now,
    auth: { providers: fakeProviders(issuer, opts.providers), store: handle.authStore },
  });
  // What other routes see: `identityOf(req)`.
  app.get('/api/__identity', async (req) => identityOf(req));

  const browser = (): Browser => new Browser(app);
  return {
    ...handle,
    app,
    issuer,
    clock,
    browser,
    async signIn(b, provider, claims, returnTo) {
      const start = await b.get(`/api/auth/${provider}/start${returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`}`);
      if (start.status !== 302 || !start.location) throw new Error(`start answered ${start.status}`);
      const back = issuer.approve(start.location.href, claims);
      return b.get(back);
    },
    close: () => app.close(),
  };
}

// ---------- claims ----------

let subjectCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${++subjectCounter}-${randomUUID().slice(0, 8)}`;

export function googleClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const sub = nextId('g');
  return { sub, email: `${sub}@example.com`, email_verified: true, name: 'Gina Google', picture: 'https://example.com/g.png', ...over };
}

export function microsoftClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const oid = nextId('oid');
  // `sub` is per application at Microsoft; the account is tid + oid.
  return { sub: nextId('msub'), oid, tid: 'tenant-1', email: `${oid}@example.com`, name: 'Max Microsoft', ...over };
}
