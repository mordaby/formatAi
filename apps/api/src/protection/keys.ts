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

/** The rounds of the learning loop (browser-triggered repairs) one learn has used (SPEC 9.3, `limits.llm.browserRepairCalls`). */
export const repairKey = (learnUuid: string): string => `repair:${learnUuid}`;

/** The steps of AI code checks one learn has made (learn-v9, SPEC 21 v14; at most `limits.learn.checks.maxRounds`). */
export const stepKey = (learnUuid: string): string => `step:${learnUuid}`;

/**
 * A signed-in user's AI-learn counter for the period `now` falls in (SPEC 13, 21 v5): `lifetime` has no date
 * part (and never expires), `month` is `yyyy-mm`, `day` is `yyyy-mm-dd`.
 */
export function aiLearnsKey(userId: string, period: Exclude<AiLearnPeriod, 'unlimited'>, now: Date): string {
  const base = `user:${userId}:aiLearns`;
  if (period === 'lifetime') return base;
  return `${base}:${period === 'month' ? monthKey(now) : dayKey(now)}`;
}

/** API audit C1: a signed-in user's requests that called the AI this UTC day (learn, step, repair - whatever they ended in). */
export const aiRequestsKey = (userId: string, now: Date): string => `user:${userId}:aiRequests:${dayKey(now)}`;

/** API audit C1: the `failed` outcome reports that gave a user's learn back this UTC day. */
export const failedRefundsKey = (userId: string, now: Date): string => `user:${userId}:failedRefunds:${dayKey(now)}`;

/**
 * API audit C1: the counter every request that calls the AI must fit under, by tier (`limits.protection.aiRequestsPerDay`) - reserved
 * with the AI-learn quota, so a refused request counts on neither.
 */
export function aiRequestsSpec(identity: Extract<Identity, { kind: 'user' }>, now: Date): LearnCounterSpec {
  return {
    key: aiRequestsKey(identity.userId, now),
    limit: limits.protection.aiRequestsPerDay[identity.tier],
    expiresAt: dailyCounterExpiry(now),
    limitCode: 'aiRequestsPerDay',
  };
}

/** A daily counter with a cap that refuses nothing by itself: what is over it is decided where it is read (the refunds below). */
export interface DailyCap {
  key: string;
  limit: number;
  expiresAt: Date;
}

/** API audit C1: the day's cap on refunds by a `failed` outcome (`limits.protection.failedRefundsPerDay`). */
export function failedRefundsCap(userId: string, now: Date): DailyCap {
  return { key: failedRefundsKey(userId, now), limit: limits.protection.failedRefundsPerDay, expiresAt: dailyCounterExpiry(now) };
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
