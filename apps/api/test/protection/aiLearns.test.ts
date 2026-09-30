// The AI-learn state machine on its own (SPEC 21 v5 items 2-3): what each step does to the quota counter and to the
// example pair's failure counter, including the edges the route tests cannot reach in sequence (attempts that ran
// in parallel past the cap, a late success on an exhausted pair, refunds that must not go below zero).
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import {
  LEARN_STATE,
  failedAttemptsOf,
  groupOf,
  markFailed,
  markSucceeded,
  pairExhausted,
  quotaState,
  releaseReservation,
  settleLearn,
  stateOf,
  type AiLearnCtx,
} from '../../src/protection/aiLearns.js';
import type { AiQuota } from '../../src/protection/keys.js';
import { reserveLearn } from '../../src/protection/reserve.js';
import { createMemoryStore } from '../../src/protection/store.js';

const now = new Date('2026-09-30T12:00:00.000Z');
const cap = limits.learn.maxFailedAiAttempts;
const QUOTA_KEY = 'user:u1:aiLearns:2026-09';

function setup(limit = 10, unlimited = false) {
  const store = createMemoryStore(() => now);
  const quota: AiQuota = unlimited
    ? { period: 'unlimited', spec: null }
    : { period: 'month', spec: { key: QUOTA_KEY, limit, limitCode: 'aiLearns' } };
  let n = 0;
  /** A new learn on the same pair: its unit is reserved, as the route does before the LLM call. */
  const startLearn = async (): Promise<AiLearnCtx> => {
    const ctx: AiLearnCtx = {
      store,
      owner: 'user:u1',
      quota,
      group: groupOf('a'.repeat(64)),
      uuid: `learn-${(n += 1)}`,
      learnExpiresAt: new Date(now.getTime() + 60 * 60_000),
      now,
    };
    if (quota.spec) expect((await reserveLearn(store, [quota.spec])).ok).toBe(true);
    return ctx;
  };
  return { store, quota, startLearn };
}

describe('groupOf', () => {
  it('is a hex prefix of the structure hash, short enough for a learnId', () => {
    expect(groupOf('0123456789abcdef'.repeat(4))).toBe('0123456789abcdef01234567');
  });
});

describe('settleLearn', () => {
  it('keeps the reserved unit for a learn whose server checks passed', async () => {
    const { store, quota, startLearn } = setup();
    const ctx = await startLearn();
    const s = await settleLearn(ctx, { answered: true, verified: true });
    expect(s).toMatchObject({ state: LEARN_STATE.charged, counted: true, failedAttempts: 0, exhausted: false });
    expect(store.counter(QUOTA_KEY)).toBe(1);
    expect(await quotaState(store, quota)).toEqual({ remaining: 9, period: 'month' });
  });

  it('puts the unit back for a failed attempt and records the failure on the pair', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    const s = await settleLearn(ctx, { answered: true, verified: false });
    expect(s).toMatchObject({ state: LEARN_STATE.failed, counted: false, failedAttempts: 1, exhausted: false });
    expect(store.counter(QUOTA_KEY)).toBe(0);
  });

  it('puts the unit back and records nothing when no model answered', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    const s = await settleLearn(ctx, { answered: false, verified: false });
    expect(s).toMatchObject({ state: LEARN_STATE.open, counted: false, failedAttempts: 0 });
    expect(store.counter(QUOTA_KEY)).toBe(0);
  });

  it('counts the pair once at the attempt that reaches the cap, and not again for attempts past it', async () => {
    const { store, startLearn } = setup();
    const learns = [];
    for (let i = 0; i < cap + 2; i++) learns.push(await startLearn()); // all in flight together
    const settled = [];
    for (const ctx of learns) settled.push(await settleLearn(ctx, { answered: true, verified: false }));

    expect(settled.filter((s) => s.state === LEARN_STATE.exhausted)).toHaveLength(1);
    expect(settled[cap - 1]!.state).toBe(LEARN_STATE.exhausted);
    expect(settled[cap - 1]!.counted).toBe(true);
    expect(settled.slice(cap).every((s) => s.state === LEARN_STATE.failed && !s.counted)).toBe(true);
    expect(store.counter(QUOTA_KEY)).toBe(1); // one learn for the whole pair
    expect(await pairExhausted(store, 'user:u1', groupOf('a'.repeat(64)))).toBe(true);
  });

  it('works with no counter at all for an unlimited quota', async () => {
    const { store, startLearn } = setup(0, true);
    const ctx = await startLearn();
    expect((await settleLearn(ctx, { answered: true, verified: true })).counted).toBe(true);
    expect(store.counter(QUOTA_KEY)).toBe(0);
    await releaseReservation(ctx); // nothing to put back, and it must not fail
  });
});

describe('markSucceeded', () => {
  it('counts a failed learn and takes its failure back', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    await settleLearn(ctx, { answered: true, verified: false });
    const s = await markSucceeded(ctx);
    expect(s).toMatchObject({ state: LEARN_STATE.charged, counted: true, failedAttempts: 0 });
    expect(store.counter(QUOTA_KEY)).toBe(1);
  });

  it('is idempotent', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    await settleLearn(ctx, { answered: true, verified: false });
    await Promise.all([markSucceeded(ctx), markSucceeded(ctx), markSucceeded(ctx)]);
    expect(store.counter(QUOTA_KEY)).toBe(1);
    expect(await failedAttemptsOf(store, 'user:u1', ctx.group)).toBe(0);
  });

  it('counts a learn that no model answered, if the browser then reports success', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    await settleLearn(ctx, { answered: false, verified: false });
    expect((await markSucceeded(ctx)).counted).toBe(true);
    expect(store.counter(QUOTA_KEY)).toBe(1);
  });

  it('leaves a pair that used its attempts as it is: it already counted once at the cap', async () => {
    const { store, startLearn } = setup();
    const early = await startLearn();
    await settleLearn(early, { answered: true, verified: false }); // failure 1
    for (let i = 1; i < cap; i++) await settleLearn(await startLearn(), { answered: true, verified: false });
    expect(store.counter(QUOTA_KEY)).toBe(1);

    const late = await markSucceeded(early);
    expect(late.state).toBe(LEARN_STATE.failed);
    expect(late.exhausted).toBe(true);
    expect(store.counter(QUOTA_KEY)).toBe(1); // not counted a second time
  });

  it('never takes the failure counter below zero', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    await settleLearn(ctx, { answered: true, verified: false });
    await store.incrementCounter(`aiFail:user:u1:${ctx.group}`, -1); // the window expired underneath it
    await markSucceeded(ctx);
    expect(await failedAttemptsOf(store, 'user:u1', ctx.group)).toBe(0);
  });
});

describe('markFailed', () => {
  it('gives back a counted learn and records a failure; idempotent', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    await settleLearn(ctx, { answered: true, verified: true });
    const first = await markFailed(ctx);
    expect(first).toMatchObject({ state: LEARN_STATE.failed, counted: false, failedAttempts: 1 });
    expect(store.counter(QUOTA_KEY)).toBe(0);
    await Promise.all([markFailed(ctx), markFailed(ctx)]);
    expect(await failedAttemptsOf(store, 'user:u1', ctx.group)).toBe(1);
    expect(store.counter(QUOTA_KEY)).toBe(0);
  });

  it('does nothing to a learn that was not counted (its failure was recorded when it failed)', async () => {
    const { store, startLearn } = setup();
    const ctx = await startLearn();
    await settleLearn(ctx, { answered: true, verified: false });
    await markFailed(ctx);
    expect(await failedAttemptsOf(store, 'user:u1', ctx.group)).toBe(1);
    const open = await startLearn();
    await settleLearn(open, { answered: false, verified: false });
    expect((await markFailed(open)).failedAttempts).toBe(1);
    expect((await stateOf(open)).state).toBe(LEARN_STATE.open);
  });

  it('counts the pair once when the reported failure is the one that reaches the cap', async () => {
    const { store, startLearn } = setup();
    for (let i = 1; i < cap; i++) await settleLearn(await startLearn(), { answered: true, verified: false });
    const last = await startLearn();
    await settleLearn(last, { answered: true, verified: true }); // server says fine: counted
    expect(store.counter(QUOTA_KEY)).toBe(1);
    const s = await markFailed(last); // the browser disagrees: refunded, then the pair counts once
    expect(s).toMatchObject({ state: LEARN_STATE.exhausted, counted: true, exhausted: true });
    expect(store.counter(QUOTA_KEY)).toBe(1);
  });
});
