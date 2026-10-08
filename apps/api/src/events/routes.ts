// POST /api/events (SPEC 14.1; owner decision 2026-10-08): the usage events only the browser knows (a page viewed, a file turned away, how a
// learn ended, which formats were ticked, a download). The ones the API itself can see - a save, a run, a limit, a form - are written where
// they happen (`recorder.ts`), never taken from here: this route refuses those types.
//
//   per-IP rate limit (in memory, before the body is read) -> a cross-site Origin is refused -> the body is size-capped by the route ->
//   each event is checked against its type's strict schema (shared `EVENT_PROPS`) and an invalid one is DROPPED, not the batch ->
//   what is left is stored with the server's time, for the signed-in user or - for a visitor - for nobody (no id at all).
//
// No Turnstile: nothing here is worth a visitor's challenge, and the caps (events per request, bytes, requests per minute per IP) bound what
// one address can write. The answer is always 204: the sender learns nothing about which of its events were kept.
import { limits, parseClientEvents } from '@formatai/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from '../env.js';
import { fail } from '../http.js';
import { createRateLimiter, limitByIp } from '../protection/rateLimit.js';
import type { Protection } from '../protection/index.js';
import type { EventRecorder } from './recorder.js';

export interface RegisterEventRoutesOptions {
  env: Env;
  protection: Protection;
  recorder: EventRecorder;
}

export function registerEventRoutes(app: FastifyInstance, opts: RegisterEventRoutesOptions): void {
  const { env, protection, recorder } = opts;
  const limiter = createRateLimiter({
    max: limits.events.perIpPerWindow,
    windowMs: limits.protection.rateLimitWindowMs,
    now: () => protection.now().getTime(),
  });
  // Defence in depth on top of SameSite=Lax and JSON-only bodies, as the other state-changing routes have it: a browser that names an
  // Origin must name ours.
  const allowedOrigins = new Set([new URL(env.WEB_ORIGIN).origin, new URL(env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).origin]);

  app.post(
    '/api/events',
    {
      // (the route's own cap: a batch of `maxPerRequest` small events is a couple of KB)
      bodyLimit: limits.events.maxBodyBytes,
      onRequest: async (req: FastifyRequest, reply) => {
        const limited = await limitByIp(limiter, req, reply);
        if (limited) return limited;
        if (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) return fail(reply, 403, { error: 'forbidden' });
        return undefined;
      },
    },
    async (req, reply) => {
      void reply.header('cache-control', 'no-store');
      // (more than `maxPerRequest` events: the first ones are looked at, the rest dropped; a body that is no list of events has none)
      const { events } = parseClientEvents(req.body);
      await recorder.recordChecked(req, events);
      return reply.code(204).send();
    },
  );
}
