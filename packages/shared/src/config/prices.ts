// SPEC 9.4: "Prices per million tokens are in config, copied from the provider's
// pricing page, and used to compute the cost of every call." Keyed by model id
// (unique across providers), not by provider, since `complete()` only ever sees a
// bare model string.
import { models } from './models';

export interface ModelPricing {
  /** USD per million input tokens (uncached). */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million tokens served from the prompt cache. */
  cacheReadPerMTok: number;
  /** USD per million tokens written to the prompt cache. */
  cacheWritePerMTok: number;
}

export const prices: Record<string, ModelPricing> = {
  // Anthropic: current published per-token pricing (verified against the current
  // Anthropic pricing page at the time these were written). Cache write/read follow
  // Anthropic's standard ratios (1.25x / 0.1x of the uncached input price).
  [models.anthropic.firstTry]: {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  [models.anthropic.escalation]: {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  },
  // TODO(M1): copy the exact numbers from https://openai.com/api/pricing/ for
  // whichever models config/models.ts actually settles on. Placeholders only.
  [models.openai.firstTry]: {
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.025,
    cacheWritePerMTok: 0.25,
  },
  [models.openai.escalation]: {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    cacheWritePerMTok: 1.25,
  },
  // claude-cli runs on the developer's own Claude subscription (SPEC 9.6, dev-only
  // provider) - every call is reported at $0 ("subscription"), never metered here.
  // Kept in this table only so a lookup by model id doesn't fall through to the
  // "unknown model" warning for these two aliases.
  [models['claude-cli'].firstTry]: {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
  [models['claude-cli'].escalation]: {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
};
