// SPEC 9.6: the one LLM interface. Every provider adapter implements `LlmProvider`;
// no provider SDK may be imported outside `apps/api/src/llm/providers/`.
import type { LlmProviderName } from '@formatai/shared';

export type { LlmProviderName };

/**
 * One block of the single user message. SPEC 9.1/9.3: a plain learn call sends one
 * block (the payload); a repair call sends two - the original payload with
 * `cache: true` (read from cache), then the repair block.
 */
export interface ContentBlock {
  text: string;
  /** Mark a prompt-cache breakpoint after this block (SPEC 9.1, LEARN_PROMPT §1/§4). */
  cache?: boolean;
}

/** SPEC 9.1/9.3/9.4: why this call is being made, logged with the ledger entry. */
export type CallPurpose = 'learn' | 'repair' | 'escalation';

export interface CompleteRequest {
  /** The fixed system prompt (LEARN_PROMPT §2), always cached. */
  system: string;
  /** Exactly one user message, made of one or more content blocks. */
  content: ContentBlock[];
  /** The LearnResult JSON Schema (or any structured-output schema) to constrain the reply to. */
  schema: Record<string, unknown>;
  model: string;
  purpose: CallPurpose;
  /** Defaults to `limits.llm.maxTokens` (SPEC 9.1) when omitted - `limits.llm.maxTokensThinking` for an Anthropic model that always thinks. */
  maxTokens?: number;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  tokensCachedRead: number;
  tokensCachedWrite: number;
}

export interface CompleteResult {
  /** The parsed structured output (null when `truncated`). */
  json: unknown;
  /** The raw text the model/CLI returned, before parsing - never logged (SPEC 15). */
  raw: string;
  /**
   * Prompt audit X2: the model stopped at the output-token limit before the answer was complete (Anthropic `stop_reason` `max_tokens` or
   * `model_context_window_exceeded`, OpenAI `incomplete_details.reason` `max_output_tokens`, the CLI's `stop_reason`). `json` is then null,
   * `raw` the text so far, and usage and cost are the call's own (a cut answer is billed). Its own outcome - never an invalid-JSON error.
   */
  truncated?: boolean;
  usage: LlmUsage;
  costUsd: number;
  latencyMs: number;
  /** The model that actually served the call (may echo back `req.model`). */
  model: string;
  provider: LlmProviderName;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
