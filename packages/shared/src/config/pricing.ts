// Published per-token prices for OUR OWN token estimate (see ../tokenEstimate.ts), USD per 1M tokens.
//
// DECISION: a second table next to `prices.ts`, on purpose. `prices.ts` prices what a provider REPORTS (SPEC 9.4)
// and puts the dev "claude-cli" slots at $0 (a subscription, never metered); this one prices what WE count, so the
// dev provider's runs can be compared before and after a change without an API key: the CLI's own numbers include
// Claude Code's overhead and thinking tokens (~15k output tokens per call) and cannot be used for cost.
//
// Sources, verified 2026-10-04: Anthropic's current model table (haiku 4.5: $1 in / $5 out; sonnet 5 and 5.5:
// $2 in / $10 out per 1M tokens) and OpenAI's pricing page https://developers.openai.com/api/docs/pricing
// (gpt-5: $1.25 in / $0.125 cached in / $10 out; gpt-5-mini: $0.25 / $0.025 / $2.00). Copy new numbers from those
// pages, never from memory; a model with no entry here has NO estimated cost (`null`), never a guess.

export interface TokenPrice {
  /** Input tokens that are neither read from nor written to the prompt cache. */
  input: number;
  /** Input tokens read from the prompt cache. */
  cachedInput: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  /** Output tokens. */
  output: number;
}

/** Anthropic: a cache read costs 0.1 x the input price, a cache write (5-minute TTL) 1.25 x. */
const ANTHROPIC_CACHE_READ_FACTOR = 0.1;
const ANTHROPIC_CACHE_WRITE_FACTOR = 1.25;

function anthropicPrice(input: number, output: number): TokenPrice {
  return { input, cachedInput: input * ANTHROPIC_CACHE_READ_FACTOR, cacheWrite: input * ANTHROPIC_CACHE_WRITE_FACTOR, output };
}

/** OpenAI has no cache-write surcharge: writing the prefix costs the plain input price. */
function openAiPrice(input: number, cachedInput: number, output: number): TokenPrice {
  return { input, cachedInput, cacheWrite: input, output };
}

const HAIKU = anthropicPrice(1, 5);
const SONNET = anthropicPrice(2, 10);

export const tokenPrices: Readonly<Record<string, TokenPrice>> = {
  'claude-haiku-4-5': HAIKU,
  // The dated id `config/models.ts` configures for the Anthropic first-try slot.
  'claude-haiku-4-5-20251001': HAIKU,
  'claude-sonnet-5': SONNET,
  'claude-sonnet-5-5': SONNET,
  'gpt-5': openAiPrice(1.25, 0.125, 10),
  'gpt-5-mini': openAiPrice(0.25, 0.025, 2),
  // DECISION: the Claude Code CLI's model aliases are priced as the API models they stand for ("haiku" = Haiku 4.5,
  // "sonnet" = Sonnet 5): the subscription is not metered, but the estimate says what the same tokens would cost on the API.
  haiku: HAIKU,
  sonnet: SONNET,
};

/** The price of a model id, or null when it has none (an unpriced model never gets a guessed cost). */
export function tokenPriceOf(model: string): TokenPrice | null {
  return Object.hasOwn(tokenPrices, model) ? tokenPrices[model]! : null;
}
