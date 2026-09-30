// Sessions (SPEC 12): a signed, httpOnly, SameSite=Lax cookie (Secure in production) holding a random session id.
//
// DECISION: stateful sessions (a `sessions` collection with a TTL index), not a stateless signed token. It costs
// one indexed read per request that carries the cookie, and buys what a stateless token can't: logout that really
// ends the session, rotation on sign-in, and a tier / admin change that applies at once (the user is read fresh
// each request). The cookie is `<sessionId>.<HMAC>`; the collection stores only SHA-256(sessionId).
import { limits } from '@formatai/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import type { AuthedUser } from '../protection/identity.js';
import { isAdmin, type AdminConfig } from './admin.js';
import { hashToken, randomToken, signValue, verifyValue } from './signing.js';
import type { AuthStore, StoredUser } from './store.js';

export const SESSION_COOKIE = 'sid';
const SESSION_PURPOSE = 'session';

declare module 'fastify' {
  interface FastifyRequest {
    /** The full user record of this request's session (null when not signed in). Set by the session hook. */
    sessionUser: StoredUser | null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionManagerOptions {
  store: AuthStore;
  secret: string;
  secure: boolean;
  admin: AdminConfig;
  now: () => Date;
}

export interface SessionManager {
  /** Ends `previousCookie`'s session (rotation) and starts a new one for the user; sets the cookie. */
  start(reply: FastifyReply, userId: ObjectId, previousCookie?: string): Promise<void>;
  /** Deletes the request's session (if any) and clears the cookie. */
  end(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** The hook that sets `req.authUser` / `req.sessionUser` from the session cookie. */
  register(app: FastifyInstance): void;
  /** SPEC 12 admin check for a user's identities. */
  isAdmin: (user: StoredUser) => boolean;
}

/** The session id in a session cookie, or null when the cookie is missing or not ours. */
function sessionIdOf(secret: string, cookie: unknown): string | null {
  return verifyValue(secret, SESSION_PURPOSE, cookie);
}

/** Session cookies exist for the API only; the health check never carries or sets one. */
function isSessionPath(url: string): boolean {
  const path = url.split('?', 1)[0]!;
  return path.startsWith('/api/') && path !== '/api/health';
}

export function createSessionManager(opts: SessionManagerOptions): SessionManager {
  const { store, secret, secure, admin, now } = opts;
  const cookieOptions = (): CookieSerializeOptions => ({
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: limits.auth.sessionDays * 24 * 60 * 60,
  });
  const expiry = (from: Date): Date => new Date(from.getTime() + limits.auth.sessionDays * DAY_MS);
  const userIsAdmin = (user: StoredUser): boolean => isAdmin(user.identities, admin);

  const clear = (reply: FastifyReply): void => {
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
  };

  return {
    isAdmin: userIsAdmin,

    async start(reply, userId, previousCookie) {
      const previous = previousCookie === undefined ? null : sessionIdOf(secret, previousCookie);
      if (previous) await store.deleteSession(hashToken(previous));
      const sid = randomToken();
      const at = now();
      await store.createSession(hashToken(sid), { userId, createdAt: at, lastSeenAt: at, expiresAt: expiry(at) });
      void reply.setCookie(SESSION_COOKIE, signValue(secret, SESSION_PURPOSE, sid), cookieOptions());
    },

    async end(req, reply) {
      const sid = sessionIdOf(secret, req.cookies[SESSION_COOKIE]);
      if (sid) await store.deleteSession(hashToken(sid));
      clear(reply);
    },

    register(app) {
      app.decorateRequest('authUser', null);
      app.decorateRequest('sessionUser', null);
      app.addHook('onRequest', async (req, reply) => {
        if (!isSessionPath(req.url)) return;
        const raw = req.cookies[SESSION_COOKIE];
        if (raw === undefined) return;

        const sid = sessionIdOf(secret, raw);
        if (!sid) return clear(reply); // forged or from another deployment
        const idHash = hashToken(sid);
        const at = now();

        const session = await store.getSession(idHash, at);
        if (!session) return clear(reply);
        const user = await store.getUser(session.userId);
        if (!user) {
          await store.deleteSession(idHash);
          return clear(reply);
        }

        // Sliding expiry, written at most once per `sessionRenewMinutes` so a request is not a write.
        if (at.getTime() - session.lastSeenAt.getTime() >= limits.auth.sessionRenewMinutes * 60_000) {
          await store.renewSession(idHash, user._id, at, expiry(at));
          void reply.setCookie(SESSION_COOKIE, raw, cookieOptions());
        }

        const authUser: AuthedUser = {
          userId: user._id.toHexString(),
          tier: user.tier,
          isAdmin: userIsAdmin(user),
          ...(user.limitOverrides ? { limitOverrides: user.limitOverrides } : {}),
        };
        req.sessionUser = user;
        req.authUser = authUser;
      });
    },
  };
}
