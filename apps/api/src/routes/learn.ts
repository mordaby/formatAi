// POST /api/learn and POST /api/learn/repair (SPEC 5 A steps 5-6).
//
// Registered ONLY when NODE_ENV !== "production" (see server.ts) until M2 adds
// per-tier rate limits, daily budgets, Turnstile and the structure-hash learn cache
// (SPEC 9.5) - without those, shipping this to production would let anyone spend LLM
// budget with no ceiling at all. SPEC 15: this file never logs a payload, a cell
// value, or `previousRules`/`problems` content - only the ledger fields already
// stripped down to counts/ids/codes by `learn.ts`'s `LlmCallRecord`.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  LearnPayloadSchema,
  LearnResultSchema,
  type LearnPayload,
  type LearnResult,
  type RepairProblem,
} from '@formatai/shared';
import type { AppDb } from '../db.js';
import type { Env } from '../env.js';
import { learn, repairFromBrowser, type CompleteFn, type LlmCallRecord } from '../learn/index.js';

export interface RegisterLearnRoutesOptions {
  env: Env;
  db: AppDb | null;
  /** Dependency injection for tests - see `learn.ts`'s `LearnOptions.complete`.
   * Defaults to the real `complete()`. */
  complete?: CompleteFn;
}

interface LearnRequestBody {
  payload?: unknown;
}

interface RepairRequestBody {
  payload?: unknown;
  previousRules?: unknown;
  problems?: unknown;
}

/** SPEC 13 `llm_calls`: one document per call this learn made. `userId`/`anonId`
 * aren't attached yet - M2 wires sign-in/anonymous identity through this route. */
async function writeLedger(db: AppDb | null, learnId: string, calls: readonly LlmCallRecord[]): Promise<void> {
  if (!db || calls.length === 0) return;
  await db.llmCalls.insertMany(
    calls.map((c) => ({
      ts: new Date(),
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
      cacheHit: c.tokensCached > 0,
    })),
  );
}

function isRepairProblemArray(value: unknown): value is RepairProblem[] {
  return Array.isArray(value);
}

/**
 * Registers the two learn endpoints on `app`. Call only under the same
 * `NODE_ENV !== "production"` guard `server.ts` uses - see the file doc comment.
 */
export function registerLearnRoutes(app: FastifyInstance, opts: RegisterLearnRoutesOptions): void {
  const { env, db, complete } = opts;

  app.post('/api/learn', async (req, reply) => {
    const body = req.body as LearnRequestBody | undefined;
    const parsedPayload = LearnPayloadSchema.safeParse(body?.payload);
    if (!parsedPayload.success) {
      return reply.code(400).send({ error: 'invalidPayload' });
    }
    const payload = parsedPayload.data as unknown as LearnPayload;

    // DECISION (M1): tier is hardcoded until M2 wires sign-in/anonymous identity and
    // per-tier limits through this route (SPEC 11, 9.5) - see the file doc comment.
    const outcome = await learn(payload, { tier: 'registered', env, complete });

    const learnId = randomUUID();
    await writeLedger(db, learnId, outcome.calls);

    return reply.send({
      rules: outcome.rules,
      verified: outcome.verified,
      problems: outcome.problems,
    });
  });

  app.post('/api/learn/repair', async (req, reply) => {
    const body = req.body as RepairRequestBody | undefined;
    const parsedPayload = LearnPayloadSchema.safeParse(body?.payload);
    if (!parsedPayload.success) {
      return reply.code(400).send({ error: 'invalidPayload' });
    }
    const parsedRules = LearnResultSchema.safeParse(body?.previousRules);
    if (!parsedRules.success) {
      return reply.code(400).send({ error: 'invalidPreviousRules' });
    }
    if (!isRepairProblemArray(body?.problems)) {
      return reply.code(400).send({ error: 'invalidProblems' });
    }

    const payload = parsedPayload.data as unknown as LearnPayload;
    const previousRules: LearnResult = parsedRules.data;
    const problems = body.problems;

    const outcome = await repairFromBrowser(payload, previousRules, problems, { tier: 'registered', env, complete });

    const learnId = randomUUID();
    await writeLedger(db, learnId, outcome.calls);

    return reply.send({
      rules: outcome.rules,
      verified: outcome.verified,
      problems: outcome.problems,
    });
  });
}
