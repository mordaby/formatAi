import { limits, tiers } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import {
  anonLearnKey,
  dailyCounterExpiry,
  dayKey,
  endOfUtcDay,
  ipLearnKey,
  learnCounterSpecs,
  monthKey,
  repairKey,
  tierOf,
  userLearnKey,
} from '../../src/protection/keys.js';

const noon = new Date('2026-09-30T12:00:00.000Z');

describe('usage counter keys (SPEC 13)', () => {
  it('formats the UTC day and month', () => {
    expect(dayKey(noon)).toBe('2026-09-30');
    expect(monthKey(noon)).toBe('2026-09');
    // Just before/after UTC midnight, regardless of the machine's timezone.
    expect(dayKey(new Date('2026-09-30T23:59:59.999Z'))).toBe('2026-09-30');
    expect(dayKey(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
  });

  it('builds the documented key shapes', () => {
    expect(anonLearnKey('abc', '2026-09-30')).toBe('anon:abc:2026-09-30');
    expect(ipLearnKey('deadbeef', '2026-09-30')).toBe('ip:deadbeef:2026-09-30');
    expect(userLearnKey('u1', '2026-09')).toBe('user:u1:2026-09');
    expect(repairKey('x')).toBe('repair:x');
  });

  it('expires a daily counter once its UTC day is over, plus the configured grace', () => {
    expect(endOfUtcDay(noon).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    const graceMs = limits.protection.dailyCounterGraceHours * 3_600_000;
    expect(dailyCounterExpiry(noon).getTime()).toBe(Date.parse('2026-10-01T00:00:00.000Z') + graceMs);
  });
});

describe('learnCounterSpecs (SPEC 11, 9.5)', () => {
  it('limits an anonymous visitor per anonId AND per IP hash, per UTC day, with a TTL', () => {
    const specs = learnCounterSpecs({ kind: 'anon', anonId: 'AAA' }, 'iphash', noon);
    expect(specs.map((s) => s.key)).toEqual(['anon:AAA:2026-09-30', 'ip:iphash:2026-09-30']);
    expect(specs[0]!.limit).toBe(tiers.anonymous.learnsToLlm.count);
    expect(specs[0]!.limit).toBe(2);
    expect(specs[1]!.limit).toBe(limits.protection.anonLearnsPerIpPerDay);
    for (const s of specs) {
      expect(s.limitCode).toBe('learnsPerDay');
      expect(s.expiresAt).toBeInstanceOf(Date);
    }
  });

  it('limits a signed-in user per month with no expiry (ready for M3)', () => {
    const registered = learnCounterSpecs({ kind: 'user', userId: 'u1', tier: 'registered' }, 'iphash', noon);
    expect(registered).toEqual([
      { key: 'user:u1:2026-09', limit: tiers.registered.learnsToLlm.count, limitCode: 'learnsPerMonth' },
    ]);
    const paid = learnCounterSpecs({ kind: 'user', userId: 'u2', tier: 'paid' }, 'iphash', noon);
    expect(paid[0]!.limit).toBe(tiers.paid.learnsToLlm.count);
    expect(paid[0]!.expiresAt).toBeUndefined();
  });

  it('honours a per-user limit override', () => {
    const [spec] = learnCounterSpecs(
      { kind: 'user', userId: 'u1', tier: 'registered', learnLimitOverride: 99 },
      'iphash',
      noon,
    );
    expect(spec!.limit).toBe(99);
  });

  it('maps identities to their tier config', () => {
    expect(tierOf({ kind: 'anon', anonId: 'a' })).toBe('anonymous');
    expect(tierOf({ kind: 'user', userId: 'u', tier: 'paid' })).toBe('paid');
  });
});
