// POST /api/leads, POST /api/waitlist and POST /api/feedback (SPEC 16.1 screen 7, 11, 13; v13 M4): the public forms.
//
//   per-IP rate limit (in memory: a flood does not even reach Cloudflare or the database)
//   -> the body is checked (shared `checkLead` / `checkWaitlist` / `checkFeedback`: caps, trimmed, whitelisted fields)
//   -> Turnstile, for a visitor (a signed-in user has passed a sign-in; the rate limits still apply to them)
//   -> a durable per-IP daily cap on a KEYED HASH of the IP (`usage_counters`) -> the document is stored.
//
// SPEC 15: nothing here stores or logs an IP, a token, or what the visitor typed. The stored document holds only the whitelisted
// fields, the page path, and who sent it (`anonId`, `userId`). Every refusal is a stable code (`{ error }`, shared `API_ERROR_CODES`):
// `invalidRequest` (never says what was wrong), `turnstileFailed`, `rateLimited`.
import {
  checkFeedback,
  checkLead,
  checkWaitlist,
  limits,
  type ApiErrorBody,
  type ContactCheck,
  type ContactResponse,
} from '@formatai/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FeedbackDoc, LeadDoc } from '../models.js';
import { identityOf, type Identity } from '../protection/identity.js';
import { hashIp, normalizeIp } from '../protection/ip.js';
import { dailyCounterExpiry, dayKey, endOfUtcDay } from '../protection/keys.js';
import { createRateLimiter } from '../protection/rateLimit.js';
import type { Protection } from '../protection/index.js';
import { objectIdOf } from '../registry/ids.js';
import type { ContactStore } from './store.js';

export interface RegisterContactRoutesOptions {
  protection: Protection;
  store: ContactStore;
  /** Tests: who is calling (default: `identityOf`, the session / anonId cookie). */
  identify?: (req: FastifyRequest) => Identity;
}

/** The counter that bounds one IP's stored submissions in a UTC day: a keyed hash, never the address (SPEC 13 `ip:<hash>:<day>`). */
export const contactDayKey = (ipHash: string, day: string): string => `ip:${ipHash}:contact:${day}`;

interface Admitted<T> {
  fields: T;
  identity: Identity;
  at: Date;
}

function fail(reply: FastifyReply, status: number, body: ApiErrorBody): FastifyReply {
  return reply.code(status).send(body);
}

export function registerContactRoutes(app: FastifyInstance, opts: RegisterContactRoutesOptions): void {
  const { protection, store } = opts;
  const identify = opts.identify ?? identityOf;
  const { now, secret } = protection;

  const limiter = createRateLimiter({
    max: limits.contact.perIpPerWindow,
    windowMs: limits.protection.rateLimitWindowMs,
    now: () => now().getTime(),
  });

  /** Per-IP request rate limit: runs before the body is even parsed. */
  const rateLimit = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const verdict = limiter.hit(normalizeIp(req.ip));
    if (verdict.allowed) return undefined;
    void reply.header('retry-after', String(verdict.retryAfterSec));
    return fail(reply, 429, { error: 'rateLimited' });
  };

  /**
   * The checks every form shares: the body, then Turnstile (visitors), then the daily cap. Returns the checked fields and who is
   * calling, or the refusal that was already sent.
   */
  async function admit<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    check: (body: unknown) => ContactCheck<T>,
  ): Promise<Admitted<T> | { refusal: FastifyReply }> {
    const body = (req.body ?? undefined) as { turnstileToken?: unknown } | undefined;
    const checked = check(body);
    if (!checked.ok) return { refusal: fail(reply, 400, { error: 'invalidRequest' }) };

    const identity = identify(req);
    if (identity.kind !== 'user' && !(await protection.turnstile.verify(body?.turnstileToken, req.ip))) {
      return { refusal: fail(reply, 403, { error: 'turnstileFailed' }) };
    }

    const at = now();
    const used = await protection.store.incrementCounter(contactDayKey(hashIp(req.ip, secret), dayKey(at)), 1, dailyCounterExpiry(at));
    if (used > limits.contact.perIpPerDay) {
      void reply.header('retry-after', String(Math.max(1, Math.ceil((endOfUtcDay(at).getTime() - at.getTime()) / 1000))));
      return { refusal: fail(reply, 429, { error: 'rateLimited' }) };
    }
    return { fields: checked.value, identity, at };
  }

  const anonOf = (req: FastifyRequest): { anonId?: string } => (req.anonId ? { anonId: req.anonId } : {});
  const userOf = (identity: Identity): { userId?: NonNullable<ReturnType<typeof objectIdOf>> } => {
    const userId = identity.kind === 'user' ? objectIdOf(identity.userId) : undefined;
    return userId ? { userId } : {};
  };
  const ok: ContactResponse = { ok: true };

  app.post('/api/leads', { onRequest: rateLimit }, async (req, reply) => {
    const admitted = await admit(req, reply, checkLead);
    if ('refusal' in admitted) return admitted.refusal;
    const { fields, at } = admitted;
    const doc: LeadDoc = {
      createdAt: at,
      kind: 'lead',
      name: fields.name,
      email: fields.email,
      ...(fields.company !== undefined ? { company: fields.company } : {}),
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      page: fields.page,
      ...anonOf(req),
    };
    await store.insertLead(doc);
    return ok;
  });

  app.post('/api/waitlist', { onRequest: rateLimit }, async (req, reply) => {
    const admitted = await admit(req, reply, checkWaitlist);
    if ('refusal' in admitted) return admitted.refusal;
    const { fields, identity, at } = admitted;
    const doc: LeadDoc = {
      createdAt: at,
      kind: 'waitlist',
      email: fields.email,
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      trigger: fields.trigger,
      page: fields.page,
      ...userOf(identity),
      ...anonOf(req),
    };
    await store.insertLead(doc);
    return ok;
  });

  app.post('/api/feedback', { onRequest: rateLimit }, async (req, reply) => {
    const admitted = await admit(req, reply, checkFeedback);
    if ('refusal' in admitted) return admitted.refusal;
    const { fields, identity, at } = admitted;
    const doc: FeedbackDoc = {
      createdAt: at,
      kind: 'feedback',
      message: fields.message,
      ...(fields.email !== undefined ? { email: fields.email } : {}),
      page: fields.page,
      ...userOf(identity),
    };
    await store.insertFeedback(doc);
    return ok;
  });
}
