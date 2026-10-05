// SPEC 9.6 "Fallback": a call the primary provider cannot serve is made once more on the fallback, in the same slot - and only then. The
// primary is the real Anthropic adapter and the fallback the real OpenAI adapter, both on mocked SDK clients (no network).
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { limits, models } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/env.js';
import {
  completeWithFallback,
  createAnthropicProvider,
  createCircuitBreaker,
  createFakeProvider,
  createOpenAiProvider,
  fallbackDepsOf,
  LlmError,
  slotOf,
  type CircuitBreaker,
  type CompleteRequest,
  type FallbackDeps,
} from '../../src/llm/index.js';

const SECRET = 'SECRET-PAYLOAD-cell-value';
const h = () => new Headers();

function request(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    system: 'the learn prompt',
    content: [{ text: `{"payload":"${SECRET}"}`, cache: true }],
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    model: models.anthropic.firstTry,
    purpose: 'learn',
    ...overrides,
  };
}

function anthropicMessage(text = '{"name":"from anthropic"}', overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: models.anthropic.firstTry,
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  } as Anthropic.Message;
}

function openAiResponse(model = 'gpt-5-mini-2025-08-07', text = '{"name":"from openai"}'): OpenAI.Responses.Response {
  return {
    id: 'resp_1',
    model,
    status: 'completed',
    output_text: text,
    usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 50 }, total_tokens: 1200 },
  } as unknown as OpenAI.Responses.Response;
}

interface Setup {
  deps: FallbackDeps;
  anthropicCreate: ReturnType<typeof vi.fn>;
  openAiCreate: ReturnType<typeof vi.fn>;
  log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

/** The primary (Anthropic) answers with `primary` (a message, or an SDK error to throw); the fallback (OpenAI) with `fallback`. */
function setup(primary: unknown, fallback: unknown = openAiResponse(), breaker?: CircuitBreaker): Setup {
  const anthropicCreate = vi.fn(async () => {
    if (primary instanceof Error) throw primary;
    return primary;
  });
  const openAiCreate = vi.fn(async (params: OpenAI.Responses.ResponseCreateParamsNonStreaming) => {
    if (fallback instanceof Error) throw fallback;
    return typeof fallback === 'function' ? (fallback as (p: unknown) => unknown)(params) : fallback;
  });
  const log = { warn: vi.fn(), error: vi.fn() };
  const deps: FallbackDeps = {
    primary: createAnthropicProvider({ client: { messages: { create: anthropicCreate } } as unknown as Anthropic }),
    fallback: {
      name: 'openai',
      create: () => createOpenAiProvider({ client: { responses: { create: openAiCreate } } as unknown as OpenAI }),
      model: (slot) => models.openai[slot],
    },
    breaker: breaker ?? createCircuitBreaker({ tripAfter: 100, windowMs: 60_000, coolDownMs: 60_000 }),
    log,
  };
  return { deps, anthropicCreate, openAiCreate, log };
}

const overloaded = () => Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', h());

describe('fail-over triggers: the same request goes to the fallback once', () => {
  const triggers: [string, () => Error, string][] = [
    ['a network error', () => new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'network'],
    ['a timeout', () => new Anthropic.APIConnectionTimeoutError({ message: 'timed out' }), 'timeout'],
    ['HTTP 429', () => new Anthropic.RateLimitError(429, {}, 'rate limited', h()), 'rateLimited'],
    ["Anthropic's overloaded error (529)", overloaded, 'overloaded'],
    ['HTTP 500', () => new Anthropic.InternalServerError(500, { type: 'error', error: { type: 'api_error' } }, 'boom', h()), 'serverError'],
    ['HTTP 503', () => new Anthropic.InternalServerError(503, {}, 'unavailable', h()), 'serverError'],
    ['HTTP 401 (a bad key)', () => new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', h()), 'auth'],
    ['HTTP 403', () => new Anthropic.PermissionDeniedError(403, {}, 'forbidden', h()), 'auth'],
  ];

  for (const [label, error, reason] of triggers) {
    it(`${label} -> the fallback answers, recorded as a fallback (${reason})`, async () => {
      const s = setup(error());
      const result = await completeWithFallback(request(), s.deps);

      expect(s.anthropicCreate).toHaveBeenCalledTimes(1);
      expect(s.openAiCreate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5-mini-2025-08-07', json: { name: 'from openai' }, fallback: { from: 'anthropic', reason } });
      // priced as the model that answered
      expect(result.costUsd).toBeCloseTo((1000 * 0.25 + 200 * 2) / 1_000_000, 12);
    });
  }

  it('sends the SAME request: the system prompt, every content block in order, the schema and the purpose; only the model is the fallback slot\'s', async () => {
    const s = setup(overloaded());
    const req = request({ content: [{ text: 'payload block', cache: true }, { text: 'repair block' }], purpose: 'repair' });
    await completeWithFallback(req, s.deps);

    const sent = s.openAiCreate.mock.calls[0]![0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    expect(sent.model).toBe(models.openai.firstTry);
    expect(sent.instructions).toBe(req.system);
    expect((sent.input as Array<{ content: Array<{ text: string }> }>)[0]!.content.map((c) => c.text)).toEqual(['payload block', 'repair block']);
    expect((sent.text as unknown as { format: { schema: { required: string[] } } }).format.schema.required).toEqual(['name']);
  });

  it('maps the slot: a learn or a repair call to the fallback\'s first-try model, an escalation to its escalation model', async () => {
    expect([slotOf('learn'), slotOf('repair'), slotOf('escalation')]).toEqual(['firstTry', 'firstTry', 'escalation']);
    for (const [purpose, model] of [['learn', 'gpt-5-mini'], ['repair', 'gpt-5-mini'], ['escalation', 'gpt-5']] as const) {
      const s = setup(overloaded(), (p: OpenAI.Responses.ResponseCreateParamsNonStreaming) => openAiResponse(p.model as string));
      const result = await completeWithFallback(request({ purpose, model: purpose === 'escalation' ? models.anthropic.escalation : models.anthropic.firstTry }), s.deps);
      expect((s.openAiCreate.mock.calls[0]![0] as { model: string }).model, purpose).toBe(model);
      expect(result.model, purpose).toBe(model);
    }
  });

  it('DECISION (401 / 403): fails over AND logs an error naming the key to fix - never the payload or a key', async () => {
    const s = setup(new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key sk-ant-xxxx', h()));
    await completeWithFallback(request(), s.deps);
    expect(s.log.error).toHaveBeenCalledTimes(1);
    const line = String(s.log.error.mock.calls[0]![0]);
    expect(line).toContain('anthropic');
    expect(line).toContain('openai');
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('sk-');
  });

  it('logs a warning (not an error) for an outage, without the payload', async () => {
    const s = setup(overloaded());
    await completeWithFallback(request(), s.deps);
    expect(s.log.error).not.toHaveBeenCalled();
    expect(s.log.warn).toHaveBeenCalledTimes(1);
    expect(String(s.log.warn.mock.calls[0]![0])).toMatch(/anthropic unavailable \(overloaded\).*openai/);
    expect(String(s.log.warn.mock.calls[0]![0])).not.toContain(SECRET);
  });
});

describe('no fail-over: the primary answered, or the request is ours to fix', () => {
  it('a whole answer from the primary is returned as it is (no fallback field)', async () => {
    const s = setup(anthropicMessage());
    const result = await completeWithFallback(request(), s.deps);
    expect(result).toMatchObject({ provider: 'anthropic', json: { name: 'from anthropic' } });
    expect(result.fallback).toBeUndefined();
    expect(s.openAiCreate).not.toHaveBeenCalled();
  });

  it('a wrong answer (valid JSON the checks will reject) is returned: repair handles it', async () => {
    const s = setup(anthropicMessage('{"name":42}'));
    const result = await completeWithFallback(request(), s.deps);
    expect(result.json).toEqual({ name: 42 });
    expect(s.openAiCreate).not.toHaveBeenCalled();
  });

  it('a cut-off answer (truncated) is returned: repair handles it', async () => {
    const s = setup(anthropicMessage('{"na', { stop_reason: 'max_tokens' }));
    const result = await completeWithFallback(request(), s.deps);
    expect(result.truncated).toBe(true);
    expect(s.openAiCreate).not.toHaveBeenCalled();
  });

  it('a 400 invalid request fails loudly (our bug) - never on the fallback', async () => {
    const s = setup(new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error' } }, 'bad schema', h()));
    await expect(completeWithFallback(request(), s.deps)).rejects.toMatchObject({ kind: 'providerError', provider: 'anthropic' });
    expect(s.openAiCreate).not.toHaveBeenCalled();
  });

  it('a 404 (an unknown model id: our config) fails loudly too', async () => {
    const s = setup(new Anthropic.NotFoundError(404, {}, 'model not found', h()));
    await expect(completeWithFallback(request(), s.deps)).rejects.toMatchObject({ provider: 'anthropic' });
    expect(s.openAiCreate).not.toHaveBeenCalled();
  });

  it('a refusal and invalid JSON are answers: no fail-over', async () => {
    const refusal = setup(anthropicMessage('', { stop_reason: 'refusal', content: [] }));
    await expect(completeWithFallback(request(), refusal.deps)).rejects.toMatchObject({ kind: 'refused' });
    const invalid = setup(anthropicMessage('not json'));
    await expect(completeWithFallback(request(), invalid.deps)).rejects.toMatchObject({ kind: 'invalidJson' });
    expect(refusal.openAiCreate).not.toHaveBeenCalled();
    expect(invalid.openAiCreate).not.toHaveBeenCalled();
  });

  it('with no fallback configured, the primary\'s own error is the call\'s', async () => {
    const s = setup(overloaded());
    await expect(completeWithFallback(request(), { ...s.deps, fallback: null })).rejects.toMatchObject({ provider: 'anthropic', unavailable: 'overloaded' });
    expect(s.openAiCreate).not.toHaveBeenCalled();
  });

  it('when the fallback fails too, its error is thrown - marked as the fallback\'s, with its model - and nothing is tried a third time', async () => {
    const s = setup(overloaded(), new OpenAI.InternalServerError(500, {}, 'down too', h()));
    const err = await completeWithFallback(request(), s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ provider: 'openai', model: models.openai.firstTry, unavailable: 'serverError', fallback: { from: 'anthropic', reason: 'overloaded' } });
    expect((err as Error).message).toContain('on the fallback');
    expect(s.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(s.openAiCreate).toHaveBeenCalledTimes(1);
  });

  it('a fallback that cannot even be built (no key on a developer\'s machine) is a provider error of the fallback', async () => {
    const s = setup(overloaded());
    const deps: FallbackDeps = { ...s.deps, fallback: { ...s.deps.fallback!, create: () => { throw new Error('OPENAI_API_KEY missing'); } } };
    await expect(completeWithFallback(request(), deps)).rejects.toMatchObject({ kind: 'providerError', provider: 'openai', fallback: { from: 'anthropic' } });
  });
});

describe('the circuit breaker', () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it(`trips after ${limits.llm.fallback.tripAfter} consecutive primary failures: the next calls go straight to the fallback (circuitOpen)`, async () => {
    const c = clock();
    const breaker = createCircuitBreaker({ tripAfter: 3, windowMs: 60_000, coolDownMs: 300_000, now: c.now });
    const s = setup(overloaded(), openAiResponse(), breaker);

    for (let i = 0; i < 3; i++) {
      const r = await completeWithFallback(request(), s.deps);
      expect(r.fallback).toEqual({ from: 'anthropic', reason: 'overloaded' });
      c.advance(1_000);
    }
    expect(s.anthropicCreate).toHaveBeenCalledTimes(3);
    expect(s.log.warn.mock.calls.some(([line]) => /straight to openai/.test(String(line)))).toBe(true);

    const routed = await completeWithFallback(request(), s.deps);
    expect(routed.fallback).toEqual({ from: 'anthropic', reason: 'circuitOpen' });
    expect(s.anthropicCreate).toHaveBeenCalledTimes(3); // not tried
    expect(s.openAiCreate).toHaveBeenCalledTimes(4);
  });

  it('after the cool-down the primary is tried again: an answer closes the breaker', async () => {
    const c = clock();
    const breaker = createCircuitBreaker({ tripAfter: 2, windowMs: 60_000, coolDownMs: 300_000, now: c.now });
    const failing = setup(overloaded(), openAiResponse(), breaker);
    await completeWithFallback(request(), failing.deps);
    await completeWithFallback(request(), failing.deps);
    expect(breaker.isOpen()).toBe(true);

    c.advance(299_999);
    expect(breaker.isOpen()).toBe(true);
    c.advance(1);
    const healthy = setup(anthropicMessage(), openAiResponse(), breaker);
    const r = await completeWithFallback(request(), healthy.deps);
    expect(r.provider).toBe('anthropic');
    expect(healthy.anthropicCreate).toHaveBeenCalledTimes(1);
    // closed again: one more failure does not trip it
    const once = setup(overloaded(), openAiResponse(), breaker);
    await completeWithFallback(request(), once.deps);
    expect(breaker.isOpen()).toBe(false);
  });

  it('after the cool-down, one more primary failure trips it again at once', async () => {
    const c = clock();
    const breaker = createCircuitBreaker({ tripAfter: 3, windowMs: 60_000, coolDownMs: 300_000, now: c.now });
    const s = setup(overloaded(), openAiResponse(), breaker);
    for (let i = 0; i < 3; i++) await completeWithFallback(request(), s.deps);
    c.advance(300_000);
    await completeWithFallback(request(), s.deps); // the probe fails ...
    expect(s.anthropicCreate).toHaveBeenCalledTimes(4);
    expect(breaker.isOpen()).toBe(true); // ... and it is open again
    const routed = await completeWithFallback(request(), s.deps);
    expect(routed.fallback?.reason).toBe('circuitOpen');
    expect(s.anthropicCreate).toHaveBeenCalledTimes(4);
  });

  it('failures further apart than the window do not trip it, and any answer in between starts the count again', () => {
    const c = clock();
    const breaker = createCircuitBreaker({ tripAfter: 3, windowMs: 60_000, coolDownMs: 300_000, now: c.now });
    expect(breaker.recordFailure()).toBe(false);
    c.advance(61_000);
    expect(breaker.recordFailure()).toBe(false);
    c.advance(61_000);
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.isOpen()).toBe(false);

    c.advance(1_000);
    expect(breaker.recordFailure()).toBe(false); // two within the window now
    breaker.recordSuccess();
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.recordFailure()).toBe(true);
    expect(breaker.isOpen()).toBe(true);
  });

  it('a 400 from the primary shows it is up: it resets the count (and does not fail over)', async () => {
    const breaker = createCircuitBreaker({ tripAfter: 2, windowMs: 60_000, coolDownMs: 300_000 });
    await completeWithFallback(request(), setup(overloaded(), openAiResponse(), breaker).deps);
    await completeWithFallback(request(), setup(new Anthropic.BadRequestError(400, {}, 'bad', h()), openAiResponse(), breaker).deps).catch(() => undefined);
    await completeWithFallback(request(), setup(overloaded(), openAiResponse(), breaker).deps);
    expect(breaker.isOpen()).toBe(false);
  });

  it('config: the limits the production breaker uses', () => {
    expect(limits.llm.fallback).toMatchObject({ tripAfter: 3, coolDownMs: 300_000 });
    expect(limits.llm.fallback.windowMs).toBeGreaterThan(0);
  });
});

describe('fallbackDepsOf (the wiring from env)', () => {
  const env = (extra: Record<string, string | undefined>) =>
    loadEnv({ ...process.env, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: undefined, LLM_FALLBACK_PROVIDER: undefined, LLM_FALLBACK_MODEL_FIRST_TRY: undefined, LLM_FALLBACK_MODEL_ESCALATION: undefined, ...extra });

  it('no LLM_FALLBACK_PROVIDER: no fallback', () => {
    const deps = fallbackDepsOf(env({}));
    expect(deps.primary.name).toBe('anthropic');
    expect(deps.fallback).toBeNull();
  });

  it('LLM_FALLBACK_PROVIDER=openai: the slots from config/models.ts, without building the client (no key needed until a call fails over)', () => {
    const deps = fallbackDepsOf(env({ LLM_FALLBACK_PROVIDER: 'openai' }));
    expect(deps.fallback?.name).toBe('openai');
    expect(deps.fallback?.model('firstTry')).toBe('gpt-5-mini');
    expect(deps.fallback?.model('escalation')).toBe('gpt-5');
    // the OpenAI SDK refuses to build a client without a key (it also reads the process environment itself): building it lazily keeps a
    // working primary working
    if (!process.env.OPENAI_API_KEY) expect(() => deps.fallback!.create()).toThrow();
  });

  it('LLM_FALLBACK_MODEL_FIRST_TRY / _ESCALATION override the fallback\'s slots (and never the primary\'s)', () => {
    const e = env({ LLM_FALLBACK_PROVIDER: 'openai', LLM_FALLBACK_MODEL_FIRST_TRY: 'gpt-5-nano', LLM_FALLBACK_MODEL_ESCALATION: 'gpt-5-mini', OPENAI_API_KEY: 'sk-test' });
    const deps = fallbackDepsOf(e);
    expect([deps.fallback?.model('firstTry'), deps.fallback?.model('escalation')]).toEqual(['gpt-5-nano', 'gpt-5-mini']);
    expect(deps.fallback!.create().name).toBe('openai');
  });

  it('one breaker per primary provider, kept across calls', () => {
    const a = fallbackDepsOf(env({ LLM_FALLBACK_PROVIDER: 'openai' }));
    const b = fallbackDepsOf(env({ LLM_FALLBACK_PROVIDER: 'openai' }));
    expect(a.breaker).toBe(b.breaker);
  });

  it('a fake primary with a fake fallback works end to end (the dev wiring)', async () => {
    const primary = createFakeProvider();
    primary.enqueue({ error: new LlmError('rateLimited', 'fake', 'busy', { unavailable: 'rateLimited' }) });
    const fallback = createFakeProvider();
    fallback.enqueue({ json: { ok: true }, model: 'fallback-model' });
    const result = await completeWithFallback(request({ model: 'primary-model' }), {
      primary,
      fallback: { name: 'fake', create: () => fallback, model: () => 'fallback-model' },
      breaker: createCircuitBreaker({ tripAfter: 3, windowMs: 1000, coolDownMs: 1000 }),
      log: { warn: () => undefined, error: () => undefined },
    });
    expect(result).toMatchObject({ json: { ok: true }, model: 'fallback-model', fallback: { from: 'fake', reason: 'rateLimited' } });
    expect(fallback.calls[0]!.model).toBe('fallback-model');
  });
});
