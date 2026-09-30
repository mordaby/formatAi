// Who is calling (SPEC 12). Anonymous visitors are identified by a random first-party `anonId`
// cookie; signed-in users (M3) will add the `user` variant - the limit, budget and cache code
// below already works on this type, so M3 only has to resolve a session into it.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { limits } from '@formatai/shared';

export type Identity =
  | { kind: 'anon'; anonId: string }
  | {
      kind: 'user';
      userId: string;
      tier: 'registered' | 'paid';
      /** `users.limitOverrides` for the monthly learn count (SPEC 13), when an admin set one. */
      learnLimitOverride?: number;
    };

/** The cache/ownership scope: `anon:<id>` now, `user:<id>` in M3. */
export function ownerOf(identity: Identity): string {
  return identity.kind === 'anon' ? `anon:${identity.anonId}` : `user:${identity.userId}`;
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

/** The caller's identity. M3: resolve a signed-in session here first, falling back to the anonId. */
export function identityOf(req: FastifyRequest): Identity {
  return { kind: 'anon', anonId: req.anonId };
}
