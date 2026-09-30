// SPEC 13 `usage_counters` keys and the per-tier learn limits (SPEC 11, 9.5). Pure functions: the
// clock and the identity come in as arguments, so all of it is unit-testable.
import { limits, tiers, type LimitCode, type Tier } from '@formatai/shared';
import type { Identity } from './identity.js';

/** UTC day, `yyyy-mm-dd`. Counters and budgets both roll over at UTC midnight. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** UTC month, `yyyy-mm`. */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** The first instant of the UTC day after `now`. */
export function endOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** When a daily `anon:`/`ip:` counter can be TTL-expired: its day is over, plus a grace period. */
export function dailyCounterExpiry(now: Date): Date {
  return new Date(endOfUtcDay(now).getTime() + limits.protection.dailyCounterGraceHours * 60 * 60 * 1000);
}

export const anonLearnKey = (anonId: string, day: string): string => `anon:${anonId}:${day}`;
export const ipLearnKey = (ipHash: string, day: string): string => `ip:${ipHash}:${day}`;
export const userLearnKey = (userId: string, month: string): string => `user:${userId}:${month}`;
/** Consumed by the (single) browser-triggered repair of one learn (SPEC 9.3). */
export const repairKey = (learnUuid: string): string => `repair:${learnUuid}`;

/** One counter a learn must fit under before it may reach the LLM. */
export interface LearnCounterSpec {
  key: string;
  /** The most learns this counter may reach; the learn that would exceed it is refused. */
  limit: number;
  /** TTL for anon/ip keys; user keys never expire (SPEC 13). */
  expiresAt?: Date;
  /** What the client is told when this counter is the one that refuses. */
  limitCode: LimitCode;
}

/** The counters a learn by `identity` is checked against and incremented on (SPEC 11, 9.5):
 * anonymous = per anonId AND per IP-hash per UTC day; a signed-in user (M3) = per month. */
export function learnCounterSpecs(identity: Identity, ipHash: string, now: Date): LearnCounterSpec[] {
  if (identity.kind === 'anon') {
    const day = dayKey(now);
    const expiresAt = dailyCounterExpiry(now);
    return [
      {
        key: anonLearnKey(identity.anonId, day),
        limit: tiers.anonymous.learnsToLlm.count,
        expiresAt,
        limitCode: 'learnsPerDay',
      },
      {
        key: ipLearnKey(ipHash, day),
        limit: limits.protection.anonLearnsPerIpPerDay,
        expiresAt,
        limitCode: 'learnsPerDay',
      },
    ];
  }
  const { count, period } = tiers[identity.tier].learnsToLlm;
  return [
    {
      key: userLearnKey(identity.userId, monthKey(now)),
      limit: identity.learnLimitOverride ?? count,
      limitCode: period === 'day' ? 'learnsPerDay' : 'learnsPerMonth',
    },
  ];
}

/** The tier whose config (rows, rules per format, ...) applies to `identity`. */
export function tierOf(identity: Identity): Tier {
  return identity.kind === 'anon' ? 'anonymous' : identity.tier;
}
