// POST /api/learn and POST /api/learn/repair (SPEC 5 A steps 5-6), registered in every environment
// - production included - because they are now protected (SPEC 9.5, 11, 15):
//
//   per-IP request rate limit -> body shape -> Turnstile (anonymous) -> owner's structure cache
//   -> daily budgets (kill switch / anonymous) -> per-tier learn limits -> the LLM -> ledger, spend,
//   cache write.
//
// Every refusal is a stable code (`{ error, limit? }`, see shared `API_ERROR_CODES`); the web maps it to
// UI text. SPEC 15: this file never logs a payload, a cell value, a token, or `previousRules`/`problems`
// content - only counts, ids and error names.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  LearnPayloadSchema,
  LearnResultSchema,
  limits,
  promptVersion,
  type ApiErrorBody,
  type LearnPayload,
  type LearnResponse,
  type LearnResult,
  type RepairProblem,
  type RepairResponse,
} from '@formatai/shared';
import type { Env } from '../env.js';
import { countProblems, learn, repairFromBrowser, type CompleteFn, type LearnOutcome, type LlmCallRecord } from '../learn/index.js';
import type { LlmCallDoc } from '../models.js';
import { BUDGET_STATUS, checkBudgets, totalCostUsd } from '../protection/budget.js';
import { isCacheable, learnCacheKey } from '../protection/cache.js';
import { identityOf, ownerOf, type Identity } from '../protection/identity.js';
import { hashIp, normalizeIp } from '../protection/ip.js';
import { dayKey, learnCounterSpecs, repairKey, tierOf } from '../protection/keys.js';
import { issueLearnId, verifyLearnId } from '../protection/learnId.js';
import type { Protection } from '../protection/index.js';
import { reserveLearn } from '../protection/reserve.js';

export interface RegisterLearnRoutesOptions {
  env: Env;
  protection: Protection;
  /** Dependency injection for tests - see `learn.ts`'s `LearnOptions.complete`.
   * Defaults to the real `complete()`. */
  complete?: CompleteFn;
}

interface LearnRequestBody {
  payload?: unknown;
  turnstileToken?: unknown;
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
function ledgerDocs(learnId: string, identity: Identity, calls: readonly LlmCallRecord[], now: Date): LlmCallDoc[] {
  // M3: signed-in identities also set `userId` here.
  const who = identity.kind === 'anon' ? { anonId: identity.anonId } : {};
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
    ...(identity.kind === 'anon' ? { anonId: identity.anonId } : {}),
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
  const { store, turnstile, secret } = protection;

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
    if (!outcome.verified || !outcome.rules || !isCacheable(outcome.rules, payload.masking)) return;
    try {
      await store.putCachedRules({ owner, key, rules: outcome.rules, promptVersion, createdAt: now });
    } catch (err) {
      logFailure('failed to write the learn cache', err);
    }
  };

  app.post('/api/learn', { onRequest: rateLimit }, async (req, reply) => {
    const body = req.body as LearnRequestBody | undefined;
    const parsedPayload = LearnPayloadSchema.safeParse(body?.payload);
    if (!parsedPayload.success) return fail(reply, 400, { error: 'invalidPayload' });
    const payload = parsedPayload.data as unknown as LearnPayload;

    const identity = identityOf(req);
    const owner = ownerOf(identity);
    const now = protection.now();

    // SPEC 9.5: anonymous learns need a valid Turnstile token. (Signed-in users, M3, skip it.)
    if (identity.kind === 'anon' && !(await turnstile.verify(body?.turnstileToken, req.ip))) {
      return fail(reply, 403, { error: 'turnstileFailed' });
    }

    // SPEC 9.5 cache: a hit costs no learn and no LLM call - so it is served even when limits or budgets
    // are spent. `noCache` lets the browser insist on a fresh learn (e.g. its verification rejected a hit).
    const cacheKey = learnCacheKey(payload);
    if (body?.noCache !== true) {
      const started = Date.now();
      const notBefore = new Date(now.getTime() - limits.cache.ttlDays * DAY_MS);
      const saved = LearnResultSchema.safeParse(await store.getCachedRules(owner, cacheKey, notBefore));
      // Re-checked on read too: an entry written under another masking rule set must not be served.
      if (saved.success && isCacheable(saved.data as LearnResult, payload.masking)) {
        try {
          await store.insertLlmCalls([cacheHitLedgerDoc(randomUUID(), identity, payload, now, Date.now() - started)]);
        } catch (err) {
          logFailure('failed to write the llm_calls ledger', err);
        }
        const hit: LearnResponse = {
          rules: saved.data as LearnResult,
          verified: true,
          problems: [],
          cached: true,
        };
        return reply.send(hit);
      }
    }

    // SPEC 9.5 budgets, then the per-tier learn limits - both BEFORE any LLM call.
    const refusal = await budgetRefusal(identity, now);
    if (refusal) return fail(reply, refusal.status, refusal.body);

    const reservation = await reserveLearn(store, learnCounterSpecs(identity, hashIp(req.ip, secret), now));
    if (!reservation.ok) return fail(reply, 429, { error: 'limitHit', limit: reservation.limitCode });

    const outcome = await learn(payload, { tier: tierOf(identity), env, complete });

    const learnId = issueLearnId(secret, owner, now, limits.protection.learnIdTtlMinutes);
    const ledgerId = learnId.split('.', 1)[0]!;
    await recordCalls(ledgerId, identity, outcome.calls, now);
    await saveToCache(owner, cacheKey, payload, outcome, now);

    const res: LearnResponse = {
      rules: outcome.rules,
      verified: outcome.verified,
      problems: outcome.problems,
      learnId,
      cached: false,
    };
    return reply.send(res);
  });

  app.post('/api/learn/repair', { onRequest: rateLimit }, async (req, reply) => {
    const body = req.body as RepairRequestBody | undefined;
    const parsedPayload = LearnPayloadSchema.safeParse(body?.payload);
    if (!parsedPayload.success) return fail(reply, 400, { error: 'invalidPayload' });
    const parsedRules = LearnResultSchema.safeParse(body?.previousRules);
    if (!parsedRules.success) return fail(reply, 400, { error: 'invalidPreviousRules' });
    if (!isRepairProblemArray(body?.problems)) return fail(reply, 400, { error: 'invalidProblems' });

    const identity = identityOf(req);
    const owner = ownerOf(identity);
    const now = protection.now();

    // SPEC 9.3: a repair belongs to a learn this owner really ran (signed, owner-bound, unexpired).
    const learnCheck = verifyLearnId(secret, owner, body?.learnId, now);
    if (!learnCheck.ok) return fail(reply, 400, { error: 'invalidLearnId' });

    const refusal = await budgetRefusal(identity, now);
    if (refusal) return fail(reply, refusal.status, refusal.body);

    // At most ONE browser-triggered repair per learn, and it is not a new learn: the learn counters
    // are untouched. The `repair:<uuid>` counter is what makes "once" atomic.
    const uses = await store.incrementCounter(
      repairKey(learnCheck.uuid),
      1,
      new Date(learnCheck.expiresAt.getTime() + HOUR_MS),
    );
    if (uses > limits.llm.browserRepairCalls) return fail(reply, 429, { error: 'limitHit', limit: 'repairsPerLearn' });

    const payload = parsedPayload.data as unknown as LearnPayload;
    const previousRules: LearnResult = parsedRules.data;
    const outcome = await repairFromBrowser(payload, previousRules, body.problems, {
      tier: tierOf(identity),
      env,
      complete,
    });

    await recordCalls(learnCheck.uuid, identity, outcome.calls, now);
    // The repaired rules replace the owner's entry for this structure, so a later cache hit returns
    // the better version rather than the one the browser had to repair.
    await saveToCache(owner, learnCacheKey(payload), payload, outcome, now);

    const res: RepairResponse = {
      rules: outcome.rules,
      verified: outcome.verified,
      problems: outcome.problems,
    };
    return reply.send(res);
  });
}
