// `limit_hit {limit}` (SPEC 14.1, 11): the demand signal - which limit people run into - written in ONE place, wherever the API answers a
// `limitHit` (the AI quota, the AI requests a day, saved formats, new formats a month, inputs per format, rules per format, the steps and
// repairs of one learn). A per-route call would miss the next route that learns to refuse; this looks at the refusal itself.
//
// An `onSend` hook sees the serialized answer: only a 403 / 429 whose body says `"limitHit"` is parsed at all, and only a limit on the
// shared list is recorded (`limit_hit` takes `LIMIT_CODES`). The answer itself is never changed, and a failure to record is the recorder's
// to swallow.
import { LIMIT_CODES } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import type { EventRecorder } from './recorder.js';

/** Must be called BEFORE the routes are registered: a hook added to the app applies to the routes that come after it. */
export function registerLimitHitEvents(app: FastifyInstance, recorder: EventRecorder): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if ((reply.statusCode !== 429 && reply.statusCode !== 403) || typeof payload !== 'string' || !payload.includes('"limitHit"')) return payload;
    let limit: unknown;
    try {
      const body = JSON.parse(payload) as { error?: unknown; limit?: unknown } | null;
      if (body?.error === 'limitHit') limit = body.limit;
    } catch {
      return payload;
    }
    if (typeof limit === 'string' && (LIMIT_CODES as readonly string[]).includes(limit)) {
      await recorder.record(req, 'limit_hit', { limit: limit as (typeof LIMIT_CODES)[number] });
    }
    return payload;
  });
}
