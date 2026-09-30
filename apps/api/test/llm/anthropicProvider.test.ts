import Anthropic from '@anthropic-ai/sdk';
import { limits, models, prices } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../../src/llm/providers/anthropic.js';
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
