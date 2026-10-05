import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { limits } from '@formatai/shared';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerAdminRoutes } from './admin/index.js';
import { registerAuth, type AuthOptions } from './auth/index.js';
import type { AppDb } from './db.js';
import type { Env } from './env.js';
import type { CompleteFn } from './learn/index.js';
import { registerAnonId, type Identity } from './protection/identity.js';
import { createProtection, parseTrustProxy } from './protection/index.js';
import type { MemoryStore, ProtectionStore } from './protection/store.js';
import { registerRegistryRoutes } from './registry/index.js';
import { registerLearnRoutes } from './routes/learn.js';
import { registerSessionRoute } from './routes/session.js';
import { registerWebApp } from './web.js';

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
  /** Tests: who is calling, for the learn and registry routes (default: `identityOf` - the session, else the anonId). */
  identify?: (req: FastifyRequest) => Identity;
  /** Tests: sign-in providers / OIDC client / store overrides (see `auth/index.ts`). */
  auth?: AuthOptions;
  /**
   * The built web app (`apps/web/dist`) to serve from this process - one service, one origin (see `web.ts`). `index.ts` sets
   * it in production, or when `WEB_DIST` is. Unset (development, tests): the API serves /api only; Vite serves the web on 5173.
   */
  webDist?: string;
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
    // A learnId (POST /api/learn/:learnId/outcome) is a signed token of up to 200 characters; Fastify's default is 100.
    routerOptions: { maxParamLength: 200 },
    // Per-IP limits key on `req.ip`; behind a proxy that is only right if TRUST_PROXY says how many hops to trust.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logger: logger
      ? {
          level: production ? 'info' : 'debug',
          // Never log request bodies (SPEC 15) - an explicit serializer guards against a
          // future custom log call that might otherwise include one.
          serializers: {
            req(req) {
              // /api/auth/* URLs carry the provider's one-time authorization `code` and `state`: log the path only.
              const url = req.url?.startsWith('/api/auth/') ? req.url.split('?', 1)[0] : req.url;
              return { method: req.method, url, hostname: req.hostname };
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
    // (@fastify/cors allows only GET, HEAD and POST by default.)
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // The web app reads Retry-After from a `rateLimited` response (a cross-origin script can't otherwise).
    exposedHeaders: ['retry-after'],
  });

  await app.register(cookie);
  // Every /api request except the health check gets a first-party anonId cookie (SPEC 12).
  registerAnonId(app, { secure: production });
  // SPEC 12: resolves the session cookie to the signed-in user (what `identityOf` reads) and adds /api/auth/*, /api/me.
  registerAuth(app, {
    ...opts.auth,
    env,
    db,
    now: opts.now,
    learnCache: 'cacheEntries' in protection.store ? (protection.store as MemoryStore).cacheEntries : undefined,
    warn: (message) => app.log.warn(message),
  });

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

  // SPEC 5 A steps 5-6 / 9, 9.5 and 21 v5: the learn endpoints make real LLM calls, so they exist in every
  // environment but only for signed-in users, behind their AI-learn quota, budgets and a per-IP rate limit.
  registerLearnRoutes(app, { env, protection, complete, identify: opts.identify });

  // SPEC 8.12 / 13: saved formats and their conversions (signed-in users only; needs the database).
  registerRegistryRoutes(app, { db, protection, identify: opts.identify });

  // SPEC 14.2: the admin view's API (/api/admin/*), admins only - checked here on the server, whatever the web app shows.
  registerAdminRoutes(app, { db, env, protection, identify: opts.identify });

  // Last: the static files and the page-route fallback, once every /api route is in place.
  if (opts.webDist) await registerWebApp(app, { dir: opts.webDist, hsts: new URL(env.WEB_ORIGIN).protocol === 'https:' });

  return app;
}
