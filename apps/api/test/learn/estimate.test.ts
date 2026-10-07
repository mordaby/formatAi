// The per-call token estimate on every `LlmCallRecord` (learning-loop proposal, section 4): counted from the text we send and
// receive, split by the prompt cache across the calls of ONE learn, priced with the published prices, counts only.
import { describe, expect, it } from 'vitest';
import { estimateTokens, learnResultWireJsonSchema, LEARN_SYSTEM_PROMPT, sumEstimates, tokenPriceOf, type TokenEstimate } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, LlmError, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { learn, repairFromBrowser, type CompleteFn } from '../../src/learn/index.js';
import { basicPayload, correctRules, correctRulesWireJson, wrongRoundingWireJson } from './fixtures.js';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });
const fakeCompleteFn = (fake: FakeLlmProvider): CompleteFn => (req: CompleteRequest) => fake.complete(req);

/** Priced models, so the cost is a number; the fake provider's own ids have no price. */
const PRICED = { firstTry: 'claude-haiku-4-5', escalation: 'claude-sonnet-5' };
const PREFIX_TOKENS = estimateTokens(LEARN_SYSTEM_PROMPT) + estimateTokens(JSON.stringify(learnResultWireJsonSchema()));

describe('LlmCallRecord.estimate', () => {
  it('counts the exact text sent and received: the cached prefix, every content block and the raw answer', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    const sent = fake.calls[0]!;
    const e = outcome.calls[0]!.estimate;
    expect(e.inputTokens).toBe(sent.content.reduce((n, b) => n + estimateTokens(b.text), 0));
    expect(e.outputTokens).toBe(estimateTokens(JSON.stringify(correctRulesWireJson())));
    expect(e.cacheWriteTokens).toBe(PREFIX_TOKENS);
    expect(PREFIX_TOKENS).toBeGreaterThan(1000); // the system prompt alone is thousands of tokens
    expect(e.cachedInputTokens).toBe(0);
  });

  it('the first call of a learn writes the prefix; the repair call of the same learn reads it and pays for its extra block', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wrongRoundingWireJson() });
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    const [first, repair] = outcome.calls.map((c) => c.estimate);
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair']);
    expect(first).toMatchObject({ cacheWriteTokens: PREFIX_TOKENS, cachedInputTokens: 0 });
    expect(repair).toMatchObject({ cacheWriteTokens: 0, cachedInputTokens: PREFIX_TOKENS });
    expect(repair!.inputTokens).toBe(estimateTokens(fake.calls[1]!.content[0]!.text) + estimateTokens(fake.calls[1]!.content[1]!.text));
    expect(repair!.inputTokens).toBeGreaterThan(first!.inputTokens);
  });

  it('prices the calls with the published prices: a write at 1.25x the input price, a read at 0.1x', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wrongRoundingWireJson() });
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    const haiku = tokenPriceOf('claude-haiku-4-5')!;
    const [first, repair] = outcome.calls.map((c) => c.estimate);
    const cost = (e: TokenEstimate) => (e.inputTokens * haiku.input + e.cachedInputTokens * haiku.cachedInput + e.cacheWriteTokens * haiku.cacheWrite + e.outputTokens * haiku.output) / 1_000_000;
    expect(first!.costUsd).toBeCloseTo(cost(first!), 12);
    expect(repair!.costUsd).toBeCloseTo(cost(repair!), 12);
    expect(outcome.calls.reduce((n, c) => n + c.estimate.costUsd!, 0)).toBeCloseTo(sumEstimates(outcome.calls.map((c) => c.estimate)).costUsd!, 12);
  });

  it('the escalation is a different model: it pays for the prefix again, at ITS price', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wrongRoundingWireJson() }); // learn
    fake.enqueue({ json: wrongRoundingWireJson() }); // repair, still wrong
    fake.enqueue({ json: correctRulesWireJson() }); // escalation

    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    const [first, repair, escalation] = outcome.calls.map((c) => c.estimate);
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair', 'escalation']);
    expect(first).toMatchObject({ cacheWriteTokens: PREFIX_TOKENS, cachedInputTokens: 0 });
    expect(repair).toMatchObject({ cacheWriteTokens: 0, cachedInputTokens: PREFIX_TOKENS });
    expect(escalation).toMatchObject({ cacheWriteTokens: PREFIX_TOKENS, cachedInputTokens: 0 });
    const sonnet = tokenPriceOf('claude-sonnet-5')!;
    expect(escalation!.costUsd).toBeCloseTo((escalation!.inputTokens * sonnet.input + PREFIX_TOKENS * sonnet.cacheWrite + escalation!.outputTokens * sonnet.output) / 1_000_000, 12);
  });

  it('a learn does not share the cache with another learn: its first call writes again', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });
    fake.enqueue({ json: correctRulesWireJson() });

    const a = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });
    const b = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    expect(a.calls[0]!.estimate.cacheWriteTokens).toBe(PREFIX_TOKENS);
    expect(b.calls[0]!.estimate.cacheWriteTokens).toBe(PREFIX_TOKENS);
  });

  it('the browser repair call of a learn reads the prefix', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await repairFromBrowser(
      basicPayload(),
      { ...correctRules(), transform: { ...correctRules().transform, computed: [] } },
      [{ kind: 'diff', out: 1, sample: 0, expected: 20, actual: 10 }],
      { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) },
    );

    expect(outcome.calls[0]!.estimate).toMatchObject({ cacheWriteTokens: 0, cachedInputTokens: PREFIX_TOKENS });
    expect(outcome.calls[0]!.estimate.costUsd).toEqual(expect.any(Number));
  });

  it('a model with no price keeps its counts and has no cost (never a guess)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.calls[0]!.estimate).toMatchObject({ cacheWriteTokens: PREFIX_TOKENS, costUsd: null });
    expect(outcome.calls[0]!.estimate.outputTokens).toBeGreaterThan(0);
  });

  it('a call that failed counts nothing and does not write the prefix: the next call on that model does', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ error: new LlmError('rateLimited', 'fake', 'rate limited') });
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    const [failed, repair] = outcome.calls;
    expect(failed!.outcome).toBe('error:rateLimited');
    expect(failed!.estimate).toEqual({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(repair!.estimate.cacheWriteTokens).toBe(PREFIX_TOKENS);
    expect(repair!.estimate.cachedInputTokens).toBe(0);
  });

  it('is counts and a price only: nothing of the payload, the prompt or the answer is in the record', async () => {
    const fake = createFakeProvider();
    const payload = basicPayload({ samples: [{ in: ['ZQXJcell', 10], out: ['ZQXJcell', 20] }] });
    fake.enqueue({ json: wrongRoundingWireJson() });
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(payload, { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    for (const c of outcome.calls) {
      expect(Object.keys(c.estimate).sort()).toEqual(['cacheWriteTokens', 'cachedInputTokens', 'costUsd', 'inputTokens', 'outputTokens']);
      expect(Object.values(c.estimate).every((v) => typeof v === 'number')).toBe(true);
    }
    const text = JSON.stringify(outcome.calls);
    expect(text).not.toContain('ZQXJcell');
    expect(text).not.toContain('Amount');
    expect(text).not.toContain(LEARN_SYSTEM_PROMPT.slice(0, 40));
  });

  it('leaves the provider-reported fields as they are', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson(), usage: { tokensIn: 100, tokensOut: 50, tokensCachedRead: 20, tokensCachedWrite: 5 }, costUsd: 0.25 });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, models: PRICED, complete: fakeCompleteFn(fake) });

    expect(outcome.calls[0]).toMatchObject({ tokensIn: 100, tokensOut: 50, tokensCached: 25, costUsd: 0.25 });
  });
});
