import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/protection/rateLimit.js';

describe('createRateLimiter', () => {
  it('allows `max` requests per window per id, then refuses with a retry-after', () => {
    let t = 1_000;
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 3; i++) expect(limiter.hit('a').allowed).toBe(true);
    const refused = limiter.hit('a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSec).toBe(60);
    t += 30_000;
    expect(limiter.hit('a').retryAfterSec).toBe(30);
  });

  it('keeps ids independent', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('starts a fresh window once the old one ends', () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => t });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    t = 1_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });
});
