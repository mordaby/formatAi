// Who is calling (SPEC 12). Anonymous visitors are identified by a random first-party `anonId`
// cookie; signed-in users by their session (resolved once per request by `auth/session.ts`, which
// sets `req.authUser`). `identityOf` turns both into the `Identity` the limit, budget and cache code works on.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { limits } from '@formatai/shared';

export type Identity =
  | {
      kind: 'anon';
      anonId: string;
      /** Always false: there is no admin without a sign-in. */
      isAdmin?: false;
    }
  | {
      kind: 'user';
      userId: string;
      tier: 'registered' | 'paid';
      /** This browser's anonId (always set by `identityOf`; its past events were attached to the user at sign-in). */
      anonId?: string;
      /** Verified Google email in ADMIN_EMAILS, or Microsoft oid in MICROSOFT_ADMIN_OIDS (SPEC 12). Always set by `identityOf`. */
      isAdmin?: boolean;
      /** `users.limitOverrides.aiLearns` (SPEC 13): the admin's override of the AI-learn count, when one is set. */
      learnLimitOverride?: number;
    };

/**
 * The cache/ownership scope of a signed-in user: `user:<id>`. The AI step (the only thing that uses it) is for signed-in users only,
 * so there is no anonymous scope.
 */
export function ownerOf(identity: Extract<Identity, { kind: 'user' }>): string {
  return `user:${identity.userId}`;
}

// ---- the anonId cookie ----

export const ANON_COOKIE = 'anonId';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on every /api request except /api/health: the visitor's anonId (cookie value, or a new one). */
    anonId: string;
  }
}

/** anonIds are `randomBytes(16)` in base64url. Anything else in the cookie is discarded and
 * reissued, so a forged value can never inject `:` or other separators into counter keys. */
const ANON_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidAnonId(value: unknown): value is string {
  return typeof value === 'string' && ANON_ID_PATTERN.test(value);
}

export function newAnonId(): string {
  return randomBytes(16).toString('base64url');
}

/** Requests that don't get an anonId (and no Set-Cookie): monitors hitting the health check. */
function needsAnonId(url: string): boolean {
  const path = url.split('?', 1)[0]!;
  return path.startsWith('/api/') && path !== '/api/health';
}

/**
 * Sets a random, first-party, httpOnly, SameSite=Lax anonId cookie on first contact (Secure in
 * production) and exposes it as `req.anonId`. Must be called after `@fastify/cookie` is registered.
 */
export function registerAnonId(app: FastifyInstance, opts: { secure: boolean }): void {
  app.decorateRequest('anonId', '');
  app.addHook('onRequest', async (req, reply) => {
    if (!needsAnonId(req.url)) return;
    const existing = req.cookies[ANON_COOKIE];
    if (isValidAnonId(existing)) {
      req.anonId = existing;
      return;
    }
    const anonId = newAnonId();
    req.anonId = anonId;
    reply.setCookie(ANON_COOKIE, anonId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secure,
      path: '/',
      maxAge: limits.protection.anonCookieMaxAgeDays * 24 * 60 * 60,
    });
  });
}

/** What the session resolves to for one request (`req.authUser`), set by `auth/session.ts`. */
export interface AuthedUser {
  userId: string;
  tier: 'registered' | 'paid';
  isAdmin: boolean;
  limitOverrides?: Record<string, number>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user of this request's session; null when there is none (or no auth is registered). */
    authUser: AuthedUser | null;
  }
}

/**
 * The caller's identity: the signed-in user when the request carries a valid session, else the anonymous
 * visitor. Synchronous - the session was already resolved (one database read) in an onRequest hook.
 */
export function identityOf(req: FastifyRequest): Identity {
  const user = req.authUser ?? null;
  if (!user) return { kind: 'anon', anonId: req.anonId };
  // (API audit P2, 2026-10-07: the legacy `learnsToLlm` key is gone - `limits.admin.overrideKeys` is `aiLearns` only.)
  const learnLimitOverride = user.limitOverrides?.aiLearns;
  return {
    kind: 'user',
    userId: user.userId,
    tier: user.tier,
    anonId: req.anonId,
    isAdmin: user.isAdmin,
    ...(learnLimitOverride !== undefined ? { learnLimitOverride } : {}),
  };
}
