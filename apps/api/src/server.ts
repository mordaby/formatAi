import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { limits } from '@formatai/shared';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AppDb } from './db.js';
import type { Env } from './env.js';
import type { CompleteFn } from './learn/index.js';
import { registerAnonId } from './protection/identity.js';
import { createProtection, parseTrustProxy } from './protection/index.js';
import type { ProtectionStore } from './protection/store.js';
import { registerLearnRoutes } from './routes/learn.js';
import { registerSessionRoute } from './routes/session.js';

export interface BuildServerOptions {
  env: Env;
  db: AppDb | null;
  /** Set false in tests to keep output quiet. Defaults to true. */
  logger?: boolean;
  /** Dependency injection for tests - see `routes/learn.ts`'s `RegisterLearnRoutesOptions.complete`. */
  complete?: CompleteFn;
  /** Tests: replaces the store behind limits, budgets, cache and ledger (default: MongoDB from `db`,
   * or in memory when there is no database outside production). */
  store?: ProtectionStore;
  /** Tests: replaces the global `fetch` used to call Cloudflare Turnstile's siteverify endpoint. */
  fetch?: typeof fetch;
  /** Tests: the clock (UTC day/month keys, budgets, cache and learnId expiry). */
  now?: () => Date;
}

/**
 * Builds (but does not start listening) the Fastify app.
 * SPEC 15: JSON bodies only, capped at `limits.api.maxBodyBytes` (256 KB) - there is
 * no file-upload endpoint, which is what makes "your files never leave your computer" true.
 *
 * In production this throws (so the process refuses to start) unless the protections that stand in
 * front of the LLM can work: TURNSTILE_SECRET_KEY, IP_HASH_SECRET (or SESSION_SECRET) and a database.
 */
export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const { env, db, logger = true, complete } = opts;
  const production = env.NODE_ENV === 'production';

  const app = Fastify({
    bodyLimit: limits.api.maxBodyBytes,
    // Per-IP limits key on `req.ip`; behind a proxy that is only right if TRUST_PROXY says how many hops to trust.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logger: logger
      ? {
          level: production ? 'info' : 'debug',
          // Never log request bodies (SPEC 15) - an explicit serializer guards against a
          // future custom log call that might otherwise include one.
          serializers: {
            req(req) {
              return { method: req.method, url: req.url, hostname: req.hostname };
            },
          },
        }
      : false,
  });

  const protection = createProtection({
    env,
    db,
    store: opts.store,
    fetchFn: opts.fetch,
    now: opts.now,
    warn: (message) => app.log.warn(message),
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    // The web app reads Retry-After from a `rateLimited` response (a cross-origin script can't otherwise).
    exposedHeaders: ['retry-after'],
  });

  await app.register(cookie);
  // Every /api request except the health check gets a first-party anonId cookie (SPEC 12).
  registerAnonId(app, { secure: production });

  // Only application/json is accepted. Fastify's built-in text/plain parser would otherwise
  // accept arbitrary bodies; removing it leaves application/json as the sole registered parser,
  // so any other content type (multipart/form-data included) gets Fastify's own 415 response.
  app.removeContentTypeParser('text/plain');

  // Client errors (413, 415, malformed JSON) keep Fastify's response; a server error never leaks its message.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      req.log.error({ errName: err.name }, 'request failed');
      return reply.code(500).send({ error: 'internal' });
    }
    return reply.send(err);
  });

  app.get('/api/health', async () => {
    if (!db) {
      return { ok: true, db: 'not configured' as const };
    }
    try {
      await db.db.command({ ping: 1 });
      return { ok: true, db: 'connected' as const };
    } catch (err) {
      app.log.error({ err }, 'MongoDB health check failed');
      return { ok: true, db: 'error' as const };
    }
  });

  registerSessionRoute(app, { env });

  // SPEC 5 A steps 5-6 / 9 and 9.5: the learn endpoints make real LLM calls, so they exist in every
  // environment but only behind Turnstile, per-tier learn limits, budgets and a per-IP rate limit.
  registerLearnRoutes(app, { env, protection, complete });

  return app;
}
