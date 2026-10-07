// SPEC 11 / 21 v5 items 2-3: the AI-learn quota and its counting rule.
//
//   A learn counts ONCE, when it succeeds. A failed attempt does not count - but after
//   `limits.learn.maxFailedAiAttempts` failed attempts on the same example pair (the "group": owner + the
//   structure hash of the payload, see `protection/cache.ts`) the AI stops being called for that pair and the
//   pair counts as ONE learn. Repairs inside a learn never count separately.
//
// How that is kept, with atomic counters only (they work the same on MongoDB and on the in-memory store):
//
//   * Before the LLM is called, one unit of the user's period counter (`user:<id>:aiLearns[:<period-key>]`)
//     is RESERVED (increment; put back if it went over the limit) - so concurrent learns can never slip past
//     the quota, and a refused learn costs nothing.
//   * What happens to that unit depends on how the learn ends, tracked in one small state counter per learn
//     (`aiLearn:<uuid>`), moved only by compare-and-set so every change happens at most once:
//
//        open (0) --server checks pass (layers 1-7)------------------> charged (1)   the unit stays
//        open (0) --server checks fail, attempts left----------------> failed (2)    the unit is released
//        open (0) --server checks fail, the cap is reached-----------> exhausted (3) the unit stays: the pair counts once
//        failed (2) --a loop round passes / the browser reports verified
//                     or accepted (saved with accepted differences)--> charged (1)   F is refunded, unit charged
//        charged (1) --the browser reports the full verification
//                      failed (the result did not match the example)--> failed (2)    unit refunded, F recorded
//                                                                      (or exhausted (3) if that reaches the cap)
//
//   F is the group's failure counter (`aiFail:<owner>:<group>`, expires after
//   `limits.learn.failedAttemptsWindowHours`). A provider outage (no model answered at all) is nobody's failed
//   attempt: the unit is released and F is untouched.
//
// DECISION: a learn whose server checks pass counts at once - not only when the browser reports - because a
// browser that never reports would otherwise get results for free. The one way back is `failed` (it refunds
// the unit and records a failure on the pair); the cap is what bounds that: 3 attempts per pair per window.
//
// The learning loop (SPEC 9.3): a learn may take up to `limits.llm.browserRepairCalls` rounds, and however many it takes it
// is ONE learn. Every move above happens at most once per learn - a round that passes finds the learn charged already, or
// moves it there once (`markSucceeded` is idempotent); a round that fails changes nothing - and the browser reports once,
// when the loop has ended: `verified` (it stays counted, or is counted now) or `failed` (one failed attempt, nothing counted).
import { limits, type AiLearnQuotaState } from '@formatai/shared';
import { aiFailKey, aiLearnStateKey, type AiQuota, type DailyCap } from './keys.js';
import type { ProtectionStore } from './store.js';

export const LEARN_STATE = { open: 0, charged: 1, failed: 2, exhausted: 3 } as const;
export type LearnState = (typeof LEARN_STATE)[keyof typeof LEARN_STATE];

const HOUR_MS = 60 * 60 * 1000;

export interface AiLearnCtx {
  store: ProtectionStore;
  /** `user:<id>`. */
  owner: string;
  quota: AiQuota;
  /** The example pair's tag (a hex prefix of the structure hash); also inside the learnId. */
  group: string;
  /** The learn's uuid (the learnId's first part). */
  uuid: string;
  /** When the learnId expires: the learn's state counter is kept that long, plus a grace hour. */
  learnExpiresAt: Date;
  now: Date;
}

/** Where a learn stands after a step. */
export interface Settled {
  state: LearnState;
  /** This learn is counted against the quota now (charged, or the one learn a failed pair counts as). */
  counted: boolean;
  /** Failed attempts recorded on the pair so far. */
  failedAttempts: number;
  /** The failed-attempt cap on the pair is reached: the AI is not called for it any more. */
  exhausted: boolean;
}

export const failureCap = (): number => limits.learn.maxFailedAiAttempts;

/** The example pair's tag: what the learnId carries and the failure counter is keyed by. */
export function groupOf(structureHash: string): string {
  return structureHash.slice(0, 24);
}

const stateExpiry = (ctx: AiLearnCtx): Date => new Date(ctx.learnExpiresAt.getTime() + HOUR_MS);
const failExpiry = (ctx: AiLearnCtx): Date =>
  new Date(ctx.now.getTime() + limits.learn.failedAttemptsWindowHours * HOUR_MS);

const stateKey = (ctx: AiLearnCtx): string => aiLearnStateKey(ctx.uuid);
const failKey = (ctx: Pick<AiLearnCtx, 'owner' | 'group'>): string => aiFailKey(ctx.owner, ctx.group);

/** Failed attempts on the pair `owner` + `group` inside the window. */
export function failedAttemptsOf(store: ProtectionStore, owner: string, group: string): Promise<number> {
  return store.getCounter(aiFailKey(owner, group));
}

/** The pair already used its failed attempts: do not call the AI for it again. */
export async function pairExhausted(store: ProtectionStore, owner: string, group: string): Promise<boolean> {
  return (await failedAttemptsOf(store, owner, group)) >= failureCap();
}

/**
 * What is left of the quota (`null` remaining = unlimited), and (API audit P2, 2026-10-07) the user's own limit for the period: the plan's,
 * or the admin's override (`aiQuotaOf`) - so the browser never says the plan's number to someone whose account has another.
 */
export async function quotaState(store: ProtectionStore, quota: AiQuota): Promise<AiLearnQuotaState> {
  if (!quota.spec) return { remaining: null, period: quota.period, limit: null };
  const used = await store.getCounter(quota.spec.key);
  return { remaining: Math.max(0, quota.spec.limit - used), period: quota.period, limit: quota.spec.limit };
}

async function charge(ctx: AiLearnCtx, by: 1 | -1): Promise<void> {
  const { spec } = ctx.quota;
  if (spec) await ctx.store.incrementCounter(spec.key, by, spec.expiresAt);
}

/** Puts back the unit reserved before the LLM call (a call that threw, or a learn that did not count). */
export function releaseReservation(ctx: AiLearnCtx): Promise<void> {
  return charge(ctx, -1);
}

/**
 * Records (+1) or takes back (-1) a failed attempt on the pair. A take-back keeps the window the failures are counted in (`keepExpiry`: the
 * expiry is set only on a counter that has none). API audit (2026-10-07): it never RE-CREATES a counter whose window is over - nothing
 * recorded is nothing to take back - and a counter it takes below zero (two take-backs at once) is put back to zero WITH a fresh expiry.
 */
async function bumpFailures(ctx: AiLearnCtx, by: 1 | -1): Promise<number> {
  if (by === -1 && (await failedAttemptsOf(ctx.store, ctx.owner, ctx.group)) <= 0) return 0;
  const n = await ctx.store.incrementCounter(failKey(ctx), by, failExpiry(ctx), { keepExpiry: by === -1 });
  if (n < 0) return ctx.store.incrementCounter(failKey(ctx), 1, failExpiry(ctx)); // never below zero
  return n;
}

/** Where the learn stands now, without changing anything. */
export async function stateOf(ctx: AiLearnCtx): Promise<Settled> {
  const [state, failedAttempts] = await Promise.all([
    ctx.store.getCounter(stateKey(ctx)),
    failedAttemptsOf(ctx.store, ctx.owner, ctx.group),
  ]);
  return {
    state: state as LearnState,
    counted: state === LEARN_STATE.charged || state === LEARN_STATE.exhausted,
    failedAttempts,
    exhausted: failedAttempts >= failureCap(),
  };
}

/**
 * The end of a `/api/learn` call (its unit is already reserved). `answered` = at least one model answered
 * (false when every call ended in a provider error); `verified` = the server checks (layers 1-7) passed.
 */
export async function settleLearn(ctx: AiLearnCtx, r: { answered: boolean; verified: boolean }): Promise<Settled> {
  if (!r.answered) {
    await releaseReservation(ctx);
    return stateOf(ctx);
  }
  if (r.verified) {
    await ctx.store.transitionCounter(stateKey(ctx), LEARN_STATE.open, LEARN_STATE.charged, stateExpiry(ctx));
    return stateOf(ctx);
  }

  const failed = await bumpFailures(ctx, 1);
  if (failed === failureCap()) {
    // The attempt that reaches the cap: the reservation stays - the pair counts as this one learn.
    await ctx.store.transitionCounter(stateKey(ctx), LEARN_STATE.open, LEARN_STATE.exhausted, stateExpiry(ctx));
    return stateOf(ctx);
  }
  // Attempts left, or a parallel attempt that ran past the cap (the pair already counted once): not counted.
  await ctx.store.transitionCounter(stateKey(ctx), LEARN_STATE.open, LEARN_STATE.failed, stateExpiry(ctx));
  await releaseReservation(ctx);
  return stateOf(ctx);
}

/**
 * The learn succeeded: a loop round passed the server checks, or the browser reported it `verified` / `accepted`.
 * Counts it if it does not count yet; idempotent.
 */
export async function markSucceeded(ctx: AiLearnCtx): Promise<Settled> {
  const state = await ctx.store.getCounter(stateKey(ctx));
  if (state === LEARN_STATE.failed) {
    // A pair that already used its attempts stays as it is (it counted once when it reached the cap).
    if ((await failedAttemptsOf(ctx.store, ctx.owner, ctx.group)) < failureCap()) {
      if (await ctx.store.transitionCounter(stateKey(ctx), LEARN_STATE.failed, LEARN_STATE.charged, stateExpiry(ctx))) {
        await bumpFailures(ctx, -1);
        await charge(ctx, 1);
      }
    }
  } else if (state === LEARN_STATE.open) {
    if (await ctx.store.transitionCounter(stateKey(ctx), LEARN_STATE.open, LEARN_STATE.charged, stateExpiry(ctx))) {
      await charge(ctx, 1);
    }
  }
  return stateOf(ctx);
}

/**
 * The browser reports that its full verification failed and the attempt did not work out. A learn the server
 * had counted is given back and recorded as a failed attempt on the pair; idempotent.
 *
 * API audit C1 (2026-10-07): at most `refunds.limit` such refunds per user per UTC day (`limits.protection.failedRefundsPerDay`). Past it
 * the report changes nothing here: the learn stays counted, and no failure is recorded on the pair (the caller still evicts the cache).
 * DECISION: the cap is counted before the move and given back when the move does not happen (another report got there first), so two
 * reports at once never spend two refunds, and a report of a learn that was not counted spends none.
 */
export async function markFailed(ctx: AiLearnCtx, refunds?: DailyCap): Promise<Settled> {
  const state = await ctx.store.getCounter(stateKey(ctx));
  if (state !== LEARN_STATE.charged) return stateOf(ctx);
  if (refunds) {
    const used = await ctx.store.incrementCounter(refunds.key, 1, refunds.expiresAt);
    if (used > refunds.limit) {
      await ctx.store.incrementCounter(refunds.key, -1, refunds.expiresAt);
      return stateOf(ctx);
    }
  }
  const moved = await ctx.store.transitionCounter(stateKey(ctx), LEARN_STATE.charged, LEARN_STATE.failed, stateExpiry(ctx));
  if (!moved && refunds) await ctx.store.incrementCounter(refunds.key, -1, refunds.expiresAt);
  if (moved) {
    await charge(ctx, -1);
    const failed = await bumpFailures(ctx, 1);
    if (
      failed === failureCap() &&
      (await ctx.store.transitionCounter(stateKey(ctx), LEARN_STATE.failed, LEARN_STATE.exhausted, stateExpiry(ctx)))
    ) {
      await charge(ctx, 1);
      // (the pair counts as this one learn after all: nothing was refunded)
      if (refunds) await ctx.store.incrementCounter(refunds.key, -1, refunds.expiresAt);
    }
  }
  return stateOf(ctx);
}
