import OpenAI from 'openai';
import { learnResultJsonSchema, limits, models, prices } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createOpenAiProvider } from '../../src/llm/providers/openai.js';
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

describe('openai provider - request building', () => {
  it('sends the system prompt as instructions, one user message, and a strict json_schema format', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse());
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await provider.complete(baseRequest());

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;

    expect(params.instructions).toBe('you are a rules writer');
    expect(Array.isArray(params.input)).toBe(true);
    expect(params.input).toHaveLength(1);
    expect(params.temperature).toBe(limits.llm.temperature);
    expect(params.max_output_tokens).toBe(limits.llm.maxTokens);

    const format = (params.text as unknown as { format: Record<string, unknown> }).format;
    expect(format.type).toBe('json_schema');
    expect(format.strict).toBe(true);
    // The schema handed to OpenAI is the strict-mode transform, not the raw schema:
    // every property must be required.
    const schema = format.schema as { required: string[] };
    expect(schema.required).toEqual(['name']);
  });

  it('marks a cache-flagged content block with an explicit prompt cache breakpoint', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse());
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await provider.complete(baseRequest({ content: [{ text: 'original payload', cache: true }, { text: 'repair block' }] }));

    const params = create.mock.calls[0]![0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const input = params.input as unknown as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(input[0]!.content[0]).toMatchObject({ type: 'input_text', text: 'original payload', prompt_cache_breakpoint: { mode: 'explicit' } });
    expect(input[0]!.content[1]).toEqual({ type: 'input_text', text: 'repair block' });
    expect(params.prompt_cache_options).toEqual({ mode: 'explicit' });
  });

  it('omits prompt_cache_options when no block requests caching', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse());
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await provider.complete(baseRequest());

    const params = create.mock.calls[0]![0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    expect(params.prompt_cache_options).toBeUndefined();
  });

  it('builds a valid strict schema from the real generated LearnResult schema', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse());
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await provider.complete(baseRequest({ schema: learnResultJsonSchema() }));

    const params = create.mock.calls[0]![0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const format = (params.text as unknown as { format: Record<string, unknown> }).format;
    expect(format.strict).toBe(true);
    // Should not throw building this far - the real schema's root has no optional
    // fields, but nested ones (e.g. input.columns[].aliases) do; presence alone is
    // covered end-to-end in toOpenAiStrictSchema.test.ts.
    expect(format.schema).toBeTypeOf('object');
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

  it('throws an "invalidJson" LlmError when output_text is not valid JSON', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse({ output_text: 'not json' }));
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'invalidJson' });
  });
});

describe('openai provider - error mapping', () => {
  it('maps RateLimitError to kind "rateLimited"', async () => {
    const err = new OpenAI.RateLimitError(429, {}, 'rate limited', new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'rateLimited', provider: 'openai' });
  });

  it('maps AuthenticationError to kind "refused"', async () => {
    const err = new OpenAI.AuthenticationError(401, {}, 'bad key', new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'refused' });
  });

  it('maps any other APIError to kind "providerError"', async () => {
    const err = new OpenAI.BadRequestError(400, {}, 'bad request', new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const provider = createOpenAiProvider({ client: mockClient(create) });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'providerError' });
  });
});
