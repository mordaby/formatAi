// SPEC 9.4: "Prices per million tokens are in config ... used to compute the cost of
// every call." A model with no price entry (e.g. an operator override via
// LLM_MODEL_FIRST_TRY/LLM_MODEL_ESCALATION that isn't in packages/shared/config/prices.ts
// yet) costs $0 rather than throwing, with a one-time warning per model so a bad
// override doesn't silently break every learn call or spam the log.
import { prices, type ModelPricing } from '@formatai/shared';
import type { LlmUsage } from './types.js';

const warnedModels = new Set<string>();

function perMillion(tokens: number, ratePerMTok: number): number {
  return (tokens * ratePerMTok) / 1_000_000;
}

export function computeCostUsd(model: string, usage: LlmUsage): number {
  const pricing: ModelPricing | undefined = prices[model];
  if (!pricing) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`no price configured for ${model}`);
    }
    return 0;
  }

  return (
    perMillion(usage.tokensIn, pricing.inputPerMTok) +
    perMillion(usage.tokensOut, pricing.outputPerMTok) +
    perMillion(usage.tokensCachedRead, pricing.cacheReadPerMTok) +
    perMillion(usage.tokensCachedWrite, pricing.cacheWritePerMTok)
  );
}

/** Test-only: clears the "no price configured" one-time-warning memory between tests. */
export function resetCostWarnings(): void {
  warnedModels.clear();
}
