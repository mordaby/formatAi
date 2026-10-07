// The shared route helpers (API audit 2026-10-07: one of each, where the route files had their own copies): the refusal, the body
// shape check, and the per-IP request limit every protected route group runs first.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { fail, isRecord } from '../src/http.js';
import { createRateLimiter, limitByIp } from '../src/protection/rateLimit.js';

describe('the shared route helpers', () => {
  it('isRecord: a plain object only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const v of [null, undefined, [], [1], 'x', 1, true]) expect(isRecord(v)).toBe(false);
  });

  it('limitByIp: the allowance per address, then 429 rateLimited with Retry-After - and fail() sends the stable body', async () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, now: () => t });
    const app = Fastify();
    app.post('/x', { onRequest: (req, reply) => limitByIp(limiter, req, reply) }, async (_req, reply) => fail(reply, 418, { error: 'invalidRequest' }));
    const hit = (ip: string) => app.inject({ method: 'POST', url: '/x', remoteAddress: ip });
    try {
      expect((await hit('203.0.113.1')).statusCode).toBe(418);
      expect((await hit('203.0.113.1')).json()).toEqual({ error: 'invalidRequest' });
      const over = await hit('203.0.113.1');
      expect(over.statusCode).toBe(429);
      expect(over.json()).toEqual({ error: 'rateLimited' });
      expect(over.headers['retry-after']).toBe('60');
      expect((await hit('203.0.113.2')).statusCode).toBe(418); // another address has its own
      t = 60_001;
      expect((await hit('203.0.113.1')).statusCode).toBe(418); // a new window
    } finally {
      await app.close();
    }
  });
});
