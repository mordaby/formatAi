import { limits, tiers } from '@formatai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { identityOf, type Identity } from '../../src/protection/identity.js';
import {
  aiFailKey,
  aiLearnStateKey,
  aiLearnsKey,
  aiQuotaOf,
  dailyCounterExpiry,
  dayKey,
  endOfUtcDay,
  monthKey,
  newFormatsKey,
  repairKey,
  tierOf,
} from '../../src/protection/keys.js';

const noon = new Date('2026-09-30T12:00:00.000Z');
const registered = (extra: Partial<Extract<Identity, { kind: 'user' }>> = {}): Identity => ({
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
    const graceMs = limits.protection.dailyCounterGraceHours * 3_600_000;
    expect(dailyCounterExpiry(noon).getTime()).toBe(Date.parse('2026-10-01T00:00:00.000Z') + graceMs);
  });
});

describe('aiQuotaOf (SPEC 11, 21 v5: AI learns per tier, config only)', () => {
  const original = structuredClone(tiers.registered.aiLearns);
  afterEach(() => {
    tiers.registered.aiLearns = structuredClone(original);
  });

  it('gives a registered user its monthly count, with no expiry on the counter', () => {
    const q = aiQuotaOf(registered(), noon);
    expect(q.period).toBe('month');
    expect(q.spec).toEqual({ key: 'user:u1:aiLearns:2026-09', limit: tiers.registered.aiLearns.count, limitCode: 'aiLearns' });
    expect(q.spec!.expiresAt).toBeUndefined();
  });

  it('gives a paid user its own, larger quota', () => {
    const q = aiQuotaOf(registered({ tier: 'paid' }), noon);
    expect(q.spec!.limit).toBe(tiers.paid.aiLearns.count);
    expect(q.spec!.limit).toBeGreaterThan(tiers.registered.aiLearns.count);
  });

  it('follows the configured period: lifetime has no date part, day has a TTL, unlimited has no counter', () => {
    tiers.registered.aiLearns = { count: 2, period: 'lifetime' };
    const lifetime = aiQuotaOf(registered(), noon);
    expect(lifetime.spec).toEqual({ key: 'user:u1:aiLearns', limit: 2, limitCode: 'aiLearns' });
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

  it('gives an anonymous visitor none: a limit of 0 (it never reaches the AI)', () => {
    const q = aiQuotaOf({ kind: 'anon', anonId: 'AAA' }, noon);
    expect(q.spec!.limit).toBe(0);
    expect(tiers.anonymous.aiLearns.count).toBe(0);
  });

  it('maps identities to their tier config', () => {
    expect(tierOf({ kind: 'anon', anonId: 'a' })).toBe('anonymous');
    expect(tierOf(registered({ tier: 'paid' }))).toBe('paid');
  });
});
