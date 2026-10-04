// Our own token estimate for an LLM call (learning-loop proposal, section 4): counted from the exact text we send and
// receive, priced with the providers' published prices (config/pricing.ts). It exists so a change to the learn flow can
// be compared before and after WITHOUT an API key; it is an estimate, not what any provider bills.
//
// COUNTS ONLY: an estimate holds numbers and a price, never any of the text it was counted from (SPEC 15).
import { tokenPriceOf } from './config/pricing';

/** DECISION: no tokenizer dependency. A documented heuristic: ~4 characters per token for ASCII text (JSON punctuation,
 * digits and spaces counted like letters) and ~1 token per 2 characters for everything else (Hebrew, accents, symbols,
 * which tokenizers split into short pieces). Good to a few tens of percent, and the same on both sides of a comparison. */
const ASCII_CHARS_PER_TOKEN = 4;
const OTHER_CHARS_PER_TOKEN = 2;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN);
}

export interface TokenEstimate {
  /** Input tokens at the full input price (everything but the cached prefix). */
  inputTokens: number;
  /** The cached prefix (system prompt + output schema), read from the prompt cache. */
  cachedInputTokens: number;
  /** The same prefix, written to the cache by the first call of a learn (Anthropic's write price; OpenAI's is the input price). */
  cacheWriteTokens: number;
  outputTokens: number;
  /** USD at the published prices; null when the model has no price (never a guess). */
  costUsd: number | null;
}

/** The exact text of one call, split by how it is billed. */
export interface CallText {
  /** The cached prefix: the system prompt and the output schema / tool definition sent with it. */
  prefix: readonly string[];
  /** The rest of the input: every user content block (payload, repair block). */
  blocks: readonly string[];
  /** The answer's raw text (empty when the call failed). */
  answer: string;
}

export function estimateCostUsd(model: string, counts: Omit<TokenEstimate, 'costUsd'>): number | null {
  const price = tokenPriceOf(model);
  if (!price) return null;
  return (
    (counts.inputTokens * price.input +
      counts.cachedInputTokens * price.cachedInput +
      counts.cacheWriteTokens * price.cacheWrite +
      counts.outputTokens * price.output) /
    1_000_000
  );
}

const sumTokens = (texts: readonly string[]): number => texts.reduce((n, t) => n + estimateTokens(t), 0);

/**
 * The estimate of one call. DECISION (caching model): the system prompt and the schema are the cached prefix. The FIRST
 * call of a learn on a model writes it (`prefixCached` false: cache write on Anthropic, plain input on OpenAI); every later
 * call of the same learn on that model reads it (`prefixCached` true). The rest of the input is full price. The payload
 * block's own cache breakpoint on a repair call is not credited: a slight over-estimate of repairs, the same before and after.
 */
export function estimateCall(model: string, text: CallText, prefixCached: boolean): TokenEstimate {
  const prefixTokens = sumTokens(text.prefix);
  const counts = {
    inputTokens: sumTokens(text.blocks),
    cachedInputTokens: prefixCached ? prefixTokens : 0,
    cacheWriteTokens: prefixCached ? 0 : prefixTokens,
    outputTokens: estimateTokens(text.answer),
  };
  return { ...counts, costUsd: estimateCostUsd(model, counts) };
}

/** A call that failed sent nothing we can bill and received no answer: zeros (the cost is still null for an unpriced model). */
export function emptyEstimate(model: string): TokenEstimate {
  const counts = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  return { ...counts, costUsd: estimateCostUsd(model, counts) };
}

/** The estimates of several calls added up; the cost is null when any call's is (one unpriced model makes the total unknown). */
export function sumEstimates(estimates: readonly TokenEstimate[]): TokenEstimate {
  const total: TokenEstimate = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const e of estimates) {
    total.inputTokens += e.inputTokens;
    total.cachedInputTokens += e.cachedInputTokens;
    total.cacheWriteTokens += e.cacheWriteTokens;
    total.outputTokens += e.outputTokens;
    total.costUsd = total.costUsd === null || e.costUsd === null ? null : total.costUsd + e.costUsd;
  }
  return total;
}
