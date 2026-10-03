// The AI-learn quota and what counts as a learn (SPEC 11, 21 v5 items 2-3), end to end (fastify inject):
// the per-tier quota with its periods, count-on-success (server checks or the browser's report), the
// idempotent outcome route, and the stop after 3 failed attempts on the same example pair.
// Every suite runs against the in-memory store, and against a real local MongoDB when MONGODB_URI is set.
import { limits, tiers, type AiLearnQuota } from '@formatai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompleteFn } from '../../src/learn/index.js';
import type { CompleteRequest } from '../../src/llm/index.js';
import { aiFailKey, aiLearnsKey } from '../../src/protection/keys.js';
import { basicPayload, correctRules, correctRulesWireJson, wrongRoundingWireJson } from '../learn/fixtures.js';
import {
  createHarness,
  makeComplete,
  memoryKit,
  mongoKit,
  mongoUri,
  TEST_USER,
  testUserId,
  useKit,
  type Harness,
  type StoreKit,
} from './harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const originalQuotas = {
  registered: structuredClone(tiers.registered.aiLearns),
  paid: structuredClone(tiers.paid.aiLearns),
};

/** A fake LLM that answers call 1 with `answers[0]`, call 2 with `answers[1]`, ... (the last one repeats). */
function scripted(...answers: unknown[]): { fn: CompleteFn; calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = [];
  const fn: CompleteFn = async (req) => {
    calls.push(req);
    const json = answers[Math.min(calls.length - 1, answers.length - 1)];
    return {
      json,
      raw: '',
      usage: { tokensIn: 10, tokensOut: 5, tokensCachedRead: 0, tokensCachedWrite: 0 },
      costUsd: 0,
      latencyMs: 1,
      model: req.model,
      provider: 'fake',
    };
  };
  return { fn, calls };
}

/** A failing learn makes this many LLM calls: the first try, its server repair round, the escalation. */
const CALLS_PER_FAILED_LEARN = 2 + limits.llm.serverRepairRounds;

function defineQuotaSuite(kit: StoreKit): void {
  useKit(kit);

  let harness: Harness | undefined;
  afterEach(async () => {
    tiers.registered.aiLearns = structuredClone(originalQuotas.registered);
    tiers.paid.aiLearns = structuredClone(originalQuotas.paid);
    await harness?.close();
    harness = undefined;
  });

  async function setup(complete: CompleteFn): Promise<Harness> {
    harness = await createHarness(kit, { complete });
    return harness;
  }

  const quotaKey = (h: Harness, user = TEST_USER, period: 'month' | 'day' | 'lifetime' = 'month'): string =>
    aiLearnsKey(user, period, h.clock.current);
  const used = (h: Harness, user = TEST_USER, period: 'month' | 'day' | 'lifetime' = 'month'): Promise<number> =>
    h.handle.counter(quotaKey(h, user, period));
  const groupOfLearnId = (learnId: string): string => learnId.split('.')[2]!;

  const outcome = (h: Harness, learnId: string, value: unknown, user = TEST_USER) =>
    h.post(`/api/learn/${learnId}/outcome`, { outcome: value }, { user });

  // ---------------------------------------------------------------- the quota and its periods

  describe('the quota (config: aiLearns { count, period })', () => {
    it('lets a registered user learn 3 times a month, then answers 429 limitHit aiLearns before calling the AI', async () => {
      const llm = makeComplete();
      const h = await setup(llm.fn);
      expect(tiers.registered.aiLearns).toEqual({ count: 3, period: 'month' });

      for (const remaining of [2, 1, 0]) {
        const res = await h.learn({ noCache: true });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ verified: true, counted: true, quota: { remaining, period: 'month' } });
      }
      const fourth = await h.learn({ noCache: true });
      expect(fourth.statusCode).toBe(429);
      expect(fourth.json()).toEqual({ error: 'limitHit', limit: 'aiLearns', period: 'month' });
      expect(llm.calls).toHaveLength(3);
      // The refused attempt left nothing behind.
      expect(await used(h)).toBe(3);
      expect(await h.handle.ledger()).toHaveLength(3);
    });

    it('starts a new count in the next UTC month', async () => {
      const h = await setup(makeComplete().fn);
      for (let i = 0; i < 3; i++) await h.learn({ noCache: true });
      expect((await h.learn({ noCache: true })).statusCode).toBe(429);

      const now = h.clock.current;
      h.clock.current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 1));
      expect((await h.learn({ noCache: true })).statusCode).toBe(200);
    });

    it('gives a paid user its own, larger quota', async () => {
      const h = await setup(makeComplete().fn);
      const res = await h.learn({ noCache: true }, { tier: 'paid' });
      expect(res.json().quota).toEqual({ remaining: tiers.paid.aiLearns.count - 1, period: 'month' });
    });

    it('counts per user: another user has a quota of their own', async () => {
      const h = await setup(makeComplete().fn);
      for (let i = 0; i < 3; i++) await h.learn({ noCache: true });
      expect((await h.learn({ noCache: true })).statusCode).toBe(429);
      const other = testUserId(2);
      expect((await h.learn({ noCache: true }, { user: other })).statusCode).toBe(200);
      expect(await used(h, other)).toBe(1);
    });

    it('lifetime: never resets, and its counter has no date part', async () => {
      tiers.registered.aiLearns = { count: 2, period: 'lifetime' } satisfies AiLearnQuota;
      const h = await setup(makeComplete().fn);
      await h.learn({ noCache: true });
      await h.learn({ noCache: true });
      const third = await h.learn({ noCache: true });
      expect(third.statusCode).toBe(429);
      expect(third.json()).toEqual({ error: 'limitHit', limit: 'aiLearns', period: 'lifetime' });
      expect(await used(h, TEST_USER, 'lifetime')).toBe(2);

      h.clock.current = new Date(h.clock.current.getTime() + 400 * DAY_MS);
      expect((await h.learn({ noCache: true })).statusCode).toBe(429);
    });

    it('day: resets at UTC midnight', async () => {
      tiers.registered.aiLearns = { count: 2, period: 'day' } satisfies AiLearnQuota;
      const h = await setup(makeComplete().fn);
      await h.learn({ noCache: true });
      await h.learn({ noCache: true });
      const third = await h.learn({ noCache: true });
      expect(third.json()).toEqual({ error: 'limitHit', limit: 'aiLearns', period: 'day' });

      h.clock.current = new Date(h.clock.current.getTime() + DAY_MS);
      const next = await h.learn({ noCache: true });
      expect(next.statusCode).toBe(200);
      expect(next.json().quota).toEqual({ remaining: 1, period: 'day' });
    });

    it('unlimited: no cap, nothing to count, and the quota says so', async () => {
      tiers.registered.aiLearns = { count: 1, period: 'unlimited' } satisfies AiLearnQuota;
      const llm = makeComplete();
      const h = await setup(llm.fn);
      for (let i = 0; i < 6; i++) {
        const res = await h.learn({ noCache: true });
        expect(res.statusCode).toBe(200);
        expect(res.json().quota).toEqual({ remaining: null, period: 'unlimited' });
      }
      expect(llm.calls).toHaveLength(6);
    });

    it('never lets concurrent learns slip past the quota', async () => {
      const llm = makeComplete();
      const h = await setup(llm.fn);
      const results = await Promise.all(Array.from({ length: 6 }, () => h.learn({ noCache: true })));
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(3);
      expect(statuses.filter((s) => s === 429)).toHaveLength(3);
      expect(llm.calls).toHaveLength(3);
      expect(await used(h)).toBe(3);
    });

    it('does not count a malformed request, and a cache hit is free and served even with the quota spent', async () => {
      const llm = makeComplete();
      const h = await setup(llm.fn);
      expect((await h.learn({ payload: { not: 'a payload' } })).statusCode).toBe(400);
      expect(await used(h)).toBe(0);

      expect((await h.learn({})).statusCode).toBe(200); // caches the verified rules
      await h.learn({ noCache: true });
      await h.learn({ noCache: true });
      expect((await h.learn({ noCache: true })).statusCode).toBe(429);

      const hit = await h.learn({});
      expect(hit.statusCode).toBe(200);
      expect(hit.json()).toMatchObject({ cached: true, verified: true });
      expect(await used(h)).toBe(3);
    });
  });

  // ---------------------------------------------------------------- count on success

  describe('a learn counts once, when it succeeds', () => {
    it('counts at once when the server checks pass, and reports it', async () => {
      const h = await setup(makeComplete().fn);
      const res = await h.learn({ noCache: true });
      expect(res.json()).toMatchObject({ verified: true, counted: true, failedAttempts: 0 });
      expect(await used(h)).toBe(1);
    });

    it('does NOT count a learn whose checks failed: the unit is put back and the failure is recorded', async () => {
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup(llm.fn);
      const res = await h.learn({ noCache: true });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body).toMatchObject({ verified: false, counted: false, failedAttempts: 1, quota: { remaining: 3, period: 'month' } });
      expect(body.learnId).toEqual(expect.any(String));
      expect(llm.calls).toHaveLength(CALLS_PER_FAILED_LEARN);
      expect(await used(h)).toBe(0);
    });

    it('counts the failed learn once the browser reports it verified or accepted - and only once', async () => {
      const h = await setup(makeComplete({ json: wrongRoundingWireJson() }).fn);
      const { learnId } = (await h.learn({ noCache: true })).json();
      expect(await used(h)).toBe(0);

      const accepted = await outcome(h, learnId, 'accepted');
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ counted: true, quota: { remaining: 2, period: 'month' }, failedAttempts: 0, exhausted: false });
      expect(await used(h)).toBe(1);

      // Idempotent: repeating it, or reporting the other success kind, changes nothing.
      for (const again of ['accepted', 'verified', 'accepted'] as const) {
        const res = await outcome(h, learnId, again);
        expect(res.json()).toMatchObject({ counted: true, quota: { remaining: 2 }, failedAttempts: 0 });
      }
      expect(await used(h)).toBe(1);
    });

    it('does not count a learn twice when the browser reports verified for one the server already counted', async () => {
      const h = await setup(makeComplete().fn);
      const { learnId } = (await h.learn({ noCache: true })).json();
      expect(await used(h)).toBe(1);
      const res = await outcome(h, learnId, 'verified');
      expect(res.json()).toMatchObject({ counted: true, quota: { remaining: 2 } });
      expect(await used(h)).toBe(1);
    });

    it('never serves a result from the cache once the browser reported it failed', async () => {
      const llm = makeComplete();
      const h = await setup(llm.fn);
      const { learnId } = (await h.learn({})).json();
      expect(await h.handle.cacheEntryCount()).toBe(1);
      await outcome(h, learnId, 'failed');
      expect(await h.handle.cacheEntryCount()).toBe(0);
      const again = await h.learn({});
      expect(again.json().cached).toBe(false);
      expect(llm.calls).toHaveLength(2);
    });

    it('takes a counted learn back when the browser reports its full verification failed, and gives it back on a later success', async () => {
      const h = await setup(makeComplete().fn);
      const { learnId } = (await h.learn({ noCache: true })).json();
      expect(await used(h)).toBe(1);

      const failed = await outcome(h, learnId, 'failed');
      expect(failed.json()).toEqual({ counted: false, quota: { remaining: 3, period: 'month' }, failedAttempts: 1, exhausted: false });
      expect(await used(h)).toBe(0);
      // Idempotent.
      expect((await outcome(h, learnId, 'failed')).json()).toMatchObject({ counted: false, failedAttempts: 1 });
      expect(await used(h)).toBe(0);

      // The user then fixed the rules by hand and saved them: it counts, and the failure is taken back.
      const fixed = await outcome(h, learnId, 'accepted');
      expect(fixed.json()).toMatchObject({ counted: true, failedAttempts: 0, quota: { remaining: 2 } });
      expect(await used(h)).toBe(1);
      expect((await outcome(h, learnId, 'accepted')).json()).toMatchObject({ counted: true });
      expect(await used(h)).toBe(1);
    });

    it('counts a failed learn that the browser-triggered repair then fixes (a repair never counts on its own)', async () => {
      const wrong = wrongRoundingWireJson();
      const llm = scripted(wrong, wrong, wrong, correctRulesWireJson());
      const h = await setup(llm.fn);
      const first = (await h.learn({ noCache: true })).json();
      expect(first).toMatchObject({ verified: false, counted: false, failedAttempts: 1 });
      expect(await used(h)).toBe(0);

      const repair = await h.post('/api/learn/repair', {
        payload: basicPayload(),
        previousRules: first.rules,
        problems: first.problems,
        learnId: first.learnId,
      });
      expect(repair.statusCode).toBe(200);
      expect(repair.json()).toMatchObject({ verified: true, counted: true, failedAttempts: 0, quota: { remaining: 2 } });
      expect(await used(h)).toBe(1);
    });

    it('leaves a failed learn failed when its repair fails too (still one failed attempt, nothing counted)', async () => {
      const wrong = wrongRoundingWireJson();
      const h = await setup(scripted(wrong).fn);
      const first = (await h.learn({ noCache: true })).json();
      const repair = await h.post('/api/learn/repair', {
        payload: basicPayload(),
        previousRules: first.rules,
        problems: first.problems,
        learnId: first.learnId,
      });
      expect(repair.json()).toMatchObject({ verified: false, counted: false, failedAttempts: 1 });
      expect(await used(h)).toBe(0);
    });

    it('does not count a provider outage, and it is nobody\'s failed attempt', async () => {
      const h = await setup(async () => {
        throw new Error('provider down');
      });
      for (let i = 0; i < limits.learn.maxFailedAiAttempts + 2; i++) {
        const res = await h.learn({ noCache: true });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ rules: null, verified: false, counted: false, failedAttempts: 0 });
      }
      expect(await used(h)).toBe(0);
    });

    it('still counts a learn whose result was delivered when recording the ledger fails', async () => {
      const h = await setup(makeComplete().fn);
      h.handle.store.insertLlmCalls = async () => {
        throw new Error('ledger down'); // swallowed: the result was already paid for
      };
      expect((await h.learn({ noCache: true })).statusCode).toBe(200);
      expect(await used(h)).toBe(1);
    });
  });

  // ---------------------------------------------------------------- the outcome route

  describe('POST /api/learn/:learnId/outcome', () => {
    it('needs a learnId issued to the same user, and a known outcome', async () => {
      const h = await setup(makeComplete().fn);
      const { learnId } = (await h.learn({ noCache: true })).json();

      const stranger = await outcome(h, learnId, 'verified', testUserId(9));
      expect(stranger.statusCode).toBe(400);
      expect(stranger.json()).toEqual({ error: 'invalidLearnId' });
      for (const bad of ['not-a-learn-id', `${learnId}x`, 'a.b.c.d']) {
        expect((await outcome(h, bad, 'verified')).json()).toEqual({ error: 'invalidLearnId' });
      }
      for (const value of ['done', 1, null, undefined]) {
        const res = await outcome(h, learnId, value);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalidRequest' });
      }
      expect(await used(h)).toBe(1);
    });

    it('rejects an expired learnId', async () => {
      const h = await setup(makeComplete({ json: wrongRoundingWireJson() }).fn);
      const { learnId } = (await h.learn({ noCache: true })).json();
      h.clock.current = new Date(h.clock.current.getTime() + (limits.protection.learnIdTtlMinutes + 1) * 60_000);
      const res = await outcome(h, learnId, 'accepted');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalidLearnId' });
    });

    it('cannot be used to move a learn to another example pair (the group is inside the signed learnId)', async () => {
      const h = await setup(makeComplete({ json: wrongRoundingWireJson() }).fn);
      const { learnId } = (await h.learn({ noCache: true })).json();
      const [uuid, exp, , sig] = learnId.split('.') as [string, string, string, string];
      const res = await outcome(h, `${uuid}.${exp}.${'0'.repeat(24)}.${sig}`, 'verified');
      expect(res.json()).toEqual({ error: 'invalidLearnId' });
    });
  });

  // ---------------------------------------------------------------- the failure cap

  describe(`the stop after ${limits.learn.maxFailedAiAttempts} failed attempts on the same example pair`, () => {
    const cap = limits.learn.maxFailedAiAttempts;

    /** Fails attempts 1..cap-1 (200, verified false), returning the last learnId. */
    async function failUntilLast(h: Harness, user = TEST_USER, payload = basicPayload()): Promise<string> {
      let learnId = '';
      for (let attempt = 1; attempt < cap; attempt++) {
        const res = await h.learn({ payload, noCache: true }, { user });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ verified: false, counted: false, failedAttempts: attempt });
        learnId = res.json().learnId;
      }
      return learnId;
    }

    it('stops at the last failed attempt, counts it as ONE learn and says so', async () => {
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup(llm.fn);
      await failUntilLast(h);
      expect(await used(h)).toBe(0);

      const last = await h.learn({ noCache: true });
      expect(last.statusCode).toBe(409);
      expect(last.json()).toEqual({ error: 'aiAttemptsExhausted', counted: true });
      expect(await used(h)).toBe(1);
      expect(llm.calls).toHaveLength(cap * CALLS_PER_FAILED_LEARN);
    });

    it('then refuses further attempts on that pair without calling the AI or counting again', async () => {
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup(llm.fn);
      await failUntilLast(h);
      await h.learn({ noCache: true });
      const calls = llm.calls.length;

      for (let i = 0; i < 3; i++) {
        const again = await h.learn({ noCache: true });
        expect(again.statusCode).toBe(409);
        expect(again.json()).toEqual({ error: 'aiAttemptsExhausted', counted: false });
      }
      expect(llm.calls).toHaveLength(calls);
      expect(await used(h)).toBe(1);
    });

    it('refuses a browser repair of that pair too', async () => {
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup(llm.fn);
      const learnId = await failUntilLast(h);
      await h.learn({ noCache: true });
      const calls = llm.calls.length;

      const res = await h.post('/api/learn/repair', { payload: basicPayload(), previousRules: correctRules(), problems: [], learnId });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'aiAttemptsExhausted', counted: false });
      expect(llm.calls).toHaveLength(calls);
    });

    it('is per example pair: another structure, or another user, is unaffected', async () => {
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup(llm.fn);
      await failUntilLast(h);
      await h.learn({ noCache: true });

      const other = basicPayload();
      other.output.columns[1] = { i: 1, header: 'Grand total', type: 'decimal' };
      const differentPair = await h.learn({ payload: other, noCache: true });
      expect(differentPair.statusCode).toBe(200);
      expect(differentPair.json()).toMatchObject({ verified: false, failedAttempts: 1 });

      const otherUser = await h.learn({ noCache: true }, { user: testUserId(2) });
      expect(otherUser.statusCode).toBe(200);
      expect(otherUser.json()).toMatchObject({ failedAttempts: 1 });
    });

    it('keeps the group tag of the learnId in the failure counter key (owner + structure)', async () => {
      const h = await setup(makeComplete({ json: wrongRoundingWireJson() }).fn);
      const { learnId } = (await h.learn({ noCache: true })).json();
      expect(await h.handle.counter(aiFailKey(`user:${TEST_USER}`, groupOfLearnId(learnId)))).toBe(1);
    });

    it('takes a failure back when the same learn later succeeds (the cap is on failed attempts)', async () => {
      const wrong = wrongRoundingWireJson();
      const h = await setup(scripted(wrong).fn);
      const { learnId } = (await failOnce(h)) as { learnId: string };
      await outcome(h, learnId, 'accepted'); // the user fixed it by hand
      expect(await h.handle.counter(aiFailKey(`user:${TEST_USER}`, groupOfLearnId(learnId)))).toBe(0);
      expect(await used(h)).toBe(1);
    });

    it.skipIf(kit.name === 'mongo')('forgets the failed attempts after the configured window', async () => {
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup(llm.fn);
      await failUntilLast(h);
      await h.learn({ noCache: true });
      expect((await h.learn({ noCache: true })).statusCode).toBe(409);

      h.clock.current = new Date(h.clock.current.getTime() + (limits.learn.failedAttemptsWindowHours + 1) * 60 * 60 * 1000);
      const retry = await h.learn({ noCache: true });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ failedAttempts: 1 });
    });

    it('takes its unit from the quota even for the attempt that ends the pair (it is the one learn the pair counts as)', async () => {
      tiers.registered.aiLearns = { count: 1, period: 'month' } satisfies AiLearnQuota;
      const h = await setup(makeComplete({ json: wrongRoundingWireJson() }).fn);
      await failUntilLast(h);
      const last = await h.learn({ noCache: true });
      expect(last.json()).toEqual({ error: 'aiAttemptsExhausted', counted: true });
      expect(await used(h)).toBe(1);
      // ...and the quota of 1 is now spent.
      const next = await h.learn({ noCache: true, payload: otherPair() });
      expect(next.statusCode).toBe(429);
    });

    it('counts hold-out failures the browser reports toward the same stop', async () => {
      const h = await setup(makeComplete().fn);
      // Each learn passes the server checks (counted), each is then reported failed by the browser (given back, recorded).
      for (let attempt = 1; attempt < cap; attempt++) {
        const { learnId } = (await h.learn({ noCache: true })).json();
        const res = await outcome(h, learnId, 'failed');
        expect(res.json()).toMatchObject({ counted: false, failedAttempts: attempt, exhausted: false });
      }
      const { learnId } = (await h.learn({ noCache: true })).json();
      const res = await outcome(h, learnId, 'failed');
      expect(res.json()).toMatchObject({ counted: true, failedAttempts: cap, exhausted: true });
      expect(await used(h)).toBe(1);

      const after = await h.learn({ noCache: true });
      expect(after.statusCode).toBe(409);
      expect(after.json()).toEqual({ error: 'aiAttemptsExhausted', counted: false });
    });
  });

  async function failOnce(h: Harness): Promise<{ learnId: string }> {
    const res = await h.learn({ noCache: true });
    expect(res.json().verified).toBe(false);
    return res.json();
  }
}

/** A payload with a different structure than `basicPayload()`. */
function otherPair() {
  const payload = basicPayload();
  payload.output.columns[1] = { i: 1, header: 'Sum', type: 'decimal' };
  return payload;
}

describe('AI-learn quota and counting (in-memory store)', () => {
  defineQuotaSuite(memoryKit);
});

describe.skipIf(!mongoUri)('AI-learn quota and counting (MongoDB)', () => {
  defineQuotaSuite(mongoKit());
});
