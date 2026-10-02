// POST /api/learn, POST /api/learn/repair and POST /api/learn/:learnId/outcome (SPEC 5 A steps 5-6, 21 v5),
// registered in every environment - production included - because they are protected (SPEC 9.5, 11, 15):
//
//   per-IP request rate limit -> signed in? (the AI is for signed-in users only, 403 signInForAi) -> body
//   shape -> owner's structure cache -> the failed-attempt cap of this example pair -> daily budgets (kill
//   switch) -> the user's AI-learn quota (reserved) -> the LLM -> ledger, spend, cache write -> what the
//   learn counted as (see `protection/aiLearns.ts`).
//
// DECISION: completion mode (LEARN_PROMPT "Completing a partial rules file"): a payload with `complete` is a learn like any other (same quota, same
// failed-attempt cap on its example pair, same outcome report), except that it never touches the structure cache - its answer contains
// the user's own rules, so it is neither served from nor stored in it.
//
// learn-v7 (issue #40): an answer may carry two optional notes on an unsupported column - a value-free function request and a plain-language
// explanation (see `learn/notes.ts`). The request is value-filtered and recorded in `function_requests` before the answer goes back; the
// explanation goes back to the browser (masked) and NOWHERE else: `stripAiNotes` takes both notes out before the structure cache is written.
//
// Every refusal is a stable code (`{ error, limit?, period?, counted? }`, see shared `API_ERROR_CODES`); the web maps it to
// UI text. SPEC 15: this file never logs a payload, a cell value, a token, or `previousRules`/`problems`
// content - only counts, ids and error names.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  LearnPayloadSchema,
  LearnResultSchema,
  limits,
  promptVersion,
  stripAiNotes,
  type ApiErrorBody,
  type LearnOutcomeResponse,
  type LearnQuotaResponse,
  type LearnPayload,
  type LearnResponse,
  type LearnResult,
  type RepairProblem,
  type RepairResponse,
} from '@formatai/shared';
import type { Env } from '../env.js';
import { countProblems, learn, readCompleteFixed, recordFunctionRequests, repairFromBrowser, requestKeysOf, type CompleteFn, type LearnOutcome, type LlmCallRecord } from '../learn/index.js';
import type { LlmCallDoc } from '../models.js';
import { BUDGET_STATUS, checkBudgets, totalCostUsd } from '../protection/budget.js';
import { isCacheable, learnCacheKey } from '../protection/cache.js';
import {
  groupOf,
  markFailed,
  markSucceeded,
  pairExhausted,
  quotaState,
  releaseReservation,
  settleLearn,
  stateOf,
  type AiLearnCtx,
  type Settled,
} from '../protection/aiLearns.js';
import { identityOf, ownerOf, type Identity } from '../protection/identity.js';
import { normalizeIp } from '../protection/ip.js';
import { aiQuotaOf, dayKey, repairKey, tierOf } from '../protection/keys.js';
import { issueLearnId, verifyLearnId } from '../protection/learnId.js';
import type { Protection } from '../protection/index.js';
import { reserveLearn } from '../protection/reserve.js';
import { objectIdOf } from '../registry/ids.js';

export interface RegisterLearnRoutesOptions {
  env: Env;
  protection: Protection;
  /** Dependency injection for tests - see `learn.ts`'s `LearnOptions.complete`.
   * Defaults to the real `complete()`. */
  complete?: CompleteFn;
  /** Tests: who is calling (default: `identityOf`, the session / anonId cookie). */
  identify?: (req: FastifyRequest) => Identity;
}

interface LearnRequestBody {
  payload?: unknown;
  noCache?: unknown;
}

interface RepairRequestBody {
  payload?: unknown;
  previousRules?: unknown;
  problems?: unknown;
  learnId?: unknown;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function fail(reply: FastifyReply, status: number, body: ApiErrorBody): FastifyReply {
  return reply.code(status).send(body);
}

function isRepairProblemArray(value: unknown): value is RepairProblem[] {
  return Array.isArray(value);
}

/** SPEC 13 `llm_calls`: one document per call this learn made. `cacheHit` is the structure cache
 * (SPEC 9.5) - false for a real call, whatever the provider's own prompt cache did (`tokensCached`). */
function whoOf(identity: Identity): Pick<LlmCallDoc, 'anonId' | 'userId'> {
  if (identity.kind === 'anon') return { anonId: identity.anonId };
  const userId = objectIdOf(identity.userId);
  return { ...(identity.anonId ? { anonId: identity.anonId } : {}), ...(userId ? { userId } : {}) };
}

function ledgerDocs(learnId: string, identity: Identity, calls: readonly LlmCallRecord[], now: Date): LlmCallDoc[] {
  const who = whoOf(identity);
  return calls.map((c) => ({
    ts: now,
    ...who,
    learnId,
    purpose: c.purpose,
    model: c.model,
    promptVersion: c.promptVersion,
    masking: c.masking,
    tokensIn: c.tokensIn,
    tokensOut: c.tokensOut,
    tokensCached: c.tokensCached,
    costUsd: c.costUsd,
    latencyMs: c.latencyMs,
    outcome: c.outcome,
    cacheHit: false,
    problemCounts: c.problemCounts,
  }));
}

/** The ledger entry for a structure-cache hit: no model, no tokens, no cost, outcome `cacheHit`. */
function cacheHitLedgerDoc(learnId: string, identity: Identity, payload: LearnPayload, now: Date, latencyMs: number): LlmCallDoc {
  return {
    ts: now,
    ...whoOf(identity),
    learnId,
    purpose: 'learn',
    model: 'cache',
    promptVersion,
    masking: payload.masking,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    costUsd: 0,
    latencyMs,
    outcome: 'cacheHit',
    cacheHit: true,
    problemCounts: countProblems([]),
  };
}

export function registerLearnRoutes(app: FastifyInstance, opts: RegisterLearnRoutesOptions): void {
  const { env, protection, complete } = opts;
  const identify = opts.identify ?? identityOf;
  const { store, secret } = protection;

  const logFailure = (what: string, err: unknown): void => {
    // Names only: an error's message could echo document contents (SPEC 15).
    app.log.error({ errName: err instanceof Error ? err.name : 'unknown' }, what);
  };

  /** Per-IP request rate limit (config): runs before the body is even parsed. */
  const rateLimit = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const verdict = protection.rateLimiter.hit(normalizeIp(req.ip));
    if (verdict.allowed) return undefined;
    void reply.header('retry-after', String(verdict.retryAfterSec));
    return fail(reply, 429, { error: 'rateLimited' });
  };

  /** SPEC 9.5 budgets. Returns the refusal to send, or null when the day still has budget. */
  const budgetRefusal = async (
    identity: Identity,
    now: Date,
  ): Promise<{ status: number; body: ApiErrorBody } | null> => {
    const verdict = checkBudgets(await store.getSpend(dayKey(now)), identity.kind === 'anon');
    if (verdict === 'ok') return null;
    return { status: BUDGET_STATUS[verdict], body: { error: verdict } };
  };

  /** After the LLM calls: the ledger and the day's spend. Failing to record must not throw away a
   * result the user already paid a learn for, so failures are logged and swallowed. */
  const recordCalls = async (
    learnId: string,
    identity: Identity,
    calls: readonly LlmCallRecord[],
    now: Date,
  ): Promise<void> => {
    try {
      await store.insertLlmCalls(ledgerDocs(learnId, identity, calls, now));
    } catch (err) {
      logFailure('failed to write the llm_calls ledger', err);
    }
    try {
      const spent = totalCostUsd(calls);
      if (spent > 0) await store.addSpend(dayKey(now), spent, identity.kind === 'anon');
    } catch (err) {
      logFailure('failed to record spend', err);
    }
  };

  /** DECISION (privacy): only the owner's own entry is ever read or written - see protection/cache.ts. */
  const saveToCache = async (
    owner: string,
    key: string,
    payload: LearnPayload,
    outcome: LearnOutcome,
    now: Date,
  ): Promise<void> => {
    if (payload.complete !== undefined) return; // completion: the answer holds the user's own rules (see the file header)
    if (!outcome.verified || !outcome.rules) return;
    // SPEC 15: the AI's explanation and function request are never cached (the guess may name values; the request is recorded elsewhere).
    const rules = stripAiNotes(outcome.rules);
    if (!isCacheable(rules, payload.masking)) return;
    try {
      await store.putCachedRules({ owner, key, rules, promptVersion, createdAt: now });
    } catch (err) {
      logFailure('failed to write the learn cache', err);
    }
  };

  /**
   * learn-v7: the function requests of this answer are value-filtered and recorded (`notes.ts`); the answer comes back without the ones
   * that were refused. `previous` (a repair): requests its answer already carried were recorded then and are not counted again.
   */
  const withRecordedRequests = async (
    outcome: LearnOutcome,
    payload: LearnPayload,
    owner: string,
    now: Date,
    previous?: LearnResult,
  ): Promise<LearnOutcome> => {
    if (!outcome.rules) return outcome;
    const noted = await recordFunctionRequests(outcome.rules, payload, {
      store,
      secret,
      owner,
      now,
      ...(previous ? { alreadyRecorded: requestKeysOf(previous) } : {}),
      onError: (err) => logFailure('failed to record a function request', err),
    });
    return noted.rules === outcome.rules ? outcome : { ...outcome, rules: noted.rules };
  };

  /** At least one model answered: a provider outage (every call an `error:*`) is nobody's failed attempt. */
  const modelAnswered = (calls: readonly LlmCallRecord[]): boolean => calls.some((c) => !c.outcome.startsWith('error:'));

  const ctxOf = (
    identity: Extract<Identity, { kind: 'user' }>,
    now: Date,
    check: { uuid: string; expiresAt: Date; group: string },
  ): AiLearnCtx => ({
    store,
    owner: ownerOf(identity),
    quota: aiQuotaOf(identity, now),
    group: check.group,
    uuid: check.uuid,
    learnExpiresAt: check.expiresAt,
    now,
  });

  app.post('/api/learn', { onRequest: rateLimit }, async (req, reply) => {
    // SPEC 21 v5: the AI step is for signed-in users only - answered before anything else costs anything.
    // (Free users get everything that runs locally, and the local result first; the web shows that.)
    const identity = identify(req);
    if (identity.kind !== 'user') return fail(reply, 403, { error: 'signInForAi' });

    const body = req.body as LearnRequestBody | undefined;
    const parsedPayload = LearnPayloadSchema.safeParse(body?.payload);
    if (!parsedPayload.success) return fail(reply, 400, { error: 'invalidPayload' });
    const payload = parsedPayload.data as unknown as LearnPayload;
    if (payload.complete && !readCompleteFixed(payload.complete)) return fail(reply, 400, { error: 'invalidPayload' });

    const owner = ownerOf(identity);
    const now = protection.now();

    // SPEC 9.5 cache: a hit costs no learn and no LLM call - so it is served even when limits or budgets
    // are spent. `noCache` lets the browser insist on a fresh learn (e.g. its verification rejected a hit).
    // (Never in completion mode: see the file header.)
    const cacheKey = learnCacheKey(payload);
    if (body?.noCache !== true && payload.complete === undefined) {
      const started = Date.now();
      const notBefore = new Date(now.getTime() - limits.cache.ttlDays * DAY_MS);
      const saved = LearnResultSchema.safeParse(await store.getCachedRules(owner, cacheKey, notBefore));
      // Re-checked on read too: an entry written under another masking rule set must not be served.
      if (saved.success && isCacheable(stripAiNotes(saved.data as LearnResult), payload.masking)) {
        try {
          await store.insertLlmCalls([cacheHitLedgerDoc(randomUUID(), identity, payload, now, Date.now() - started)]);
        } catch (err) {
          logFailure('failed to write the llm_calls ledger', err);
        }
        const hit: LearnResponse = {
          rules: stripAiNotes(saved.data as LearnResult),
          verified: true,
          problems: [],
          cached: true,
        };
        return reply.send(hit);
      }
    }

    // SPEC 21 v5 item 3: the same example pair already failed as often as the cap allows - no more AI for it
    // (the answer that reached the cap already counted it once).
    const group = groupOf(cacheKey);
    if (await pairExhausted(store, owner, group)) return fail(reply, 409, { error: 'aiAttemptsExhausted', counted: false });

    // SPEC 9.5 budgets, then the user's AI-learn quota - both BEFORE any LLM call. The quota unit is
    // reserved now and settled below (kept when the learn counts, put back when it does not).
    const refusal = await budgetRefusal(identity, now);
    if (refusal) return fail(reply, refusal.status, refusal.body);

    const quota = aiQuotaOf(identity, now);
    if (quota.spec) {
      const reservation = await reserveLearn(store, [quota.spec]);
      if (!reservation.ok) return fail(reply, 429, { error: 'limitHit', limit: reservation.limitCode, period: quota.period });
    }

    const learnId = issueLearnId(secret, owner, now, limits.protection.learnIdTtlMinutes, group);
    const check = verifyLearnId(secret, owner, learnId, now);
    if (!check.ok) throw new Error('issued a learnId that does not verify'); // unreachable: signed just above
    const ctx = ctxOf(identity, now, check);

    let outcome: LearnOutcome;
    try {
      outcome = await withRecordedRequests(await learn(payload, { tier: tierOf(identity), env, complete }), payload, owner, now);
    } catch (err) {
      // Something threw past the provider layer: nothing was learned, nothing counts.
      await releaseReservation(ctx).catch((e: unknown) => logFailure('failed to release an AI learn', e));
      throw err;
    }

    await recordCalls(check.uuid, identity, outcome.calls, now);
    await saveToCache(owner, cacheKey, payload, outcome, now);

    const settled = await settleLearn(ctx, { answered: modelAnswered(outcome.calls), verified: outcome.verified });
    if (settled.exhausted && settled.counted && !outcome.verified) {
      // This attempt was the one that reached the cap: stop, and say it counted as one learn.
      return fail(reply, 409, { error: 'aiAttemptsExhausted', counted: true });
    }
    if (settled.exhausted && !outcome.verified) return fail(reply, 409, { error: 'aiAttemptsExhausted', counted: false });

    const res: LearnResponse = {
      rules: outcome.rules,
      verified: outcome.verified,
      problems: outcome.problems,
      learnId,
      cached: false,
      counted: settled.counted,
      failedAttempts: settled.failedAttempts,
      quota: await quotaState(store, ctx.quota),
    };
    return reply.send(res);
  });

  app.post('/api/learn/repair', { onRequest: rateLimit }, async (req, reply) => {
    const identity = identify(req);
    if (identity.kind !== 'user') return fail(reply, 403, { error: 'signInForAi' });

    const body = req.body as RepairRequestBody | undefined;
    const parsedPayload = LearnPayloadSchema.safeParse(body?.payload);
    if (!parsedPayload.success) return fail(reply, 400, { error: 'invalidPayload' });
    if ((parsedPayload.data as unknown as LearnPayload).complete && !readCompleteFixed((parsedPayload.data as unknown as LearnPayload).complete!)) {
      return fail(reply, 400, { error: 'invalidPayload' });
    }
    const parsedRules = LearnResultSchema.safeParse(body?.previousRules);
    if (!parsedRules.success) return fail(reply, 400, { error: 'invalidPreviousRules' });
    if (!isRepairProblemArray(body?.problems)) return fail(reply, 400, { error: 'invalidProblems' });

    const owner = ownerOf(identity);
    const now = protection.now();

    // SPEC 9.3: a repair belongs to a learn this owner really ran (signed, owner-bound, unexpired).
    const learnCheck = verifyLearnId(secret, owner, body?.learnId, now);
    if (!learnCheck.ok) return fail(reply, 400, { error: 'invalidLearnId' });

    if (await pairExhausted(store, owner, learnCheck.group)) {
      return fail(reply, 409, { error: 'aiAttemptsExhausted', counted: false });
    }

    const refusal = await budgetRefusal(identity, now);
    if (refusal) return fail(reply, refusal.status, refusal.body);

    // At most ONE browser-triggered repair per learn, and it is not a new learn: the quota is untouched.
    // The `repair:<uuid>` counter is what makes "once" atomic.
    const uses = await store.incrementCounter(
      repairKey(learnCheck.uuid),
      1,
      new Date(learnCheck.expiresAt.getTime() + HOUR_MS),
    );
    if (uses > limits.llm.browserRepairCalls) return fail(reply, 429, { error: 'limitHit', limit: 'repairsPerLearn' });

    const payload = parsedPayload.data as unknown as LearnPayload;
    const previousRules: LearnResult = parsedRules.data;
    const outcome = await withRecordedRequests(
      await repairFromBrowser(payload, previousRules, body.problems, {
        tier: tierOf(identity),
        env,
        complete,
      }),
      payload,
      owner,
      now,
      previousRules,
    );

    await recordCalls(learnCheck.uuid, identity, outcome.calls, now);
    // The repaired rules replace the owner's entry for this structure, so a later cache hit returns
    // the better version rather than the one the browser had to repair.
    await saveToCache(owner, learnCacheKey(payload), payload, outcome, now);

    // A repair that passes the server checks makes the learn a success (a repair never counts on its own);
    // one that does not changes nothing - the learn's failure was recorded when it failed.
    const ctx = ctxOf(identity, now, learnCheck);
    const settled: Settled = outcome.verified ? await markSucceeded(ctx) : await stateOf(ctx);

    const res: RepairResponse = {
      rules: outcome.rules,
      verified: outcome.verified,
      problems: outcome.problems,
      counted: settled.counted,
      failedAttempts: settled.failedAttempts,
      quota: await quotaState(store, ctx.quota),
    };
    return reply.send(res);
  });

  // SPEC 21 v5 item 3: the browser reports how the learn ended after its own full verification. Cheap and
  // idempotent (the learnId is signed and the state moves by compare-and-set), so it is not rate limited.
  app.post('/api/learn/:learnId/outcome', async (req, reply) => {
    const identity = identify(req);
    if (identity.kind !== 'user') return fail(reply, 403, { error: 'signInForAi' });

    const outcome = (req.body as { outcome?: unknown } | undefined)?.outcome;
    if (outcome !== 'verified' && outcome !== 'accepted' && outcome !== 'failed') {
      return fail(reply, 400, { error: 'invalidRequest' });
    }

    const owner = ownerOf(identity);
    const now = protection.now();
    const check = verifyLearnId(secret, owner, (req.params as { learnId?: string }).learnId, now);
    if (!check.ok) return fail(reply, 400, { error: 'invalidLearnId' });

    const ctx = ctxOf(identity, now, check);
    if (outcome === 'failed') {
      // The result did not match the example: never serve it again from the structure cache.
      await store.deleteCachedRules(owner, check.group).catch((err: unknown) => logFailure('failed to evict the learn cache', err));
    }
    const settled = outcome === 'failed' ? await markFailed(ctx) : await markSucceeded(ctx);
    const res: LearnOutcomeResponse = {
      counted: settled.counted,
      quota: await quotaState(store, ctx.quota),
      failedAttempts: settled.failedAttempts,
      exhausted: settled.exhausted,
    };
    return reply.send(res);
  });

  // SPEC 21 v5 item 2: what is left of the user's AI learns, so the account menu can say so without a learn.
  app.get('/api/learn/quota', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const identity = identify(req);
    if (identity.kind !== 'user') return fail(reply, 403, { error: 'signInForAi' });
    const res: LearnQuotaResponse = { quota: await quotaState(store, aiQuotaOf(identity, protection.now())) };
    return reply.send(res);
  });
}
