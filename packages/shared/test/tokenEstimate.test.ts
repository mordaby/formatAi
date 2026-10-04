// Our own token estimate and its price table (learning-loop proposal, section 4): a documented heuristic, the published
// prices, the cache split of one call, and the rule that an unpriced model has no cost.
import { describe, expect, it } from 'vitest';
import { models } from '../src/config/models';
import { tokenPriceOf, tokenPrices } from '../src/config/pricing';
import { emptyEstimate, estimateCall, estimateCostUsd, estimateTokens, sumEstimates } from '../src/tokenEstimate';

describe('estimateTokens', () => {
  it('counts about 4 ASCII characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
  });

  it('counts JSON punctuation, digits and spaces like letters', () => {
    expect(estimateTokens('{"a":[1,2,3]}')).toBe(Math.ceil('{"a":[1,2,3]}'.length / 4));
  });

  it('counts about 1 token per 2 characters for non-ASCII text such as Hebrew', () => {
    expect(estimateTokens('שלום')).toBe(2);
    expect(estimateTokens('שלום עולם')).toBe(Math.ceil(1 / 4 + 8 / 2));
    expect(estimateTokens('א'.repeat(100))).toBe(50);
  });

  it('mixes the two rates inside one text', () => {
    expect(estimateTokens('name: שלום')).toBe(Math.ceil(6 / 4 + 4 / 2));
  });
});

describe('the price table', () => {
  it('has the published prices, per 1M tokens', () => {
    expect(tokenPriceOf('claude-haiku-4-5')).toEqual({ input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 });
    expect(tokenPriceOf('claude-sonnet-5')).toEqual({ input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 });
    expect(tokenPriceOf('claude-sonnet-5-5')).toEqual(tokenPriceOf('claude-sonnet-5'));
    expect(tokenPriceOf('gpt-5')).toEqual({ input: 1.25, cachedInput: 0.125, cacheWrite: 1.25, output: 10 });
    expect(tokenPriceOf('gpt-5-mini')).toEqual({ input: 0.25, cachedInput: 0.025, cacheWrite: 0.25, output: 2 });
  });

  it('prices the dated Haiku id like the undated one, and the CLI aliases like the API models they stand for', () => {
    expect(tokenPriceOf('claude-haiku-4-5-20251001')).toEqual(tokenPriceOf('claude-haiku-4-5'));
    expect(tokenPriceOf('haiku')).toEqual(tokenPriceOf('claude-haiku-4-5'));
    expect(tokenPriceOf('sonnet')).toEqual(tokenPriceOf('claude-sonnet-5'));
  });

  it('derives Anthropic cache prices from the input price (read 0.1x, write 1.25x) and gives OpenAI no write surcharge', () => {
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-5-5']) {
      const p = tokenPriceOf(id)!;
      expect(p.cachedInput).toBeCloseTo(p.input * 0.1, 10);
      expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 10);
    }
    for (const id of ['gpt-5', 'gpt-5-mini']) expect(tokenPriceOf(id)!.cacheWrite).toBe(tokenPriceOf(id)!.input);
  });

  it('prices every model the config can pick for a real provider (the fake provider has none)', () => {
    for (const [provider, slots] of Object.entries(models)) {
      if (provider === 'fake') continue;
      expect(tokenPriceOf(slots.firstTry), `${provider} firstTry ${slots.firstTry}`).not.toBeNull();
      expect(tokenPriceOf(slots.escalation), `${provider} escalation ${slots.escalation}`).not.toBeNull();
    }
    expect(Object.keys(tokenPrices).length).toBeGreaterThan(0);
  });

  it('has no price for an unknown model, and inherited object keys are not models', () => {
    expect(tokenPriceOf('some-future-model')).toBeNull();
    expect(tokenPriceOf(models.fake.firstTry)).toBeNull();
    expect(tokenPriceOf('toString')).toBeNull();
    expect(tokenPriceOf('constructor')).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  it('prices each kind of token at its own rate', () => {
    // haiku: 1.00 in, 0.10 cached, 1.25 write, 5.00 out per 1M
    const cost = estimateCostUsd('claude-haiku-4-5', { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(1 + 0.1 + 1.25 + 5, 10);
  });

  it('is null (never a guess) for a model with no price', () => {
    expect(estimateCostUsd('some-future-model', { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10 })).toBeNull();
  });
});

describe('estimateCall: the cache split of one call', () => {
  const text = { prefix: ['s'.repeat(400), 'x'.repeat(40)], blocks: ['p'.repeat(80), 'r'.repeat(20)], answer: 'a'.repeat(200) };
  // prefix 100 + 10 tokens, blocks 20 + 5, answer 50

  it('the first call of a learn WRITES the prefix; the rest of the input is full price', () => {
    const e = estimateCall('claude-haiku-4-5', text, false);
    expect(e).toMatchObject({ inputTokens: 25, cachedInputTokens: 0, cacheWriteTokens: 110, outputTokens: 50 });
    expect(e.costUsd).toBeCloseTo((25 * 1 + 110 * 1.25 + 50 * 5) / 1_000_000, 12);
  });

  it('a later call READS the prefix at the cached price', () => {
    const e = estimateCall('claude-haiku-4-5', text, true);
    expect(e).toMatchObject({ inputTokens: 25, cachedInputTokens: 110, cacheWriteTokens: 0, outputTokens: 50 });
    expect(e.costUsd).toBeCloseTo((25 * 1 + 110 * 0.1 + 50 * 5) / 1_000_000, 12);
  });

  it('an unpriced model keeps its counts and has no cost', () => {
    const e = estimateCall('fake-first-try', text, false);
    expect(e).toMatchObject({ inputTokens: 25, cacheWriteTokens: 110, outputTokens: 50, costUsd: null });
  });

  it('holds numbers only: no text of the call survives in it', () => {
    const e = estimateCall('claude-haiku-4-5', { prefix: ['SECRET-SYSTEM'], blocks: ['SECRET-CELL'], answer: 'SECRET-ANSWER' }, false);
    expect(Object.keys(e).sort()).toEqual(['cacheWriteTokens', 'cachedInputTokens', 'costUsd', 'inputTokens', 'outputTokens']);
    expect(Object.values(e).every((v) => typeof v === 'number')).toBe(true);
    expect(JSON.stringify(e)).not.toContain('SECRET');
  });
});

describe('emptyEstimate and sumEstimates', () => {
  it('a call that failed counts nothing; its cost is 0 for a priced model and null for an unpriced one', () => {
    expect(emptyEstimate('claude-haiku-4-5')).toEqual({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(emptyEstimate('fake-first-try').costUsd).toBeNull();
  });

  it('adds counts and costs up', () => {
    const text = { prefix: ['s'.repeat(400)], blocks: ['p'.repeat(80)], answer: 'a'.repeat(200) };
    const first = estimateCall('claude-haiku-4-5', text, false);
    const later = estimateCall('claude-haiku-4-5', text, true);
    const total = sumEstimates([first, later]);
    expect(total).toMatchObject({ inputTokens: 40, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100 });
    expect(total.costUsd).toBeCloseTo(first.costUsd! + later.costUsd!, 12);
  });

  it('the total has no cost as soon as one call has none; no calls cost nothing', () => {
    const text = { prefix: ['s'.repeat(400)], blocks: ['p'.repeat(80)], answer: 'a'.repeat(200) };
    expect(sumEstimates([estimateCall('claude-haiku-4-5', text, false), estimateCall('some-future-model', text, false)]).costUsd).toBeNull();
    expect(sumEstimates([])).toEqual({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});
