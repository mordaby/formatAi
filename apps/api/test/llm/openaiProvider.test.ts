import OpenAI from 'openai';
import { learnResultJsonSchema, learnResultWireJsonSchema, limits, models, prices } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createOpenAiProvider, mapOpenAiError, openAiParamsOf, promptCacheKeyOf } from '../../src/llm/providers/openai.js';
import type { CompleteRequest } from '../../src/llm/types.js';

function fakeResponse(overrides: Record<string, unknown> = {}): OpenAI.Responses.Response {
  return {
    id: 'resp_1',
    model: models.openai.firstTry,
    output_text: '{"answer":42}',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 5, cache_write_tokens: 7 },
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 120,
    },
    ...overrides,
  } as unknown as OpenAI.Responses.Response;
}

function mockClient(create: (params: OpenAI.Responses.ResponseCreateParamsNonStreaming) => Promise<OpenAI.Responses.Response>) {
  return { responses: { create } } as unknown as OpenAI;
}

function baseRequest(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    system: 'you are a rules writer',
    content: [{ text: 'payload json' }],
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    model: models.openai.firstTry,
    purpose: 'learn',
    ...overrides,
  };
}

async function sentParams(overrides: Partial<CompleteRequest> = {}): Promise<OpenAI.Responses.ResponseCreateParamsNonStreaming> {
  const create = vi.fn().mockResolvedValue(fakeResponse());
  await createOpenAiProvider({ client: mockClient(create) }).complete(baseRequest(overrides));
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0]![0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
}

describe('openai provider - request building', () => {
  it('sends the system prompt as instructions, one user message, and a strict json_schema format', async () => {
    const params = await sentParams();

    expect(params.instructions).toBe('you are a rules writer');
    expect(Array.isArray(params.input)).toBe(true);
    expect(params.input).toHaveLength(1);

    const format = (params.text as unknown as { format: Record<string, unknown> }).format;
    expect(format.type).toBe('json_schema');
    expect(format.strict).toBe(true);
    // The schema handed to OpenAI is the strict-mode transform, not the raw schema:
    // every property must be required.
    const schema = format.schema as { required: string[] };
    expect(schema.required).toEqual(['name']);
  });

  it('builds a valid strict schema from the real generated LearnResult schema', async () => {
    const params = await sentParams({ schema: learnResultJsonSchema() });
    const format = (params.text as unknown as { format: Record<string, unknown> }).format;
    expect(format.strict).toBe(true);
    // Should not throw building this far - the real schema's root has no optional
    // fields, but nested ones (e.g. input.columns[].aliases) do; presence alone is
    // covered end-to-end in toOpenAiStrictSchema.test.ts.
    expect(format.schema).toBeTypeOf('object');
  });

  it('sends the wire schema the learn sends, transformed: no oneOf and no $schema reach OpenAI', async () => {
    const params = await sentParams({ schema: learnResultWireJsonSchema() });
    const text = JSON.stringify((params.text as unknown as { format: { schema: unknown } }).format.schema);
    // (as keywords: "oneOf" is also an operator's and a check's name, a `const` value)
    expect(text).not.toContain('"oneOf":');
    expect(text).not.toContain('"$schema":');
    expect(text).not.toContain('"minLength":');
  });
});

describe('openai provider - parameters per model (issue #45)', () => {
  it('the two configured slots (gpt-5-mini, gpt-5): reasoning effort low, no temperature / top_p, the reasoning room for output', async () => {
    for (const model of [models.openai.firstTry, models.openai.escalation]) {
      const params = await sentParams({ model });
      expect(params.reasoning, model).toEqual({ effort: 'low' });
      expect('temperature' in params, model).toBe(false);
      expect('top_p' in params, model).toBe(false);
      expect('top_logprobs' in params, model).toBe(false);
      expect(params.max_output_tokens, model).toBe(limits.llm.maxTokensThinking);
      expect(params.max_output_tokens!, model).toBeGreaterThan(limits.llm.maxTokens);
    }
  });

  it('a dated snapshot of the family and gpt-5-nano get the same settings; gpt-5.1 (another line) is not matched', () => {
    for (const model of ['gpt-5-mini-2025-08-07', 'gpt-5-2025-08-07', 'gpt-5-nano']) {
      expect(openAiParamsOf(model), model).toEqual({ effort: 'low', maxOutputTokens: limits.llm.maxTokensThinking });
    }
    expect(openAiParamsOf('gpt-5.1')).toEqual({ maxOutputTokens: limits.llm.maxTokensThinking });
  });

  it('a model the table does not know gets no reasoning field and no sampling parameter', async () => {
    const params = await sentParams({ model: 'some-future-model' });
    expect(params.reasoning).toBeUndefined();
    expect('temperature' in params).toBe(false);
    expect(params.max_output_tokens).toBe(limits.llm.maxTokensThinking);
  });

  it('the request\'s own maxTokens still wins', async () => {
    const params = await sentParams({ maxTokens: 1234 });
    expect(params.max_output_tokens).toBe(1234);
    expect(params.reasoning).toEqual({ effort: 'low' });
  });

  it('does not store the response (store: false)', async () => {
    expect((await sentParams()).store).toBe(false);
  });
});

describe('openai provider - prompt caching (implicit on the GPT-5 family)', () => {
  it('keeps the cache-friendly order - instructions, then the payload block, then the repair block - and sends no explicit breakpoint', async () => {
    const params = await sentParams({ content: [{ text: 'original payload', cache: true }, { text: 'repair block' }] });
    const input = params.input as unknown as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(input).toHaveLength(1);
    expect(input[0]!.role).toBe('user');
    expect(input[0]!.content).toEqual([
      { type: 'input_text', text: 'original payload' },
      { type: 'input_text', text: 'repair block' },
    ]);
    // explicit breakpoints are GPT-5.6-and-later only (OpenAI's prompt-caching guide)
    expect(params.prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain('prompt_cache_breakpoint');
  });

  it('sends a stable prompt_cache_key per system prompt, made from nothing but the prompt', async () => {
    const a = await sentParams({ content: [{ text: 'payload one' }] });
    const b = await sentParams({ content: [{ text: 'payload two' }] });
    const c = await sentParams({ system: 'another prompt version' });
    expect(a.prompt_cache_key).toBe(promptCacheKeyOf('you are a rules writer'));
    expect(b.prompt_cache_key).toBe(a.prompt_cache_key);
    expect(c.prompt_cache_key).not.toBe(a.prompt_cache_key);
    expect(a.prompt_cache_key).toMatch(/^formatai-learn-[0-9a-f]{16}$/);
  });
});

describe('openai provider - response mapping', () => {
  it('parses output_text as JSON, strips optional-field nulls, and maps usage/cost', async () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, nickname: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    };
    const create = vi.fn().mockResolvedValue(fakeResponse({ output_text: '{"name":"Ada","nickname":null}' }));
    const provider = createOpenAiProvider({ client: mockClient(create) });

    const result = await provider.complete(baseRequest({ schema }));

    // "nickname" was optional in the original schema and came back null (OpenAI's
    // forced-required encoding) - it should be dropped, not kept as null.
    expect(result.json).toEqual({ name: 'Ada' });
    expect(result.raw).toBe('{"name":"Ada","nickname":null}');
    expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 20, tokensCachedRead: 5, tokensCachedWrite: 7 });
    expect(result.provider).toBe('openai');

    const pricing = prices[models.openai.firstTry]!;
    const expectedCost =
      (100 * pricing.inputPerMTok) / 1_000_000 +
      (20 * pricing.outputPerMTok) / 1_000_000 +
      (5 * pricing.cacheReadPerMTok) / 1_000_000 +
      (7 * pricing.cacheWritePerMTok) / 1_000_000;
    expect(result.costUsd).toBeCloseTo(expectedCost, 12);
  });

  it('prices the dated snapshot the API reports as the model it served', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse({ model: 'gpt-5-mini-2025-08-07' }));
    const result = await createOpenAiProvider({ client: mockClient(create) }).complete(baseRequest());
    expect(result.model).toBe('gpt-5-mini-2025-08-07');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('throws an "invalidJson" LlmError when output_text is not valid JSON', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse({ output_text: 'not json' }));
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'invalidJson' });
  });

  it('a refusal content part is a "refused" LlmError (not invalid JSON, not a fail-over trigger)', async () => {
    const create = vi.fn().mockResolvedValue(
      fakeResponse({ output_text: '', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] }),
    );
    const err = await createOpenAiProvider({ client: mockClient(create) }).complete(baseRequest()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'refused', provider: 'openai' });
    expect((err as { unavailable?: string }).unavailable).toBeUndefined();
  });

  it('X2: an answer cut off at max_output_tokens (status incomplete) is a truncated result with the call\'s usage - not an invalidJson error', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"name":"ab' }));
    const result = await createOpenAiProvider({ client: mockClient(create) }).complete(baseRequest());
    expect(result).toMatchObject({ truncated: true, json: null, raw: '{"name":"ab', provider: 'openai' });
    expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 20, tokensCachedRead: 5, tokensCachedWrite: 7 });
  });

  it('X2: a cut-off answer with no visible text at all (the reasoning used the whole limit) is truncated too', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '' }));
    const result = await createOpenAiProvider({ client: mockClient(create) }).complete(baseRequest());
    expect(result).toMatchObject({ truncated: true, json: null, raw: '' });
  });

  it('an incomplete answer for another reason (a content filter) is not called truncated', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output_text: '{"name":"ab' }));
    await expect(createOpenAiProvider({ client: mockClient(create) }).complete(baseRequest())).rejects.toMatchObject({ kind: 'invalidJson' });
  });
});

describe('openai provider - error mapping (and the fail-over triggers, SPEC 9.6)', () => {
  const headers = new Headers();

  it('maps RateLimitError to kind "rateLimited", unavailable', async () => {
    const err = new OpenAI.RateLimitError(429, {}, 'rate limited', headers);
    const create = vi.fn().mockRejectedValue(err);
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'rateLimited', provider: 'openai', unavailable: 'rateLimited' });
  });

  it('maps AuthenticationError to kind "refused", unavailable "auth"', async () => {
    const err = new OpenAI.AuthenticationError(401, {}, 'bad key', headers);
    const create = vi.fn().mockRejectedValue(err);
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'refused', unavailable: 'auth' });
  });

  it('maps any other APIError to kind "providerError"', async () => {
    const err = new OpenAI.BadRequestError(400, {}, 'bad request', headers);
    const create = vi.fn().mockRejectedValue(err);
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'providerError' });
  });

  it('marks exactly the provider-level failures as unavailable', () => {
    const cases: [unknown, string | undefined][] = [
      [new OpenAI.APIConnectionError({ message: 'socket hang up' }), 'network'],
      [new OpenAI.APIConnectionTimeoutError(), 'timeout'],
      [new OpenAI.RateLimitError(429, {}, 'quota', headers), 'rateLimited'],
      [new OpenAI.InternalServerError(500, {}, 'boom', headers), 'serverError'],
      [new OpenAI.InternalServerError(503, {}, 'slow down', headers), 'serverError'],
      [new OpenAI.AuthenticationError(401, {}, 'bad key', headers), 'auth'],
      [new OpenAI.PermissionDeniedError(403, {}, 'no access', headers), 'auth'],
      // our bugs and other answers: never a fail-over
      [new OpenAI.BadRequestError(400, {}, 'unsupported parameter', headers), undefined],
      [new OpenAI.NotFoundError(404, {}, 'no such model', headers), undefined],
      [new OpenAI.UnprocessableEntityError(422, {}, 'bad', headers), undefined],
      [new OpenAI.APIUserAbortError(), undefined],
      [new Error('a bug'), undefined],
    ];
    for (const [err, unavailable] of cases) {
      expect(mapOpenAiError(err).unavailable, String(err)).toBe(unavailable);
    }
  });

  it('never puts the SDK message (which can quote a redacted key) into the LlmError message', () => {
    const err = new OpenAI.AuthenticationError(401, {}, 'Incorrect API key provided: sk-proj-****abcd', headers);
    expect(mapOpenAiError(err).message).not.toContain('sk-');
  });
});
