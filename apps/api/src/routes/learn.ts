// POST /api/learn, POST /api/learn/repair and POST /api/learn/:learnId/outcome (SPEC 5 A steps 5-6, 21 v5),
// registered in every environment - production included - because they are protected (SPEC 9.5, 11, 15):
//
//   per-IP request rate limit -> signed in? (the AI is for signed-in users only, 403 signInForAi) -> body
//   shape and the payload caps -> owner's structure cache -> the failed-attempt cap of this example pair -> daily budgets (kill
//   switch) -> the user's AI-learn quota (reserved) -> the LLM -> ledger, spend, cache write -> what the
//   learn counted as (see `protection/aiLearns.ts`). One `admit()` runs these for /api/learn, /step and /repair alike.
//
// The learning loop (SPEC 9.3): /api/learn/repair is one round - up to `limits.llm.browserRepairCalls` per learnId, each carrying every row
// the browser sent so far (`rows`, size-checked here), the answer checked on the samples plus all of them, and all of them one AI learn.
//
// DECISION: completion mode (LEARN_PROMPT "Completing a partial rules file"): a payload with `complete` is a learn like any other (same quota, same
// failed-attempt cap on its example pair, same outcome report), except that it never touches the structure cache - its answer contains
// the user's own rules, so it is neither served from nor stored in it.
//
// AI code checks (learn-v9, SPEC 21 v14; docs/proposals/ai-code-checks.md): for the learns `LEARN_CHECKS` gives learn-v9 to (off / admin /
// all; `limits.learn.checks.mode`), /api/learn may answer with CHECKS instead of the rules: `{ checks, droppedChecks?, learnId }`, no rules.
// The browser answers them on every row and sends POST /api/learn/step `{ token: learnId, payload, rounds }` - the payload and every round so
// far - and the AI step is called again with all of it: more checks while rounds are left, then the rules. The server stays stateless (the
// browser resends everything) and keeps the caps by the signed learnId: a step counter per learn (`step:<uuid>`, at most
// `limits.learn.checks.maxRounds`), the rounds' shape, rows and the payload byte cap on the whole body (`stepFits`). Quota: still ONE learn,
// counted on success - DECISION: the unit reserved for a call that answers with checks is put back at once (an abandoned learn costs
// nothing), and each step reserves it again before its call, so a user with no learn left gets no step either; the step that brings the
// rules settles the learn exactly as /api/learn does. A learn whose rounds are non-empty is never stored in the structure cache, and the
// cache never answers a step. The repairs of a learn-v9 learn use learn-v9 too (same system prompt, same schema: the cache).
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
  CheckRoundsSchema,
  learnChecksModeOf,
  LearnPayloadSchema,
  LearnResultSchema,
  limits,
  loopRowsFit,
  LoopRowsSchema,
  payloadFits,
  promptVersion,
  stepFits,
  stripAiNotes,
  sumEstimates,
  withRows,
  type ApiErrorBody,
  type CheckRound,
  type PromptVersion,
  type StepResponse,
  type LearnOutcomeResponse,
  type LearnQuotaResponse,
  type LearnPayload,
  type LearnResponse,
  type LearnResult,
  type RepairProblem,
  type RepairResponse,
  type Sample,
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
import { aiQuotaOf, dayKey, repairKey, stepKey, tierOf } from '../protection/keys.js';
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
  rulesNow?: unknown;
}

interface StepRequestBody {
  token?: unknown;
  payload?: unknown;
  rounds?: unknown;
}

interface RepairRequestBody {
  payload?: unknown;
  previousRules?: unknown;
  problems?: unknown;
  learnId?: unknown;
  rows?: unknown;
  overfitRepaired?: unknown;
  rounds?: unknown;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type UserIdentity = Extract<Identity, { kind: 'user' }>;

/** A request refused: the HTTP status and its stable error body. */
interface Refusal {
  status: number;
  body: ApiErrorBody;
}

const INVALID_PAYLOAD: Refusal = { status: 400, body: { error: 'invalidPayload' } };
const INVALID_ROWS: Refusal = { status: 400, body: { error: 'invalidRows' } };
const INVALID_ROUNDS: Refusal = { status: 400, body: { error: 'invalidRounds' } };

/** What one AI route asks of `admit` besides what every one of them checks (see `admit`). */
interface AdmitSpec {
  /** The request body's `payload`, as sent. */
  payload: unknown;
  /** The route's own gate on who may call it (false: 400 `invalidRequest`). */
  allow?: (identity: UserIdentity) => boolean;
  /** The rest of the body, once the payload parsed (rows, rounds, the previous rules ...): a refusal, or null. Nothing has been read yet. */
  body?: (payload: LearnPayload, identity: UserIdentity) => Refusal | null;
  /**
   * /step and /repair: the learn this request follows - its signed id, and the request's own counter (a step, a loop round), checked and
   * counted after the budgets. Absent: /api/learn, which issues the id.
   */
  followUp?: { learnId: unknown; count: (check: { uuid: string; expiresAt: Date }) => Promise<Refusal | null> };
  /** /api/learn: the structure cache, asked before the pair cap and the budgets (a hit costs nothing) - the answer to send, or null. */
  cacheHit?: (payload: LearnPayload, identity: UserIdentity, now: Date) => Promise<LearnResponse | null>;
  /** Reserve one unit of the user's AI-learn quota for the call (/api/learn and /step; a loop round is part of its learn and does not). */
  reserve: boolean;
}

/** An admitted AI request: everything its call needs. */
interface Admitted {
  identity: UserIdentity;
  owner: string;
  now: Date;
  payload: LearnPayload;
  /** The learn's signed id: issued by `admit` (/api/learn), or the one the follow-up carried. */
  learnId: string;
  ctx: AiLearnCtx;
  /** A quota unit was reserved for this call: it goes back if the call throws (`callAi`). */
  reserved: boolean;
}

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
    provider: c.provider,
    ...(c.fallback ? { fallback: true as const, ...(c.fallbackReason ? { fallbackReason: c.fallbackReason } : {}) } : {}),
    promptVersion: c.promptVersion,
    masking: c.masking,
    tokensIn: c.tokensIn,
    tokensOut: c.tokensOut,
    tokensCached: c.tokensCached,
    costUsd: c.costUsd,
    estimate: c.estimate,
    latencyMs: c.latencyMs,
    outcome: c.outcome,
    cacheHit: false,
    problemCounts: c.problemCounts,
    // AI code checks: a `check` call's counts (how many checks it asked, how many were dropped) - never the checks themselves.
    ...(c.checks ? { checks: c.checks } : {}),
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
    estimate: sumEstimates([]),
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
    version: PromptVersion = promptVersion,
  ): Promise<void> => {
    if (payload.complete !== undefined) return; // completion: the answer holds the user's own rules (see the file header)
    if (!outcome.verified || !outcome.rules) return;
    // SPEC 15: the AI's explanation and function request are never cached (the guess may name values; the request is recorded elsewhere).
    const rules = stripAiNotes(outcome.rules);
    if (!isCacheable(rules, payload.masking)) return;
    try {
      await store.putCachedRules({ owner, key, rules, promptVersion: version, createdAt: now });
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

  /**
   * AI code checks (SPEC 21 v14): the prompt version a signed-in user's learn is sent - learn-v9 when `LEARN_CHECKS` gives it to them (`all`,
   * or `admin` and they are an admin), otherwise the default (`promptVersion`, learn-v7). The same for the learn, its steps and its repairs.
   * DECISION: a value that is no mode (the production check stops the start on it) means off here, so a typo never turns the checks on.
   */
  const checksFor = (identity: Identity): boolean => {
    const mode = learnChecksModeOf(env.LEARN_CHECKS) ?? 'off';
    return mode === 'all' || (mode === 'admin' && identity.kind === 'user' && identity.isAdmin === true);
  };
  const promptFor = (identity: Identity): PromptVersion => (checksFor(identity) ? 'learn-v9' : promptVersion);

  /** At least one model answered: a provider outage (every call an `error:*`) is nobody's failed attempt. */
  const modelAnswered = (calls: readonly LlmCallRecord[]): boolean => calls.some((c) => !c.outcome.startsWith('error:'));

  const ctxOf = (identity: UserIdentity, now: Date, check: { uuid: string; expiresAt: Date; group: string }): AiLearnCtx => ({
    store,
    owner: ownerOf(identity),
    quota: aiQuotaOf(identity, now),
    group: check.group,
    uuid: check.uuid,
    learnExpiresAt: check.expiresAt,
    now,
  });

  /**
   * API audit C4 (2026-10-07): ONE admission for every AI route - /api/learn, /step and /repair - so no route can skip a check another makes.
   * In order, each refused before anything after it costs anything:
   *
   *   signed in (403 `signInForAi`) -> the route's own gate -> the payload: its shape, a completion's fixed rules, its byte cap and every
   *   cell's length (400 `invalidPayload`; the first learn checked neither cap) -> the rest of the body (rows, rounds ...) -> a follow-up's
   *   signed learnId (400 `invalidLearnId`) -> the structure cache (/api/learn: a hit costs nothing) -> the pair's failed-attempt cap
   *   (409) -> the daily budgets -> a follow-up's own counter (a step, a loop round) -> the user's AI-learn quota, reserved (429).
   *
   * What comes back is everything the call needs; or `done`, the reply already sent (a refusal, or a cache hit).
   */
  const admit = async (req: FastifyRequest, reply: FastifyReply, spec: AdmitSpec): Promise<Admitted | { done: FastifyReply }> => {
    const refuse = (r: Refusal): { done: FastifyReply } => ({ done: fail(reply, r.status, r.body) });

    // SPEC 21 v5: the AI step is for signed-in users only - answered before anything else costs anything.
    // (Free users get everything that runs locally, and the local result first; the web shows that.)
    const identity = identify(req);
    if (identity.kind !== 'user') return refuse({ status: 403, body: { error: 'signInForAi' } });
    if (spec.allow && !spec.allow(identity)) return refuse({ status: 400, body: { error: 'invalidRequest' } });

    const parsed = LearnPayloadSchema.safeParse(spec.payload);
    if (!parsed.success) return refuse(INVALID_PAYLOAD);
    const payload = parsed.data as unknown as LearnPayload;
    if (payload.complete && !readCompleteFixed(payload.complete)) return refuse(INVALID_PAYLOAD);
    // SPEC 7.3: never more than the browser builds - the payload's bytes and each cell's characters.
    if (!payloadFits(payload)) return refuse(INVALID_PAYLOAD);
    const bodyRefusal = spec.body?.(payload, identity);
    if (bodyRefusal) return refuse(bodyRefusal);

    const owner = ownerOf(identity);
    const now = protection.now();

    // SPEC 9.3: a follow-up belongs to a learn this owner really ran (signed, owner-bound, unexpired).
    const followUp = spec.followUp ? verifyLearnId(secret, owner, spec.followUp.learnId, now) : null;
    if (followUp && !followUp.ok) return refuse({ status: 400, body: { error: 'invalidLearnId' } });

    const hit = await spec.cacheHit?.(payload, identity, now);
    if (hit) return { done: reply.send(hit) };

    // SPEC 21 v5 item 3: the same example pair already failed as often as the cap allows - no more AI for it
    // (the answer that reached the cap already counted it once).
    const group = followUp?.ok ? followUp.group : groupOf(learnCacheKey(payload));
    if (await pairExhausted(store, owner, group)) return refuse({ status: 409, body: { error: 'aiAttemptsExhausted', counted: false } });

    // SPEC 9.5 budgets, then the user's AI-learn quota - both BEFORE any LLM call.
    const budget = await budgetRefusal(identity, now);
    if (budget) return refuse(budget);

    if (followUp?.ok) {
      const counted = await spec.followUp!.count(followUp);
      if (counted) return refuse(counted);
    }

    // The quota unit is reserved now and settled after the call (kept when the learn counts, put back when it does not).
    const quota = aiQuotaOf(identity, now);
    const reserved = spec.reserve && quota.spec !== null;
    if (reserved) {
      const reservation = await reserveLearn(store, [quota.spec!]);
      if (!reservation.ok) return refuse({ status: 429, body: { error: 'limitHit', limit: reservation.limitCode, period: quota.period } });
    }

    if (followUp?.ok) return { identity, owner, now, payload, learnId: spec.followUp!.learnId as string, ctx: ctxOf(identity, now, followUp), reserved };
    // /api/learn: the learn's signed id, issued once everything above let it through.
    const learnId = issueLearnId(secret, owner, now, limits.protection.learnIdTtlMinutes, group);
    const check = verifyLearnId(secret, owner, learnId, now);
    if (!check.ok) throw new Error('issued a learnId that does not verify'); // unreachable: signed just above
    return { identity, owner, now, payload, learnId, ctx: ctxOf(identity, now, check), reserved };
  };

  /**
   * The AI call of an admitted request: its function requests recorded (`withRecordedRequests`, against `checked` - the payload plus a
   * round's rows), then the ledger and the spend. A call that throws past the provider layer learned nothing and counts nothing: the
   * reserved unit goes back.
   */
  const callAi = async (a: Admitted, call: () => Promise<LearnOutcome>, checked: LearnPayload = a.payload, previous?: LearnResult): Promise<LearnOutcome> => {
    let outcome: LearnOutcome;
    try {
      outcome = await withRecordedRequests(await call(), checked, a.owner, a.now, previous);
    } catch (err) {
      if (a.reserved) await releaseReservation(a.ctx).catch((e: unknown) => logFailure('failed to release an AI learn', e));
      throw err;
    }
    await recordCalls(a.ctx.uuid, a.identity, outcome.calls, a.now);
    return outcome;
  };

  /**
   * The end of /api/learn and of a step. AI code checks: an answer with checks counts nothing - the unit is put back (each step reserves
   * it again) and the learn stays open for its steps. An answer with rules settles the learn (`settleLearn`); the attempt that reached the
   * pair's failed-attempt cap is answered 409 `aiAttemptsExhausted`, `counted` saying whether it counted as the pair's one learn.
   */
  const settleAndAnswer = async (reply: FastifyReply, a: Admitted, outcome: LearnOutcome, extra: Pick<LearnResponse, 'learnId' | 'cached'> | Record<string, never>): Promise<FastifyReply> => {
    if (outcome.checks) {
      await releaseReservation(a.ctx).catch((e: unknown) => logFailure('failed to release an AI learn', e));
      const more: StepResponse = {
        rules: null,
        checks: outcome.checks,
        ...(outcome.droppedChecks ? { droppedChecks: outcome.droppedChecks } : {}),
        verified: false,
        problems: [],
        ...(outcome.overfitRepaired ? { overfitRepaired: true } : {}),
        ...extra,
        counted: false,
        failedAttempts: (await stateOf(a.ctx)).failedAttempts,
        quota: await quotaState(store, a.ctx.quota),
      };
      return reply.send(more);
    }

    const settled = await settleLearn(a.ctx, { answered: modelAnswered(outcome.calls), verified: outcome.verified });
    if (settled.exhausted && !outcome.verified) return fail(reply, 409, { error: 'aiAttemptsExhausted', counted: settled.counted });

    const res: StepResponse = {
      rules: outcome.rules,
      // learn-v8: the answer's checked alternatives go to the browser beside it (never into the cache: `saveToCache` keeps the rules only).
      ...(outcome.alternatives ? { alternatives: outcome.alternatives } : {}),
      verified: outcome.verified,
      problems: outcome.problems,
      ...(outcome.overfitRepaired ? { overfitRepaired: true } : {}),
      ...extra,
      counted: settled.counted,
      failedAttempts: settled.failedAttempts,
      quota: await quotaState(store, a.ctx.quota),
    };
    return reply.send(res);
  };

  app.post('/api/learn', { onRequest: rateLimit }, async (req, reply) => {
    const body = req.body as LearnRequestBody | undefined;
    const a = await admit(req, reply, {
      payload: body?.payload,
      reserve: true,
      // SPEC 9.5 cache: a hit costs no learn and no LLM call - so it is served even when limits or budgets
      // are spent. `noCache` lets the browser insist on a fresh learn (e.g. its verification rejected a hit).
      // (Never in completion mode: see the file header.)
      cacheHit: async (payload, identity, now) => {
        if (body?.noCache === true || payload.complete !== undefined) return null;
        const started = Date.now();
        const notBefore = new Date(now.getTime() - limits.cache.ttlDays * DAY_MS);
        const saved = LearnResultSchema.safeParse(await store.getCachedRules(ownerOf(identity), learnCacheKey(payload), notBefore));
        // Re-checked on read too: an entry written under another masking rule set must not be served.
        if (!saved.success || !isCacheable(stripAiNotes(saved.data as LearnResult), payload.masking)) return null;
        try {
          await store.insertLlmCalls([cacheHitLedgerDoc(randomUUID(), identity, payload, now, Date.now() - started)]);
        } catch (err) {
          logFailure('failed to write the llm_calls ledger', err);
        }
        return { rules: stripAiNotes(saved.data as LearnResult), verified: true, problems: [], cached: true };
      },
    });
    if ('done' in a) return a.done;

    const prompt = promptFor(a.identity);
    // (`rulesNow`: the browser's fresh learn in a round of the learning loop answers with the rules - loop rounds carry no checks.)
    const outcome = await callAi(a, () =>
      learn(a.payload, { tier: tierOf(a.identity), env, complete, prompt, ...(body?.rulesNow === true ? { rulesNow: true } : {}) }),
    );
    // (An answer with checks has no rules: nothing is stored.)
    await saveToCache(a.owner, learnCacheKey(a.payload), a.payload, outcome, a.now, prompt);
    return settleAndAnswer(reply, a, outcome, { learnId: a.learnId, cached: false });
  });

  // AI code checks (SPEC 21 v14): one step of a learn whose AI step asked checks - the payload and every round so far, under the learn's
  // signed learnId. The answer is more checks (while rounds are left) or the rules, settled like /api/learn's.
  app.post('/api/learn/step', { onRequest: rateLimit }, async (req, reply) => {
    const body = req.body as StepRequestBody | undefined;
    let rounds: CheckRound[] = [];
    const a = await admit(req, reply, {
      payload: body?.payload,
      // Only learns that were sent learn-v9 make steps (`LEARN_CHECKS`).
      allow: checksFor,
      // The rounds: their shape (checks the gate accepts, one answer each, the answers' caps), at most `maxRounds`, the rows they show within
      // the learn's row limit with the payload's own, and the whole body under the payload byte cap.
      body: (payload) => {
        const parsedRounds = CheckRoundsSchema.safeParse(body?.rounds);
        if (!parsedRounds.success) return INVALID_ROUNDS;
        rounds = parsedRounds.data as CheckRound[];
        return stepFits(payload, rounds) ? null : INVALID_ROUNDS;
      },
      followUp: {
        learnId: body?.token,
        count: async (check) => {
          // Step N carries N rounds: a request may not skip ahead of the steps made (one sent again after a lost answer is fine: the counter caps it).
          const made = await store.getCounter(stepKey(check.uuid));
          if (rounds.length > made + 1) return INVALID_ROUNDS;
          // At most `maxRounds` steps per learn; the `step:<uuid>` counter makes the cap atomic. A request refused above costs no step.
          const steps = await store.incrementCounter(stepKey(check.uuid), 1, new Date(check.expiresAt.getTime() + HOUR_MS));
          return steps > limits.learn.checks.maxRounds ? { status: 429, body: { error: 'limitHit', limit: 'stepsPerLearn' } } : null;
        },
      },
      // The quota unit, reserved again for this call (see the file header): put back if the answer is more checks, settled if it is the rules.
      reserve: true,
    });
    if ('done' in a) return a.done;

    const outcome = await callAi(a, () => learn(a.payload, { tier: tierOf(a.identity), env, complete, prompt: 'learn-v9', rounds }));
    // (Never the structure cache: a learn whose rounds are non-empty is not stored there - see the file header.)
    return settleAndAnswer(reply, a, outcome, {});
  });

  app.post('/api/learn/repair', { onRequest: rateLimit }, async (req, reply) => {
    const body = req.body as RepairRequestBody | undefined;
    let previousRules = null as LearnResult | null;
    let problems: RepairProblem[] = [];
    let rows: Sample[] = [];
    let rounds: CheckRound[] = [];
    let uses = 0;
    const a = await admit(req, reply, {
      payload: body?.payload,
      body: (payload, identity) => {
        const parsedRules = LearnResultSchema.safeParse(body?.previousRules);
        if (!parsedRules.success) return { status: 400, body: { error: 'invalidPreviousRules' } };
        previousRules = parsedRules.data;
        if (!isRepairProblemArray(body?.problems)) return { status: 400, body: { error: 'invalidProblems' } };
        problems = body.problems;
        // The learning loop's rows (SPEC 9.3): sample-shaped, and never more than one learn may send - its samples and dropped rows
        // included, each cell within the payload's cell length, and the payload with all of them added under the payload byte cap.
        // (Absent: a round with no rows.)
        const parsedRows = LoopRowsSchema.safeParse(body?.rows ?? []);
        if (!parsedRows.success) return INVALID_ROWS;
        rows = parsedRows.data as Sample[];
        if (!loopRowsFit(payload, rows)) return INVALID_ROWS;
        // Logic first (docs/proposals/saved-format-contents.md section 4): a list's round answered with AI code checks (learn-v9) is sent
        // again with its rounds of checks - only a round about a list, only for a learn sent learn-v9, and within the caps a step is held to
        // (the round's rows included). Absent: the round's first call, as before.
        if (body?.rounds === undefined) return null;
        const parsedRounds = CheckRoundsSchema.safeParse(body.rounds);
        const listRound = problems.some((p) => p.kind === 'list');
        if (!parsedRounds.success || !listRound || !checksFor(identity)) return INVALID_ROUNDS;
        rounds = parsedRounds.data as CheckRound[];
        return stepFits(withRows(payload, rows), rounds) ? null : INVALID_ROUNDS;
      },
      followUp: {
        learnId: body?.learnId,
        count: async (check) => {
          // A round adds at most `rowsPerRound` rows: round N carries at most N x rowsPerRound in all. Checked against the rounds used so far,
          // before this one is counted, so a request refused here costs no round.
          const used = await store.getCounter(repairKey(check.uuid));
          if (rows.length > (used + 1) * limits.learn.loop.rowsPerRound) return INVALID_ROWS;
          // At most `browserRepairCalls` rounds of the learning loop per learn; the `repair:<uuid>` counter is what makes the cap atomic.
          uses = await store.incrementCounter(repairKey(check.uuid), 1, new Date(check.expiresAt.getTime() + HOUR_MS));
          return uses > limits.llm.browserRepairCalls ? { status: 429, body: { error: 'limitHit', limit: 'repairsPerLearn' } } : null;
        },
      },
      // The rounds are part of their learn, not a new one: the quota is untouched.
      reserve: false,
    });
    if ('done' in a) return a.done;
    const previous = previousRules!;

    // (The rows are values of the user's own files too: a function request is filtered against them like against the samples.)
    // (A learn-v9 learn's rounds are repaired with learn-v9 too: the same system prompt and schema, so the cached prefix still hits.)
    const prompt = promptFor(a.identity);
    const outcome = await callAi(
      a,
      () =>
        repairFromBrowser(a.payload, previous, problems, {
          tier: tierOf(a.identity),
          env,
          complete,
          prompt,
          rows,
          overfitRepaired: body?.overfitRepaired === true,
          // (a list's round may ask checks only while another repair call of this learn is left to answer them)
          ...(rounds.length > 0 ? { rounds } : {}),
          mayCheck: uses < limits.llm.browserRepairCalls,
        }),
      withRows(a.payload, rows),
      previous,
    );

    // The repaired rules replace the owner's entry for this structure, so a later cache hit returns
    // the better version rather than the one the browser had to repair. (Not an answer made after rounds of checks: like a step's, never cached.)
    if (rounds.length === 0) await saveToCache(a.owner, learnCacheKey(a.payload), a.payload, outcome, a.now, prompt);

    // A round whose answer passes the server checks makes the learn a success (a round never counts on its own, and however many rounds a
    // learn takes it counts once: `markSucceeded` is idempotent); one that does not changes nothing - the learn's failure was recorded when
    // it failed, and the browser reports how the loop ended (`/outcome`).
    const settled: Settled = outcome.verified ? await markSucceeded(a.ctx) : await stateOf(a.ctx);

    const res: RepairResponse = {
      rules: outcome.rules,
      ...(outcome.alternatives ? { alternatives: outcome.alternatives } : {}),
      // (a list's round, learn-v9: checks instead of rules - the browser answers them and sends the round again with `rounds`)
      ...(outcome.checks ? { checks: outcome.checks, ...(outcome.droppedChecks ? { droppedChecks: outcome.droppedChecks } : {}) } : {}),
      verified: outcome.verified,
      problems: outcome.problems,
      ...(outcome.overfitRepaired ? { overfitRepaired: true } : {}),
      counted: settled.counted,
      failedAttempts: settled.failedAttempts,
      quota: await quotaState(store, a.ctx.quota),
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
