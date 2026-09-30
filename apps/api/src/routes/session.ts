// GET /api/session (SPEC 12): what the web app needs at startup - no user data. Touching any /api
// route gives the visitor their anonId cookie (see protection/identity.ts); this one exists so the
// web app can also learn its limits and the Turnstile site key without a build-time copy of them.
import type { FastifyInstance } from 'fastify';
import { tiers, type SessionResponse } from '@formatai/shared';
import type { Env } from '../env.js';

export function registerSessionRoute(app: FastifyInstance, opts: { env: Env }): void {
  const turnstileSiteKey = opts.env.TURNSTILE_SITE_KEY ?? opts.env.VITE_TURNSTILE_SITE_KEY;

  app.get('/api/session', async (req, reply) => {
    // The response depends on (and may set) a cookie: never let a shared cache store it.
    void reply.header('cache-control', 'no-store');
    const body: SessionResponse = {
      anonId: req.anonId !== '',
      // Not signed in = the free tier, which the config calls `anonymous` (SPEC 11).
      tier: 'free',
      limits: tiers.anonymous,
      ...(turnstileSiteKey ? { turnstileSiteKey } : {}),
    };
    return body;
  });
}
