import { limits, retentionSeconds, tiers } from '@formatai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { identityOf, type Identity } from '../../src/protection/identity.js';
import {
  aiFailKey,
  aiLearnStateKey,
  aiLearnsKey,
  aiQuotaOf,
  counterExpiryOfKey,
  dailyCounterExpiry,
  dayKey,
  endOfUtcDay,
  endOfUtcMonth,
  lifetimeCounterExpiry,
  monthKey,
  monthlyCounterExpiry,
  newFormatsKey,
  repairKey,
  tierOf,
} from '../../src/protection/keys.js';

const noon = new Date('2026-09-30T12:00:00.000Z');
const registered = (extra: Partial<Extract<Identity, { kind: 'user' }>> = {}): Extract<Identity, { kind: 'user' }> => ({
  kind: 'user',
  userId: 'u1',
  tier: 'registered',
  ...extra,
});

describe('usage counter keys (SPEC 13)', () => {
  it('formats the UTC day and month', () => {
    expect(dayKey(noon)).toBe('2026-09-30');
    expect(monthKey(noon)).toBe('2026-09');
    // Just before/after UTC midnight, regardless of the machine's timezone.
    expect(dayKey(new Date('2026-09-30T23:59:59.999Z'))).toBe('2026-09-30');
    expect(dayKey(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
  });

  it('builds the documented key shapes', () => {
    expect(aiLearnsKey('u1', 'lifetime', noon)).toBe('user:u1:aiLearns');
    expect(aiLearnsKey('u1', 'month', noon)).toBe('user:u1:aiLearns:2026-09');
    expect(aiLearnsKey('u1', 'day', noon)).toBe('user:u1:aiLearns:2026-09-30');
    expect(newFormatsKey('u1', noon)).toBe('user:u1:newFormats:2026-09');
    expect(aiFailKey('user:u1', 'abc123')).toBe('aiFail:user:u1:abc123');
    expect(aiLearnStateKey('x')).toBe('aiLearn:x');
    expect(repairKey('x')).toBe('repair:x');
  });

  it('expires a daily counter once its UTC day is over, plus the configured grace', () => {
    expect(endOfUtcDay(noon).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    const graceMs = limits.protection.counterGraceHours * 3_600_000;
    expect(dailyCounterExpiry(noon).getTime()).toBe(Date.parse('2026-10-01T00:00:00.000Z') + graceMs);
  });

  it('expires a monthly counter once its UTC month is over, plus the same grace (about two days, as the privacy page says)', () => {
    expect(limits.protection.counterGraceHours).toBe(48);
    expect(endOfUtcMonth(noon).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(monthlyCounterExpiry(noon).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(monthlyCounterExpiry(new Date('2026-12-31T23:59:59.999Z')).toISOString()).toBe('2027-01-03T00:00:00.000Z');
    expect(monthlyCounterExpiry(new Date('2026-02-01T00:00:00.000Z')).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('keeps a lifetime counter for the AI-record period after its last change', () => {
    const ms = retentionSeconds(limits.retention.aiCallRecordsMonths) * 1000;
    expect(lifetimeCounterExpiry(noon).getTime()).toBe(noon.getTime() + ms);
  });

  it('reads the expiry an old counter without one is given from its key (backfillCounterExpiry)', () => {
    const later = new Date('2026-10-07T09:00:00.000Z');
    expect(counterExpiryOfKey('user:u1:aiLearns:2026-09', later)).toEqual(monthlyCounterExpiry(noon));
    expect(counterExpiryOfKey('user:u1:newFormats:2026-09', later)).toEqual(monthlyCounterExpiry(noon));
    expect(counterExpiryOfKey('fnreq:recorded:2026-09', later)).toEqual(monthlyCounterExpiry(noon));
    expect(counterExpiryOfKey('ip:abc:contact:2026-09-30', later)).toEqual(dailyCounterExpiry(noon));
    expect(counterExpiryOfKey('aiFail:user:u1:abc', later).getTime()).toBe(later.getTime() + limits.learn.failedAttemptsWindowHours * 3_600_000);
    expect(counterExpiryOfKey('user:u1:aiLearns', later)).toEqual(lifetimeCounterExpiry(later));
  });
});

describe('aiQuotaOf (SPEC 11, 21 v5: AI learns per tier, config only)', () => {
  const original = structuredClone(tiers.registered.aiLearns);
  afterEach(() => {
    tiers.registered.aiLearns = structuredClone(original);
  });

  it('gives a registered user its monthly count, on a counter that expires after its month (plus the grace)', () => {
    const q = aiQuotaOf(registered(), noon);
    expect(q.period).toBe('month');
    expect(q.spec).toEqual({
      key: 'user:u1:aiLearns:2026-09',
      limit: tiers.registered.aiLearns.count,
      expiresAt: monthlyCounterExpiry(noon),
      limitCode: 'aiLearns',
    });
  });

  it('gives a paid user its own, larger quota', () => {
    const q = aiQuotaOf(registered({ tier: 'paid' }), noon);
    expect(q.spec!.limit).toBe(tiers.paid.aiLearns.count);
    expect(q.spec!.limit).toBeGreaterThan(tiers.registered.aiLearns.count);
  });

  it('follows the configured period: lifetime has no date part, day has a TTL, unlimited has no counter', () => {
    tiers.registered.aiLearns = { count: 2, period: 'lifetime' };
    const lifetime = aiQuotaOf(registered(), noon);
    expect(lifetime.spec).toEqual({ key: 'user:u1:aiLearns', limit: 2, expiresAt: lifetimeCounterExpiry(noon), limitCode: 'aiLearns' });
    // The same counter in another month: a lifetime allowance does not reset.
    expect(aiQuotaOf(registered(), new Date('2027-03-01T00:00:00Z')).spec!.key).toBe('user:u1:aiLearns');

    tiers.registered.aiLearns = { count: 2, period: 'day' };
    const day = aiQuotaOf(registered(), noon);
    expect(day.spec!.key).toBe('user:u1:aiLearns:2026-09-30');
    expect(day.spec!.expiresAt).toEqual(dailyCounterExpiry(noon));

    tiers.registered.aiLearns = { count: 2, period: 'unlimited' };
    expect(aiQuotaOf(registered(), noon)).toEqual({ period: 'unlimited', spec: null });
  });

  it('honours a per-user override of the count (users.limitOverrides.aiLearns)', () => {
    expect(aiQuotaOf(registered({ learnLimitOverride: 99 }), noon).spec!.limit).toBe(99);
  });

  it('API audit P2: reads `aiLearns` only - the legacy `learnsToLlm` key is no override any more', () => {
    const req = (limitOverrides: Record<string, number>) =>
      ({ anonId: 'AAAAAAAAAAAAAAAA', authUser: { userId: 'u1', tier: 'registered', isAdmin: false, limitOverrides } }) as unknown as FastifyRequest;
    expect(identityOf(req({ aiLearns: 7 }))).toMatchObject({ learnLimitOverride: 7 });
    expect(identityOf(req({ learnsToLlm: 9 }))).not.toHaveProperty('learnLimitOverride');
    expect(identityOf(req({ aiLearns: 7 }))).not.toHaveProperty('limitOverrides');
  });

  it('maps identities to their tier config', () => {
    expect(tierOf({ kind: 'anon', anonId: 'a' })).toBe('anonymous');
    expect(tierOf(registered({ tier: 'paid' }))).toBe('paid');
  });
});
