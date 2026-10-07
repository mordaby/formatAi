// When a usage counter (`usage_counters`, SPEC 13) is TTL-expired. Owner decision 2026-10-07: every counter carries `expiresAt` - the end
// of the period it counts plus `limits.protection.counterGraceHours`, or the end of its own window - and the privacy page says the same
// numbers. Pure functions of the clock; no request types, so the learn code (and the eval harness that imports it) can use them too.
import { limits, retentionSeconds } from '@formatai/shared';

const HOUR_MS = 60 * 60 * 1000;

/** The first instant of the UTC day after `now`. */
export function endOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** The first instant of the UTC month after `now`. */
export function endOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

const graceMs = (): number => limits.protection.counterGraceHours * HOUR_MS;

/** When a daily counter can be TTL-expired: its day is over, plus the grace period (`limits.protection.counterGraceHours`). */
export function dailyCounterExpiry(now: Date): Date {
  return new Date(endOfUtcDay(now).getTime() + graceMs());
}

/** When a monthly counter can be TTL-expired: its UTC month is over, plus the same grace period. */
export function monthlyCounterExpiry(now: Date): Date {
  return new Date(endOfUtcMonth(now).getTime() + graceMs());
}

/**
 * When a `lifetime` AI-learn counter can be TTL-expired: it has no period to end, so it is kept for the AI-record period
 * (`limits.retention.aiCallRecordsMonths`) after its last change - an allowance is remembered as long as the records of the learns that
 * used it. No signed-in tier counts its AI learns over a lifetime today (`tiers.ts`), so this is the rule for a config that may come.
 */
export function lifetimeCounterExpiry(now: Date): Date {
  return new Date(now.getTime() + retentionSeconds(limits.retention.aiCallRecordsMonths) * 1000);
}

/**
 * The expiry a counter written before every counter had one is given (`backfillCounterExpiry`, db.ts), read from its key: a key that
 * ends in a UTC day (`:yyyy-mm-dd`) or month (`:yyyy-mm`) expires as a counter of that day or month does today; a pair's failure counter
 * (`aiFail:`) gets a fresh failure window from `now`; anything else (a `lifetime` AI-learn counter) the lifetime rule from `now`.
 */
export function counterExpiryOfKey(key: string, now: Date): Date {
  const day = /:(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (day) return dailyCounterExpiry(new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))));
  const month = /:(\d{4})-(\d{2})$/.exec(key);
  if (month) return monthlyCounterExpiry(new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1)));
  if (key.startsWith('aiFail:')) return new Date(now.getTime() + limits.learn.failedAttemptsWindowHours * HOUR_MS);
  return lifetimeCounterExpiry(now);
}
