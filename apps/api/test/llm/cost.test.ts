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

  it('reports $0 and warns once for a model with no price entry (e.g. an LLM_MODEL_* override)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cost1 = computeCostUsd('some-unpriced-model', { ...zeroUsage, tokensIn: 1_000_000 });
    const cost2 = computeCostUsd('some-unpriced-model', { ...zeroUsage, tokensIn: 1_000_000 });

    expect(cost1).toBe(0);
    expect(cost2).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('some-unpriced-model'));

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
