import { describe, expect, it } from 'vitest';
import { createFakeProvider } from '../../src/llm/providers/fake.js';
import type { CompleteRequest } from '../../src/llm/types.js';

function baseRequest(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    system: 'system prompt',
    content: [{ text: 'payload' }],
    schema: { type: 'object' },
    model: 'fake-model',
    purpose: 'learn',
    ...overrides,
  };
}

describe('fake provider', () => {
  it('serves queued responses in FIFO order', async () => {
    const provider = createFakeProvider();
    provider.enqueue({ json: { answer: 1 } });
    provider.enqueue({ json: { answer: 2 } });

    const first = await provider.complete(baseRequest());
    const second = await provider.complete(baseRequest());

    expect(first.json).toEqual({ answer: 1 });
    expect(second.json).toEqual({ answer: 2 });
    expect(first.provider).toBe('fake');
  });

  it('prefers a response registered for a matching request over the queue', async () => {
    const provider = createFakeProvider();
    const req = baseRequest({ model: 'special-model' });
    provider.enqueue({ json: { from: 'queue' } });
    provider.registerForRequest(req, { json: { from: 'keyed' } });

    const result = await provider.complete(req);
    expect(result.json).toEqual({ from: 'keyed' });
  });

  it('throws a providerError when no canned response is registered', async () => {
    const provider = createFakeProvider();
    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'providerError' });
  });

  it('throws the canned error when one is registered', async () => {
    const provider = createFakeProvider();
    const { LlmError } = await import('../../src/llm/errors.js');
    provider.enqueue({ error: new LlmError('rateLimited', 'fake', 'boom') });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'rateLimited' });
  });

  it('records every call it received', async () => {
    const provider = createFakeProvider();
    provider.enqueue({ json: {} });
    const req = baseRequest();
    await provider.complete(req);

    expect(provider.calls).toEqual([req]);
  });

  it('reset() clears the queue, keyed responses, and call log', async () => {
    const provider = createFakeProvider();
    provider.enqueue({ json: { a: 1 } });
    await provider.complete(baseRequest());
    provider.reset();

    expect(provider.calls).toHaveLength(0);
    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'providerError' });
  });

  it('defaults usage and cost to zero when not specified', async () => {
    const provider = createFakeProvider();
    provider.enqueue({ json: { a: 1 } });
    const result = await provider.complete(baseRequest());

    expect(result.usage).toEqual({ tokensIn: 0, tokensOut: 0, tokensCachedRead: 0, tokensCachedWrite: 0 });
    expect(result.costUsd).toBe(0);
  });
});
