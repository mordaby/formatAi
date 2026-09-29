import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { limits } from '@formatai/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppDb } from './db.js';
import type { Env } from './env.js';
import type { CompleteFn } from './learn/index.js';
import { registerLearnRoutes } from './routes/learn.js';

export interface BuildServerOptions {
  env: Env;
  db: AppDb | null;
  /** Set false in tests to keep output quiet. Defaults to true. */
  logger?: boolean;
  /** Dependency injection for tests - see `routes/learn.ts`'s `RegisterLearnRoutesOptions.complete`. */
  complete?: CompleteFn;
}

/**
 * Builds (but does not start listening) the Fastify app.
 * SPEC 15: JSON bodies only, capped at `limits.api.maxBodyBytes` (256 KB) - there is
 * no file-upload endpoint, which is what makes "your files never leave your computer" true.
 */
export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const { env, db, logger = true, complete } = opts;

  const app = Fastify({
    bodyLimit: limits.api.maxBodyBytes,
    logger: logger
      ? {
          level: env.NODE_ENV === 'production' ? 'info' : 'debug',
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

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  await app.register(cookie);

  // Only application/json is accepted. Fastify's built-in text/plain parser would otherwise
  // accept arbitrary bodies; removing it leaves application/json as the sole registered parser,
  // so any other content type (multipart/form-data included) gets Fastify's own 415 response.
  app.removeContentTypeParser('text/plain');

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

  // SPEC 5 A steps 5-6 / 9: the learn endpoints make real LLM calls, which cost real
  // money, with no limits, budgets, Turnstile or cache in front of them yet (those
  // land in M2 - SPEC 9.5). Registering them at all in production would let anyone
  // spend LLM budget with no ceiling, so they only exist outside production for now
  // (dev, tests, the eval harness) - see `routes/learn.ts`'s own file doc comment.
  if (env.NODE_ENV !== 'production') {
    registerLearnRoutes(app, { env, db, complete });
  }

  return app;
}
