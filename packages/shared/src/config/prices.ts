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

const GPT_5_MINI: ModelPricing = { inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025, cacheWritePerMTok: 0.25 };
const GPT_5: ModelPricing = { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 };

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
  // OpenAI (the fallback provider, SPEC 9.6): checked 2026-10-05 against the gpt-5 / gpt-5-mini model pages
  // (developers.openai.com/api/docs/models/...): gpt-5-mini $0.25 in / $0.025 cached in / $2 out, gpt-5 $1.25 / $0.125 / $10. No cache-write
  // surcharge on these models (the prompt-caching guide), so a write costs the input price. The API reports the dated snapshot it served
  // (`gpt-5-mini-2025-08-07`, each model page's "default snapshot"), so that id is priced too - else a fallback call would cost $0.
  [models.openai.firstTry]: GPT_5_MINI,
  'gpt-5-mini-2025-08-07': GPT_5_MINI,
  [models.openai.escalation]: GPT_5,
  'gpt-5-2025-08-07': GPT_5,
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
