import Anthropic from '@anthropic-ai/sdk';
import { limits, models, prices } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider, mapAnthropicError } from '../../src/llm/providers/anthropic.js';
import type { CompleteRequest } from '../../src/llm/types.js';

function fakeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: models.anthropic.firstTry,
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: '{"answer":42}', citations: null }],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
    },
    ...overrides,
  } as Anthropic.Message;
}

function mockClient(create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>) {
  return { messages: { create } } as unknown as Anthropic;
}

function baseRequest(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    system: 'you are a rules writer',
    content: [{ text: 'payload json' }],
    schema: { type: 'object', properties: { answer: { type: 'number' } } },
    model: models.anthropic.firstTry,
    purpose: 'learn',
    ...overrides,
  };
}

describe('anthropic provider - request building (LEARN_PROMPT §1, SPEC 9.1)', () => {
  it('sends exactly one user message, a cached system prompt, and the schema', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage());
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await provider.complete(baseRequest());

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;

    expect(params.system).toEqual([{ type: 'text', text: 'you are a rules writer', cache_control: { type: 'ephemeral' } }]);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]!.role).toBe('user');
    expect(params.output_config).toEqual({ format: { type: 'json_schema', schema: baseRequest().schema } });
    expect(params.max_tokens).toBe(limits.llm.maxTokens);
  });

  it('marks only content blocks flagged cache:true with a cache breakpoint (repair calls)', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage());
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await provider.complete(
      baseRequest({
        content: [
          { text: 'original payload', cache: true },
          { text: 'repair block' },
        ],
      }),
    );

    const params = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    const content = params.messages[0]!.content as Anthropic.TextBlockParam[];
    expect(content).toEqual([
      { type: 'text', text: 'original payload', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'repair block' },
    ]);
  });

  it('respects an explicit maxTokens override', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage());
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await provider.complete(baseRequest({ maxTokens: 999 }));

    const params = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.max_tokens).toBe(999);
  });

  it('sends temperature 0 for a model that still supports it (haiku-4-5)', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage());
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await provider.complete(baseRequest({ model: 'claude-haiku-4-5-20251001' }));

    const params = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.temperature).toBe(0);
  });

  it('omits temperature for a model where sampling params are removed (claude-sonnet-5, the escalation slot)', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage({ model: 'claude-sonnet-5' }));
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await provider.complete(baseRequest({ model: 'claude-sonnet-5' }));

    const params = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.temperature).toBeUndefined();
  });
});

// Prompt audit X2: thinking counts toward max_tokens, so each model is sent what keeps the answer inside it - thinking off where the model
// allows it, room where it cannot be turned off (claude-api skill, "Thinking & Effort").
describe('anthropic provider - thinking and max_tokens per model (X2)', () => {
  async function paramsFor(model: string, overrides: Partial<CompleteRequest> = {}): Promise<Anthropic.MessageCreateParamsNonStreaming> {
    const create = vi.fn().mockResolvedValue(fakeMessage({ model }));
    await createAnthropicProvider({ client: mockClient(create) }).complete(baseRequest({ model, ...overrides }));
    return create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
  }

  it('the two configured slots: Haiku 4.5 (no thinking unless asked) gets no thinking field; Sonnet 5 (adaptive by default) gets thinking disabled', async () => {
    const haiku = await paramsFor(models.anthropic.firstTry);
    expect(models.anthropic.firstTry).toBe('claude-haiku-4-5-20251001');
    expect(haiku).not.toHaveProperty('thinking');
    expect(haiku.max_tokens).toBe(limits.llm.maxTokens);
    expect(haiku.temperature).toBe(0);

    const sonnet = await paramsFor(models.anthropic.escalation);
    expect(models.anthropic.escalation).toBe('claude-sonnet-5');
    expect(sonnet.thinking).toEqual({ type: 'disabled' });
    expect(sonnet.max_tokens).toBe(limits.llm.maxTokens);
    expect(sonnet).not.toHaveProperty('temperature');
    // (no effort is sent: Sonnet 5's default, high, is one that accepts disabled thinking)
    expect(sonnet.output_config).not.toHaveProperty('effort');
  });

  it('every other model: Sonnet 5.5 between_tools; Opus 5 disabled; Opus 5.5 / Fable / Mythos (always thinking) no field and room; Opus 4.8 / 4.7 / 4.6 nothing', async () => {
    const cases: [string, Anthropic.ThinkingConfigParam | undefined, number][] = [
      ['claude-sonnet-5-5', { type: 'between_tools' }, limits.llm.maxTokens],
      ['claude-opus-5', { type: 'disabled' }, limits.llm.maxTokens],
      ['claude-opus-5-5', undefined, limits.llm.maxTokensThinking],
      ['claude-fable-5-1', undefined, limits.llm.maxTokensThinking],
      ['claude-fable-5', undefined, limits.llm.maxTokensThinking],
      ['claude-mythos-5-1', undefined, limits.llm.maxTokensThinking],
      ['claude-opus-4-8', undefined, limits.llm.maxTokens],
      ['claude-opus-4-7', undefined, limits.llm.maxTokens],
      ['claude-opus-4-6', undefined, limits.llm.maxTokens],
      ['claude-sonnet-4-6', undefined, limits.llm.maxTokens],
    ];
    for (const [model, thinking, maxTokens] of cases) {
      const params = await paramsFor(model);
      expect(params.thinking, model).toEqual(thinking);
      expect(params.max_tokens, model).toBe(maxTokens);
    }
    expect(limits.llm.maxTokensThinking).toBeGreaterThan(limits.llm.maxTokens);
  });

  it('the request\'s own maxTokens still wins, on a thinking model too', async () => {
    expect((await paramsFor('claude-opus-5-5', { maxTokens: 999 })).max_tokens).toBe(999);
    expect((await paramsFor('claude-sonnet-5', { maxTokens: 999 })).max_tokens).toBe(999);
  });
});

describe('anthropic provider - response mapping', () => {
  it('parses the text block as JSON and maps usage/cost/model', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage());
    const provider = createAnthropicProvider({ client: mockClient(create) });

    const result = await provider.complete(baseRequest());

    expect(result.json).toEqual({ answer: 42 });
    expect(result.raw).toBe('{"answer":42}');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe(models.anthropic.firstTry);
    expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 20, tokensCachedRead: 5, tokensCachedWrite: 7 });

    const pricing = prices[models.anthropic.firstTry]!;
    const expectedCost =
      (100 * pricing.inputPerMTok) / 1_000_000 +
      (20 * pricing.outputPerMTok) / 1_000_000 +
      (5 * pricing.cacheReadPerMTok) / 1_000_000 +
      (7 * pricing.cacheWritePerMTok) / 1_000_000;
    expect(result.costUsd).toBeCloseTo(expectedCost, 12);
  });

  it('defaults null cache usage fields to 0', async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null } as never }),
    );
    const provider = createAnthropicProvider({ client: mockClient(create) });

    const result = await provider.complete(baseRequest());
    expect(result.usage.tokensCachedRead).toBe(0);
    expect(result.usage.tokensCachedWrite).toBe(0);
  });

  it('throws a "refused" LlmError when stop_reason is "refusal"', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage({ stop_reason: 'refusal' }));
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'refused' });
  });

  it('throws an "invalidJson" LlmError when the text block is not valid JSON', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage({ content: [{ type: 'text', text: 'not json', citations: null }] }));
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'invalidJson' });
  });

  it('X2: an answer cut off at max_tokens is a truncated result with the call\'s usage and cost - not an invalidJson error', async () => {
    for (const stop_reason of ['max_tokens', 'model_context_window_exceeded'] as const) {
      const create = vi.fn().mockResolvedValue(fakeMessage({ stop_reason, content: [{ type: 'text', text: '{"answer":4', citations: null }] }));
      const result = await createAnthropicProvider({ client: mockClient(create) }).complete(baseRequest());
      expect(result).toMatchObject({ truncated: true, json: null, raw: '{"answer":4', provider: 'anthropic' });
      expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 20, tokensCachedRead: 5, tokensCachedWrite: 7 });
      expect(result.costUsd).toBeGreaterThan(0);
    }
  });

  it('a whole answer is never marked truncated', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage());
    const result = await createAnthropicProvider({ client: mockClient(create) }).complete(baseRequest());
    expect(result.truncated).toBeUndefined();
  });
});

describe('anthropic provider - error mapping', () => {
  it('maps RateLimitError to kind "rateLimited"', async () => {
    const err = new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'rateLimited', provider: 'anthropic' });
  });

  it('maps APIConnectionTimeoutError to kind "timeout"', async () => {
    const err = new Anthropic.APIConnectionTimeoutError({ message: 'timed out' });
    const create = vi.fn().mockRejectedValue(err);
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps AuthenticationError to kind "refused"', async () => {
    const err = new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'refused' });
  });

  it('maps any other APIError to kind "providerError"', async () => {
    const err = new Anthropic.BadRequestError(400, {}, 'bad request', new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const provider = createAnthropicProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'providerError' });
  });

  it('SPEC 9.6: marks exactly the provider-level failures as unavailable (the fail-over triggers)', () => {
    const h = new Headers();
    const overloadedBody = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    const cases: [unknown, string | undefined][] = [
      [new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'network'],
      [new Anthropic.APIConnectionTimeoutError({ message: 'timed out' }), 'timeout'],
      [new Anthropic.RateLimitError(429, {}, 'rate limited', h), 'rateLimited'],
      [Anthropic.APIError.generate(529, overloadedBody, 'Overloaded', h), 'overloaded'],
      [new Anthropic.InternalServerError(500, { type: 'error', error: { type: 'api_error' } }, 'boom', h), 'serverError'],
      [new Anthropic.InternalServerError(503, {}, 'unavailable', h), 'serverError'],
      [new Anthropic.AuthenticationError(401, {}, 'bad key', h), 'auth'],
      [new Anthropic.PermissionDeniedError(403, {}, 'no access', h), 'auth'],
      // the request's fault (our bug) or not an outage: never a fail-over
      [new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error' } }, 'bad', h), undefined],
      [new Anthropic.NotFoundError(404, {}, 'no such model', h), undefined],
      [Anthropic.APIError.generate(413, {}, 'too large', h), undefined],
      [new Anthropic.APIUserAbortError(), undefined],
      [new Error('a bug'), undefined],
    ];
    for (const [err, unavailable] of cases) {
      expect(mapAnthropicError(err).unavailable, String(err)).toBe(unavailable);
    }
    expect(mapAnthropicError(Anthropic.APIError.generate(529, overloadedBody, 'Overloaded', h)).message).toContain('overloaded');
  });

  it('a refusal (stop_reason "refusal") is not a fail-over trigger', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage({ stop_reason: 'refusal', content: [] }));
    const err = await createAnthropicProvider({ client: mockClient(create) }).complete(baseRequest()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'refused' });
    expect((err as { unavailable?: string }).unavailable).toBeUndefined();
  });

  it('never includes payload text in a thrown error message (SPEC 15)', async () => {
    const secret = 'super-secret-cell-value-should-never-leak';
    const err = new Anthropic.BadRequestError(400, {}, secret, new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const provider = createAnthropicProvider({ client: mockClient(create) });

    try {
      await provider.complete(baseRequest({ content: [{ text: secret }] }));
      expect.unreachable();
    } catch (thrown) {
      expect((thrown as Error).message).not.toContain(secret);
    }
  });
});
