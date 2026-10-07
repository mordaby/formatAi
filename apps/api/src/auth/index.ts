// Sign-in (SPEC 12): providers, sessions, users, and the routes - composed once in `buildServer`.
// Other code only needs `identityOf(req)` from `protection/identity.ts`; this module fills what it reads.
import type { FastifyInstance } from 'fastify';
import type { AppDb } from '../db.js';
import type { Env } from '../env.js';
import type { LearnCacheDoc } from '../models.js';
import { loadAdminConfig } from './admin.js';
import { registerDevSessionRoute } from './dev.js';
import { createOpenIdClient, type OidcClient } from './oidc.js';
import { loadProviders, type ProviderConfig } from './providers.js';
import { registerAuthRoutes } from './routes.js';
import { createSessionManager } from './session.js';
import { createMemoryAuthStore, createMongoAuthStore, type AuthStore } from './store.js';

export { isAdmin, loadAdminConfig, type AdminConfig } from './admin.js';
export { createOpenIdClient, type OidcClient } from './oidc.js';
export { loadProviders, PROVIDER_TABLE, type ProviderConfig } from './providers.js';
export { safeReturnTo } from './returnTo.js';
export { createMemoryAuthStore, createMongoAuthStore, type AuthStore } from './store.js';

/** Used only outside production, when no SESSION_SECRET is configured. */
const DEV_SECRET = 'formatai-development-session-secret-not-for-production';

export interface AuthOptions {
  /** Tests: replaces the providers built from the environment (e.g. pointing at a fake local issuer). */
  providers?: ProviderConfig[];
  /** Tests: replaces the openid-client based implementation. */
  oidc?: OidcClient;
  /** Tests: replaces the Mongo / in-memory store. */
  store?: AuthStore;
}

export interface RegisterAuthOptions extends AuthOptions {
  env: Env;
  db: AppDb | null;
  now?: () => Date;
  /** The protection store's in-memory cache (no database): sign-in re-owns its `anon:` entries like `learn_cache`. */
  learnCache?: Map<string, LearnCacheDoc>;
  warn?: (message: string) => void;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A URL on this machine: a loopback name, or a `*.localhost` one. */
function isLocalUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Whether `POST /api/dev/session` may exist in this (non-production) process: the web app and the API both on this machine (`WEB_ORIGIN`, the
 * API's public URL - the development defaults), or the developer's explicit `DEV_SIGN_IN=true` (a phone on the LAN, a tunnel).
 */
export function devSignInAllowed(env: Pick<Env, 'WEB_ORIGIN' | 'DEV_SIGN_IN'>, apiBase: string): boolean {
  if (/^(true|1|yes)$/i.test((env.DEV_SIGN_IN ?? '').trim())) return true;
  return isLocalUrl(env.WEB_ORIGIN) && isLocalUrl(apiBase);
}

/**
 * Registers the session hook (which makes `identityOf` see signed-in users) and the auth routes.
 * Call after `@fastify/cookie` and `registerAnonId`. In production this throws (so the process refuses to
 * start) without SESSION_SECRET or - when a provider is configured - API_PUBLIC_URL (and, through
 * `createProtection`, without a database).
 */
export function registerAuth(app: FastifyInstance, opts: RegisterAuthOptions): void {
  const { env, db } = opts;
  const production = env.NODE_ENV === 'production';
  const now = opts.now ?? (() => new Date());

  if (production && !env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required when NODE_ENV=production');
  }
  if (!env.SESSION_SECRET) {
    opts.warn?.('SESSION_SECRET is not set: sessions are signed with a development secret (development only)');
  }
  const secret = env.SESSION_SECRET ?? DEV_SECRET;

  const providers = opts.providers ?? loadProviders(env);
  if (production && providers.length > 0 && !env.API_PUBLIC_URL) {
    throw new Error('API_PUBLIC_URL is required when NODE_ENV=production and a sign-in provider is configured');
  }
  let apiBase: string;
  try {
    apiBase = new URL(env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).href.replace(/\/+$/, '');
  } catch {
    throw new Error('Invalid API_PUBLIC_URL env var: expected an absolute URL like https://api.example.com');
  }

  let store = opts.store;
  if (!store) {
    if (db) {
      store = createMongoAuthStore(db);
    } else {
      // Production without a database never gets here: `createProtection` refuses to start first (it is
      // built before this), unless a test injects its own protection store.
      if (!production) opts.warn?.('MongoDB not configured: users and sessions are kept in memory (development only)');
      store = createMemoryAuthStore({ learnCache: opts.learnCache });
    }
  }

  const admin = loadAdminConfig(env);
  const sessions = createSessionManager({ store, secret, secure: production, admin, now });
  sessions.register(app);

  registerAuthRoutes(app, {
    env,
    store,
    oidc: opts.oidc ?? createOpenIdClient(),
    sessions,
    providers,
    admin,
    secret,
    apiBase,
    secure: production,
    now,
  });

  // DEVELOPMENT ONLY: a throw-away signed-in session, so the signed-in screens can be tried without a real provider.
  // The route does not exist in a production process - nor (API audit 2026-10-07) in any process the browser reaches at a public origin,
  // unless the developer asks for it (`DEV_SIGN_IN=true`): a deploy that forgot NODE_ENV=production must not let anyone sign in.
  if (!production && devSignInAllowed(env, apiBase)) {
    registerDevSessionRoute(app, {
      store,
      sessions,
      now,
      allowedOrigins: new Set([new URL(env.WEB_ORIGIN).origin, new URL(apiBase).origin]),
    });
  }
}
