// SPEC 9.4: "Prices per million tokens are in config ... used to compute the cost of
// every call." DECISION (API audit C6, 2026-10-07): a model with no price entry (e.g. an operator override via
// LLM_MODEL_FIRST_TRY/LLM_MODEL_ESCALATION that isn't in packages/shared/config/prices.ts yet, or a snapshot id a
// provider reports) is priced at the HIGHEST configured price - each rate the highest any configured model has - so the
// daily budget (the kill switch) still sees it. It used to cost $0, which the budget never counted. Fail closed: an
// unknown model may be over-counted, never under. A one-time warning per model says so, without spamming the log.
// A production start refuses a configured model with no price at all (`productionConfig.ts`).
import { prices, type ModelPricing } from '@formatai/shared';
import type { LlmUsage } from './types.js';

const warnedModels = new Set<string>();

function perMillion(tokens: number, ratePerMTok: number): number {
  return (tokens * ratePerMTok) / 1_000_000;
}

/** Each rate the highest any configured model has: what an unpriced model costs (see the file header). */
export function highestPrice(): ModelPricing {
  const all = Object.values(prices);
  const max = (rate: keyof ModelPricing): number => Math.max(0, ...all.map((p) => p[rate]));
  return { inputPerMTok: max('inputPerMTok'), outputPerMTok: max('outputPerMTok'), cacheReadPerMTok: max('cacheReadPerMTok'), cacheWritePerMTok: max('cacheWritePerMTok') };
}

/** Whether `model` has a price of its own in config (`prices`). */
export function hasPrice(model: string): boolean {
  return Object.hasOwn(prices, model);
}

export function computeCostUsd(model: string, usage: LlmUsage): number {
  let pricing: ModelPricing | undefined = hasPrice(model) ? prices[model] : undefined;
  if (!pricing) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`no price configured for ${model}: counted at the highest configured price`);
    }
    pricing = highestPrice();
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
