// Wires the API protections together (SPEC 9.5, 11, 12, 15) and enforces the production startup
// requirements: without Turnstile, a hashing secret and a database, the LLM endpoints could not be
// protected - so `buildServer` refuses to start rather than run them unprotected.
import { limits } from '@formatai/shared';
import type { AppDb } from '../db.js';
import type { Env } from '../env.js';
import { createRateLimiter, type RateLimiter } from './rateLimit.js';
import { createMemoryStore, createMongoStore, type ProtectionStore } from './store.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.js';

/** Used only outside production, when no IP_HASH_SECRET / SESSION_SECRET is configured. */
const DEV_SECRET = 'formatai-development-secret-not-for-production';

export interface Protection {
  store: ProtectionStore;
  turnstile: TurnstileVerifier;
  /** Per-IP request limiter for POST /api/learn and /api/learn/repair. */
  rateLimiter: RateLimiter;
  /** Keys the IP hash and the learnId signatures. */
  secret: string;
  now: () => Date;
}

export interface CreateProtectionOptions {
  env: Env;
  db: AppDb | null;
  /** Tests: replaces the Mongo / in-memory store. */
  store?: ProtectionStore;
  /** Tests: replaces the global `fetch` used for Turnstile's siteverify. */
  fetchFn?: typeof fetch;
  /** Tests: the clock. */
  now?: () => Date;
  warn?: (message: string) => void;
}

export function createProtection(opts: CreateProtectionOptions): Protection {
  const { env, db } = opts;
  const production = env.NODE_ENV === 'production';
  const now = opts.now ?? (() => new Date());

  const secret = env.IP_HASH_SECRET ?? env.SESSION_SECRET;
  if (!secret && production) {
    throw new Error('IP_HASH_SECRET (or SESSION_SECRET) is required when NODE_ENV=production');
  }

  let store = opts.store;
  if (!store) {
    if (db) {
      store = createMongoStore(db);
    } else if (production) {
      throw new Error('MONGODB_URI is required when NODE_ENV=production (usage limits and budgets are stored there)');
    } else {
      opts.warn?.('MongoDB not configured: learn limits, budgets and the cache are kept in memory (development only)');
      store = createMemoryStore(now);
    }
  }

  return {
    store,
    turnstile: createTurnstileVerifier({
      secret: env.TURNSTILE_SECRET_KEY,
      production,
      fetchFn: opts.fetchFn,
      warn: opts.warn,
    }),
    rateLimiter: createRateLimiter({
      max: limits.protection.learnRequestsPerIpPerMinute,
      windowMs: limits.protection.rateLimitWindowMs,
      now: () => now().getTime(),
    }),
    secret: secret ?? DEV_SECRET,
    now,
  };
}

/** `TRUST_PROXY` -> Fastify's `trustProxy`: an integer = that many proxy hops, "true" = trust the
 * whole chain, unset/"false"/"0" = none (req.ip is the socket address). Behind a proxy or load
 * balancer this MUST be set, or every visitor shares the proxy's IP (and its per-IP limits). */
export function parseTrustProxy(raw: string | undefined): boolean | ((address: string, hop: number) => boolean) {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid TRUST_PROXY env var: expected "true", "false" or a non-negative integer, got "${raw}"`);
  }
  // Fastify's typings take no bare number; this is what proxy-addr itself compiles an integer to.
  return n === 0 ? false : (_address, hop) => hop < n;
}
