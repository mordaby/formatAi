// A simple in-memory fixed-window request limiter (SPEC 9.5 "cost controls": a flood of requests
// must not even reach the Turnstile check or the database). Per process, which is fine for the one
// API instance the MVP runs; the daily learn limits, not this, are the durable protection.

export interface RateLimiter {
  /** Records one request for `id` and says whether it is within the window's allowance. */
  hit(id: string): { allowed: boolean; retryAfterSec: number };
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { max, windowMs } = opts;
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweepAt = 0;

  return {
    hit(id) {
      const t = now();
      // Drop expired windows once per window so the map can't grow without bound.
      if (t >= nextSweepAt) {
        for (const [key, w] of windows) if (w.resetAt <= t) windows.delete(key);
        nextSweepAt = t + windowMs;
      }
      let w = windows.get(id);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + windowMs };
        windows.set(id, w);
      }
      w.count += 1;
      return { allowed: w.count <= max, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
    },
  };
}
