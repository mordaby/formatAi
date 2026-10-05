// SPEC 9.6 / 13: what a fallback call leaves in the learn's records and the `llm_calls` ledger - which provider and model answered, that it
// was a fallback and why, and a cost at the fallback model's own prices. The learn itself (its checks, repairs and quota) is unchanged.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { models, tokenPriceOf } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import {
  completeWithFallback,
  createAnthropicProvider,
  createCircuitBreaker,
  createOpenAiProvider,
  type CompleteRequest,
  type FallbackDeps,
} from '../../src/llm/index.js';
import { learn, type CompleteFn } from '../../src/learn/index.js';
import type { Identity } from '../../src/protection/identity.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { basicPayload, correctRulesWireJson } from './fixtures.js';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', LLM_FALLBACK_PROVIDER: 'openai' });
const MODELS = { firstTry: models.anthropic.firstTry, escalation: models.anthropic.escalation };

function anthropicAnswer(json: unknown): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: models.anthropic.firstTry,
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify(json), citations: null }],
    usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as Anthropic.Message;
}

function openAiAnswer(json: unknown): OpenAI.Responses.Response {
  return {
    id: 'resp_1',
    model: 'gpt-5-mini-2025-08-07',
    status: 'completed',
    output_text: JSON.stringify(json),
    usage: { input_tokens: 3000, output_tokens: 400, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 64 }, total_tokens: 3400 },
  } as unknown as OpenAI.Responses.Response;
}

const overloaded = () => Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error' } }, 'Overloaded', new Headers());

/** `learn()`'s `complete` through the fail-over, on mocked SDK clients. */
function through(anthropic: () => Promise<Anthropic.Message>, openai: () => Promise<OpenAI.Responses.Response>): { complete: CompleteFn; anthropicCreate: ReturnType<typeof vi.fn>; openAiCreate: ReturnType<typeof vi.fn> } {
  const anthropicCreate = vi.fn(anthropic);
  const openAiCreate = vi.fn(openai);
  const deps: FallbackDeps = {
    primary: createAnthropicProvider({ client: { messages: { create: anthropicCreate } } as unknown as Anthropic }),
    fallback: { name: 'openai', create: () => createOpenAiProvider({ client: { responses: { create: openAiCreate } } as unknown as OpenAI }), model: (slot) => models.openai[slot] },
    breaker: createCircuitBreaker({ tripAfter: 3, windowMs: 60_000, coolDownMs: 300_000 }),
    log: { warn: () => undefined, error: () => undefined },
  };
  return { complete: (req: CompleteRequest) => completeWithFallback(req, deps), anthropicCreate, openAiCreate };
}

describe('learn() records of a fallback call', () => {
  it('the fallback answered: provider, model, fallback and reason on the record; cost and estimate at the fallback model\'s prices; the learn verifies as usual', async () => {
    const t = through(async () => Promise.reject(overloaded()), async () => openAiAnswer(correctRulesWireJson()));
    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: MODELS, complete: t.complete });

    expect(outcome.verified).toBe(true);
    expect(outcome.calls).toHaveLength(1);
    const call = outcome.calls[0]!;
    expect(call).toMatchObject({ purpose: 'learn', provider: 'openai', model: 'gpt-5-mini-2025-08-07', fallback: true, fallbackReason: 'overloaded', outcome: 'verified', tokensIn: 3000, tokensOut: 400 });
    expect(call.costUsd).toBeCloseTo((3000 * 0.25 + 400 * 2) / 1_000_000, 12);
    const price = tokenPriceOf('gpt-5-mini-2025-08-07')!;
    expect(call.estimate.costUsd).toBeCloseTo(
      (call.estimate.inputTokens * price.input + call.estimate.cachedInputTokens * price.cachedInput + call.estimate.cacheWriteTokens * price.cacheWrite + call.estimate.outputTokens * price.output) / 1_000_000,
      12,
    );
    expect(call.estimate.costUsd).toBeGreaterThan(0);
  });

  it('the primary answered: its provider and model, no fallback fields', async () => {
    const t = through(async () => anthropicAnswer(correctRulesWireJson()), async () => openAiAnswer({}));
    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: MODELS, complete: t.complete });
    expect(outcome.calls[0]).toMatchObject({ provider: 'anthropic', model: models.anthropic.firstTry, outcome: 'verified' });
    expect(outcome.calls[0]!.fallback).toBeUndefined();
    expect(outcome.calls[0]!.fallbackReason).toBeUndefined();
    expect(t.openAiCreate).not.toHaveBeenCalled();
  });

  it('a fallback call is part of the same learn: its wrong answer gets the usual server repair (on the fallback too while the primary is down)', async () => {
    let n = 0;
    const t = through(
      async () => Promise.reject(overloaded()),
      async () => (n++ === 0 ? openAiAnswer({ not: 'an answer' }) : openAiAnswer(correctRulesWireJson())),
    );
    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: MODELS, complete: t.complete });
    expect(outcome.calls.map((c) => [c.purpose, c.provider, c.fallback])).toEqual([
      ['learn', 'openai', true],
      ['repair', 'openai', true],
    ]);
    expect(outcome.verified).toBe(true);
    // the repair went to the fallback's first-try model too
    expect((t.openAiCreate.mock.calls[1]![0] as { model: string }).model).toBe(models.openai.firstTry);
  });

  it('both failed: the record is the fallback\'s error (the last provider tried), with why it was tried', async () => {
    const t = through(async () => Promise.reject(overloaded()), async () => Promise.reject(new OpenAI.InternalServerError(503, {}, 'down', new Headers())));
    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: MODELS, complete: t.complete, noEscalation: true });
    expect(outcome.verified).toBe(false);
    expect(outcome.calls[0]).toMatchObject({ provider: 'openai', model: models.openai.firstTry, fallback: true, fallbackReason: 'overloaded', outcome: 'error:providerError', costUsd: 0 });
  });

  it('a call that failed with no fallback configured is recorded on the primary, as before', async () => {
    const outcome = await learn(basicPayload(), {
      tier: 'registered',
      env,
      models: MODELS,
      noEscalation: true,
      complete: () => Promise.reject(overloaded()),
    });
    expect(outcome.calls[0]).toMatchObject({ provider: 'anthropic', model: models.anthropic.firstTry, outcome: 'error:providerError' });
    expect(outcome.calls[0]!.fallback).toBeUndefined();
  });
});

describe('the llm_calls ledger of a fallback call (POST /api/learn)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const USER = '00000000000000000000000a';
  const asUser = (req: FastifyRequest): Identity => ({ kind: 'user', userId: USER, tier: 'registered', anonId: req.anonId });

  it('writes provider, model, fallback and fallbackReason; the learn is one learn', async () => {
    const t = through(async () => Promise.reject(overloaded()), async () => openAiAnswer(correctRulesWireJson()));
    const store = createMemoryStore();
    app = await buildServer({
      env: loadEnv({ ...process.env, NODE_ENV: 'development', MONGODB_URI: '', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', LLM_FALLBACK_PROVIDER: 'openai', TURNSTILE_SECRET_KEY: undefined }),
      db: null,
      logger: false,
      store,
      identify: asUser,
      complete: t.complete,
    });
    const res = await app.inject({ method: 'POST', url: '/api/learn', payload: JSON.stringify({ payload: basicPayload() }), headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]).toMatchObject({ purpose: 'learn', provider: 'openai', model: 'gpt-5-mini-2025-08-07', fallback: true, fallbackReason: 'overloaded', outcome: 'verified', cacheHit: false });
    expect(store.ledger[0]!.estimate!.costUsd).toBeGreaterThan(0);
  });
});
