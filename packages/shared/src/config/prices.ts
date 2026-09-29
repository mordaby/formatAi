// SPEC 9.4: "Prices per million tokens are in config, copied from the provider's
// pricing page, and used to compute the cost of every call."
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

// TODO(M1): copy the exact numbers from the provider's current pricing page for
// every model listed in config/models.ts before computing real costs. These are
// placeholders only, roughly shaped on typical cache-read/cache-write ratios.
export const prices: Record<string, ModelPricing> = {
  [models.firstTry]: {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  [models.escalation]: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
};
