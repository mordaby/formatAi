// DEVELOPMENT ONLY: `POST /api/dev/session` creates a throw-away test user and signs the caller in as them, so the
// signed-in screens can be tried (and screenshotted) without a real Google/Microsoft sign-in, which needs the
// owner's OAuth client. `registerAuth` registers this route only when NODE_ENV is not `production`; in a
// production process the route does not exist (404). Users made here are ordinary documents with a
// `provider: 'google'` identity whose subject is `dev-<random>` and an email under the reserved `.test` TLD, so
// they never collide with (or are mistaken for) a real account.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { UserDoc } from '../models.js';
import { SESSION_COOKIE, type SessionManager } from './session.js';
import type { AuthStore } from './store.js';

export interface DevSessionOptions {
  store: AuthStore;
  sessions: SessionManager;
  now: () => Date;
  /** The origins allowed to call this (the web app's and the API's own), like the other state-changing routes. */
  allowedOrigins: ReadonlySet<string>;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** A developer may open the web app through any loopback name (they keep separate cookies): the same origin under each. */
function withLoopbackAliases(origins: ReadonlySet<string>): Set<string> {
  const all = new Set(origins);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (!LOOPBACK_HOSTS.includes(url.hostname)) continue;
    for (const host of LOOPBACK_HOSTS) all.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`);
  }
  return all;
}

export function registerDevSessionRoute(app: FastifyInstance, o: DevSessionOptions): void {
  const allowedOrigins = withLoopbackAliases(o.allowedOrigins);
  app.post('/api/dev/session', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'forbiddenOrigin' });

    const body = (req.body ?? {}) as { tier?: unknown; name?: unknown };
    const tier = body.tier === 'paid' ? 'paid' : 'registered';
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 60) : 'Dev User';

    const at = o.now();
    const suffix = randomBytes(6).toString('hex');
    const doc: UserDoc = {
      identities: [{ provider: 'google', subject: `dev-${suffix}`, email: `dev-${suffix}@example.test`, emailVerified: true }],
      name,
      tier,
      createdAt: at,
      lastSeenAt: at,
      anonIds: [],
    };
    const user = await o.store.createUser(doc);
    if (!user) return reply.code(500).send({ error: 'internal' });
    await o.sessions.start(reply, user._id, req.cookies[SESSION_COOKIE]);
    return { ok: true, userId: user._id.toHexString(), tier };
  });
}
