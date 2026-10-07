import { models, prices } from '@formatai/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCostUsd, resetCostWarnings } from '../../src/llm/cost.js';
import type { LlmUsage } from '../../src/llm/types.js';

const zeroUsage: LlmUsage = { tokensIn: 0, tokensOut: 0, tokensCachedRead: 0, tokensCachedWrite: 0 };

describe('computeCostUsd (SPEC 9.4)', () => {
  beforeEach(() => resetCostWarnings());
  afterEach(() => resetCostWarnings());

  it('multiplies each token bucket by its per-million price', () => {
    const model = models.anthropic.firstTry;
    const pricing = prices[model]!;
    const usage: LlmUsage = { tokensIn: 1000, tokensOut: 500, tokensCachedRead: 2000, tokensCachedWrite: 300 };

    const expected =
      (1000 * pricing.inputPerMTok) / 1_000_000 +
      (500 * pricing.outputPerMTok) / 1_000_000 +
      (2000 * pricing.cacheReadPerMTok) / 1_000_000 +
      (300 * pricing.cacheWritePerMTok) / 1_000_000;

    expect(computeCostUsd(model, usage)).toBeCloseTo(expected, 12);
  });

  it('returns 0 for zero usage', () => {
    expect(computeCostUsd(models.anthropic.firstTry, zeroUsage)).toBe(0);
  });

  it('API audit C6: prices a model with no price entry (e.g. an LLM_MODEL_* override) at the HIGHEST configured price, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage: LlmUsage = { tokensIn: 1_000_000, tokensOut: 1_000_000, tokensCachedRead: 1_000_000, tokensCachedWrite: 1_000_000 };
    const all = Object.values(prices);
    const top = (rate: 'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok') => Math.max(...all.map((p) => p[rate]));

    const cost1 = computeCostUsd('some-unpriced-model', usage);
    const cost2 = computeCostUsd('some-unpriced-model', usage);

    expect(cost1).toBeCloseTo(top('inputPerMTok') + top('outputPerMTok') + top('cacheReadPerMTok') + top('cacheWritePerMTok'), 9);
    expect(cost1).toBeGreaterThan(0); // was $0: the budget never saw the call
    for (const model of Object.keys(prices)) expect(cost1).toBeGreaterThanOrEqual(computeCostUsd(model, usage));
    expect(cost2).toBe(cost1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('some-unpriced-model'));

    warn.mockRestore();
  });

  it('never takes an inherited object key for a price', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(computeCostUsd('constructor', { ...zeroUsage, tokensIn: 1_000_000 })).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('warns separately for different unpriced models', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    computeCostUsd('unpriced-a', zeroUsage);
    computeCostUsd('unpriced-b', zeroUsage);

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reports claude-cli models at $0 without a warning (priced at $0 in config, not "unpriced")', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(computeCostUsd(models['claude-cli'].firstTry, { ...zeroUsage, tokensIn: 1_000_000 })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
