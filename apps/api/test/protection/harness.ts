// Shared test harness for the API protections: store "kits" (in-memory always, real MongoDB when
// MONGODB_URI is set), a fake LLM, a fake Turnstile fetch, a controllable clock, and an app builder.
import { randomUUID } from 'node:crypto';
import { formulaRulesToWire } from '@formatai/engine';
import { toWire, type LearnPayload, type LearnResult } from '@formatai/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv, type Env } from '../../src/env.js';
import type { CompleteFn } from '../../src/learn/index.js';
import type { CompleteRequest, CompleteResult } from '../../src/llm/index.js';
import type { FunctionRequestDoc, LlmCallDoc } from '../../src/models.js';
import type { Identity } from '../../src/protection/identity.js';
import { createMemoryStore, createMongoStore, type ProtectionStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { basicPayload, correctRules, correctRulesWireJson } from '../learn/fixtures.js';

// ---------- stores ----------

export interface StoreHandle {
  store: ProtectionStore;
  ledger(): Promise<LlmCallDoc[]>;
  /** A usage counter's current value (0 when absent). */
  counter(key: string): Promise<number>;
  cacheEntryCount(): Promise<number>;
  /** Every cached rules entry (the JSON strings), for "never in the cache" assertions. */
  cacheRules(): Promise<string[]>;
  /** The `function_requests` documents, by key (learn-v7). */
  functionRequests(): Promise<FunctionRequestDoc[]>;
}

export interface StoreKit {
  name: string;
  /** Vitest hooks: called once around the whole suite. */
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  /** A clean store for one test. */
  make(now: () => Date): Promise<StoreHandle>;
}

export const memoryKit: StoreKit = {
  name: 'memory',
  async make(now) {
    const store = createMemoryStore(now);
    return {
      store,
      ledger: async () => store.ledger,
      counter: async (key) => store.counter(key),
      cacheEntryCount: async () => store.cacheEntries.size,
      cacheRules: async () => [...store.cacheEntries.values()].map((d) => d.rules),
      functionRequests: async () => [...store.functionRequests.values()].map((d) => structuredClone(d)),
    };
  },
};

export const mongoUri = process.env.MONGODB_URI;

/** Real MongoDB, in a throwaway database (never the dev one), dropped when the suite ends. */
export function mongoKit(): StoreKit {
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
      if (!appDb) return;
      await appDb.db.dropDatabase();
      await appDb.client.close();
      appDb = null;
    },
    async make() {
      const db = appDb!;
      await Promise.all([
        db.usageCounters.deleteMany({}),
        db.budgets.deleteMany({}),
        db.learnCache.deleteMany({}),
        db.llmCalls.deleteMany({}),
        db.functionRequests.deleteMany({}),
      ]);
      const store = createMongoStore(db);
      return {
        store,
        ledger: () => db.llmCalls.find({}, { projection: { _id: 0 } }).toArray() as Promise<LlmCallDoc[]>,
        counter: async (key) => (await db.usageCounters.findOne({ key }))?.count ?? 0,
        cacheEntryCount: () => db.learnCache.countDocuments(),
        cacheRules: async () => (await db.learnCache.find({}).toArray()).map((d) => d.rules),
        functionRequests: () => db.functionRequests.find({}, { projection: { _id: 0 } }).toArray() as Promise<FunctionRequestDoc[]>,
      };
    },
  };
}

/** Registers a kit's setup/teardown with the surrounding describe. */
export function useKit(kit: StoreKit): void {
  beforeAll(async () => {
    await kit.setup?.();
  });
  afterAll(async () => {
    await kit.teardown?.();
  });
}

// ---------- env, LLM, Turnstile ----------

/** An Env that never depends on the developer's repo-root .env (secrets, DB, provider all explicit). */
export function makeEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv({
    ...process.env,
    NODE_ENV: 'development',
    MONGODB_URI: '',
    LLM_PROVIDER: 'fake',
    TURNSTILE_SECRET_KEY: undefined,
    TURNSTILE_SITE_KEY: undefined,
    VITE_TURNSTILE_SITE_KEY: undefined,
    IP_HASH_SECRET: undefined,
    SESSION_SECRET: undefined,
    TRUST_PROXY: undefined,
    ...overrides,
  });
}

/** A fake `complete()`: answers every call with the given rules JSON (default: correct rules). */
export function makeComplete(opts: { json?: unknown; costUsd?: number } = {}): {
  fn: CompleteFn;
  calls: CompleteRequest[];
} {
  const calls: CompleteRequest[] = [];
  const fn: CompleteFn = async (req): Promise<CompleteResult> => {
    calls.push(req);
    return {
      json: opts.json ?? correctRulesWireJson(),
      raw: '',
      usage: { tokensIn: 100, tokensOut: 50, tokensCachedRead: 0, tokensCachedWrite: 0 },
      costUsd: opts.costUsd ?? 0,
      latencyMs: 1,
      model: req.model,
      provider: 'fake',
    };
  };
  return { fn, calls };
}

export interface TurnstileCall {
  url: string;
  body: URLSearchParams;
}

/** A fake Cloudflare siteverify: `success` for tokens in `validTokens`. */
export function makeTurnstileFetch(validTokens: readonly string[] = ['good']): { fn: typeof fetch; calls: TurnstileCall[] } {
  const calls: TurnstileCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push({ url: String(url), body });
    const success = validTokens.includes(body.get('response') ?? '');
    return new Response(JSON.stringify({ success }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

/** `correctRules()` plus an `oneOf` validation: a text constant that leaves every output cell alone,
 * so the result still verifies against the samples (used for the masking-vs-cache rule). */
export function rulesWithTextConstantWireJson(): unknown {
  const rules: LearnResult = {
    ...correctRules(),
    validations: [{ column: 'id', rule: 'oneOf', values: ['A1', 'A2'], severity: 'flag' }],
  };
  return toWire(formulaRulesToWire(rules) as unknown as LearnResult);
}

// ---------- the harness ----------

export interface HarnessOptions {
  env?: Record<string, string | undefined>;
  complete?: CompleteFn;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  cookie?: string;
  ip?: string;
  /**
   * Who is calling (the tests stub the identity, see `stubIdentify`): a user id (24 hex characters, see
   * `testUserId`), or `null` for an anonymous visitor. `learn()` and the other POSTs default to
   * `TEST_USER`; `get()` defaults to anonymous unless given.
   */
  user?: string | null;
  tier?: 'registered' | 'paid';
}

/** A valid MongoDB id (24 hex characters) for test user number `n`. */
export const testUserId = (n: number): string => n.toString(16).padStart(24, '0');
/** The signed-in test user `learn()` calls as unless told otherwise. */
export const TEST_USER = testUserId(1);

const USER_HEADER = 'x-test-user';
const TIER_HEADER = 'x-test-tier';

/** Stands in for the session lookup: the identity comes from two test-only request headers. */
export function stubIdentify(req: FastifyRequest): Identity {
  const user = req.headers[USER_HEADER];
  if (typeof user !== 'string') return { kind: 'anon', anonId: req.anonId };
  const tier = req.headers[TIER_HEADER] === 'paid' ? 'paid' : 'registered';
  return { kind: 'user', userId: user, tier, anonId: req.anonId, isAdmin: false };
}

export interface Harness {
  app: FastifyInstance;
  handle: StoreHandle;
  clock: { current: Date };
  post(url: string, body: unknown, opts?: RequestOptions): Promise<LightMyRequestResponse>;
  get(url: string, opts?: RequestOptions): Promise<LightMyRequestResponse>;
  /** POST /api/learn with a valid payload as the signed-in `TEST_USER` unless overridden. */
  learn(body?: Record<string, unknown>, opts?: RequestOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

let ipCounter = 0;
/** A fresh documentation-range IP per call, so tests never trip each other's per-IP limits. */
export function nextIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export function anonCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === 'anonId');
  if (!c) throw new Error('response set no anonId cookie');
  return `anonId=${c.value}`;
}

export async function createHarness(kit: StoreKit, opts: HarnessOptions = {}): Promise<Harness> {
  const clock = { current: new Date() };
  const now = (): Date => new Date(clock.current);
  const handle = await kit.make(now);
  const env = makeEnv(opts.env);
  const app = await buildServer({
    env,
    db: null,
    logger: false,
    complete: opts.complete,
    store: handle.store,
    fetch: opts.fetch,
    now,
    identify: stubIdentify,
  });

  const inject = (method: 'GET' | 'POST', url: string, body: unknown, o: RequestOptions) => {
    const user = o.user === undefined ? (method === 'POST' ? TEST_USER : null) : o.user;
    return app.inject({
      method,
      url,
      remoteAddress: o.ip ?? nextIp(),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(user ? { [USER_HEADER]: user, [TIER_HEADER]: o.tier ?? 'registered' } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  return {
    app,
    handle,
    clock,
    post: (url, body, o = {}) => inject('POST', url, body, o),
    get: (url, o = {}) => inject('GET', url, undefined, o),
    learn: (body = {}, o = {}) =>
      inject('POST', '/api/learn', { payload: basicPayload(), ...body }, o),
    close: () => app.close(),
  };
}

export type { LearnPayload };
