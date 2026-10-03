// SPEC 13 `usage_counters` keys and the per-tier AI-learn quota (SPEC 11, 9.5, 21 v5). Pure functions: the
// clock and the identity come in as arguments, so all of it is unit-testable.
import { limits, tiers, type AiLearnPeriod, type LimitCode, type Tier } from '@formatai/shared';
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

/** When a daily counter can be TTL-expired: its day is over, plus a grace period. */
export function dailyCounterExpiry(now: Date): Date {
  return new Date(endOfUtcDay(now).getTime() + limits.protection.dailyCounterGraceHours * 60 * 60 * 1000);
}

/** Consumed by the (single) browser-triggered repair of one learn (SPEC 9.3). */
export const repairKey = (learnUuid: string): string => `repair:${learnUuid}`;

/**
 * A signed-in user's AI-learn counter for the period `now` falls in (SPEC 13, 21 v5): `lifetime` has no date
 * part (and never expires), `month` is `yyyy-mm`, `day` is `yyyy-mm-dd`.
 */
export function aiLearnsKey(userId: string, period: Exclude<AiLearnPeriod, 'unlimited'>, now: Date): string {
  const base = `user:${userId}:aiLearns`;
  if (period === 'lifetime') return base;
  return `${base}:${period === 'month' ? monthKey(now) : dayKey(now)}`;
}

/** Failed AI attempts on one example pair: the owner plus the structure tag (`AiLearnCtx.group`). */
export const aiFailKey = (owner: string, group: string): string => `aiFail:${owner}:${group}`;

/** Where one learn stands (see `aiLearns.ts`): open, counted, failed or ended by the failure cap. */
export const aiLearnStateKey = (learnUuid: string): string => `aiLearn:${learnUuid}`;

/** A paid user's new formats this calendar month (DECISION 9). */
export const newFormatsKey = (userId: string, now: Date): string => `user:${userId}:newFormats:${monthKey(now)}`;

/** One counter an AI learn must fit under before it may reach the LLM. */
export interface LearnCounterSpec {
  key: string;
  /** The most this counter may reach; the reservation that would exceed it is refused. */
  limit: number;
  /** TTL for counters that expire (a daily one); lifetime and monthly user counters never do (SPEC 13). */
  expiresAt?: Date;
  /** What the client is told when this counter is the one that refuses. */
  limitCode: LimitCode;
}

export interface AiQuota {
  period: AiLearnPeriod;
  /** The counter and its limit; null for an `unlimited` quota (nothing to count against). */
  spec: LearnCounterSpec | null;
}

/**
 * The AI-learn quota of `identity` (SPEC 11, 21 v5) from `tiers[tier].aiLearns`, with an admin's
 * per-user override (`users.limitOverrides`) of the count. An anonymous caller has none (count 0) - it
 * never reaches the AI, this is only the safe answer if a route asks.
 */
export function aiQuotaOf(identity: Identity, now: Date): AiQuota {
  const { count, period } = tiers[tierOf(identity)].aiLearns;
  if (period === 'unlimited') return { period, spec: null };
  if (identity.kind === 'anon') {
    return { period, spec: { key: `anon:${identity.anonId}:aiLearns`, limit: 0, limitCode: 'aiLearns' } };
  }
  return {
    period,
    spec: {
      key: aiLearnsKey(identity.userId, period, now),
      limit: identity.learnLimitOverride ?? count,
      ...(period === 'day' ? { expiresAt: dailyCounterExpiry(now) } : {}),
      limitCode: 'aiLearns',
    },
  };
}

/** The tier whose config (rows, rules per format, ...) applies to `identity`. */
export function tierOf(identity: Identity): Tier {
  return identity.kind === 'anon' ? 'anonymous' : identity.tier;
}
