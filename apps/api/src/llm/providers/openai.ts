// SPEC 9.6: "No provider SDK is imported anywhere else" - `openai` may only be
// imported from files under this directory.
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { limits } from '@formatai/shared';
import { LlmError } from '../errors.js';
import { computeCostUsd } from '../cost.js';
import { toOpenAiStrictSchema, stripOpenAiNulls } from '../schema/toOpenAiStrictSchema.js';
import type { CompleteRequest, CompleteResult, LlmProvider, LlmUsage } from '../types.js';

export interface CreateOpenAiProviderOptions {
  apiKey?: string;
  /** Dependency injection for tests: an already-constructed (or mocked) client. */
  client?: OpenAI;
  /** The SDK client's timeout per attempt (default: the SDK's, 10 minutes); set for a primary that has a fallback (`limits.llm.fallback`). */
  timeoutMs?: number;
  /** The SDK client's own retries (default: the SDK's, 2); set for a primary that has a fallback. */
  maxRetries?: number;
}

// Issue #45: the request parameters per model. Per OpenAI's docs (checked 2026-10-05: the "Using GPT-5" guide, the gpt-5 / gpt-5-mini model
// pages, the reasoning guide and the Responses API reference):
//   - gpt-5, gpt-5-mini and gpt-5-nano are reasoning models (400k context, 128k max output, Responses API, structured outputs);
//   - "reasoning.effort supports minimal, low, medium, and high" for the GPT-5 family (`none` arrived with later models; the default is
//     `medium`);
//   - with reasoning active, `temperature`, `top_p` and `top_logprobs` are not supported: they are never sent;
//   - reasoning tokens count toward `max_output_tokens`, like Anthropic's thinking tokens toward `max_tokens`, so the answer can be cut off
//     (`incomplete` with `max_output_tokens`, checked below).
// The more specific prefix is listed first. `gpt-5-mini-2025-08-07` (a dated snapshot) is matched by its family's prefix; `gpt-5.1` and
// later are NOT (`gpt-5.` does not start with `gpt-5-`): their efforts and defaults differ, so they need their own row before use.
//
// DECISION (issue #45, as SPEC 9.1 does for Anthropic): the lowest effort the model accepts - `minimal` for the GPT-5 family. The answer is one
// schema-constrained object the first-try model writes in one go; reasoning is billed as output and adds latency on every call. Whether more
// effort pays for itself is an eval question.
const OPENAI_REASONING_MODELS: readonly { prefix: string; effort: OpenAI.ReasoningEffort }[] = [
  { prefix: 'gpt-5-mini', effort: 'minimal' },
  { prefix: 'gpt-5-nano', effort: 'minimal' },
  { prefix: 'gpt-5', effort: 'minimal' },
];

function isModel(model: string, prefix: string): boolean {
  return model === prefix || model.startsWith(`${prefix}-`);
}

export interface OpenAiModelParams {
  /** `reasoning.effort` to send (absent: none sent, the model's own default applies). */
  effort?: OpenAI.ReasoningEffort;
  maxOutputTokens: number;
}

/**
 * The per-model parameters of a request (`maxTokens`: the request's own, when it set one). A reasoning model of the table gets its lowest
 * effort and `limits.llm.maxTokensThinking` (16,000) so that reasoning plus the answer fit. DECISION: 16,000, not the reasoning guide's
 * "reserve at least 25,000 when you start experimenting" - that is for the default (`medium`) effort; at `minimal` the reasoning is short,
 * and the answer itself stays within `limits.llm.maxTokens` (4,000). A cut-off answer is still recorded as `truncated` and repaired.
 *
 * No request carries `temperature` / `top_p` (SPEC 9.1 "temperature 0 if the model supports it": no model here supports it). DECISION (a
 * model the table does not know, e.g. an `LLM_MODEL_*` override): only what every current model accepts - no sampling parameter (a
 * reasoning model rejects it, a model that would accept it merely samples at its default), no `reasoning` field (its default effort
 * applies), and the reasoning room. Add the model's row before relying on it.
 */
export function openAiParamsOf(model: string, maxTokens?: number): OpenAiModelParams {
  const reasoning = OPENAI_REASONING_MODELS.find((m) => isModel(model, m.prefix));
  if (reasoning) return { effort: reasoning.effort, maxOutputTokens: maxTokens ?? limits.llm.maxTokensThinking };
  return { maxOutputTokens: maxTokens ?? limits.llm.maxTokensThinking };
}

/**
 * Prompt caching (OpenAI's prompt-caching guide, checked 2026-10-05). Before GPT-5.6 caching is implicit only: OpenAI places breakpoints at
 * model-dependent intervals of the prefix (the hidden system message, `instructions`, the output schema, then `input` in order) and caches
 * any prefix past the minimum length (about 1,024 tokens) automatically, at no write surcharge; explicit breakpoints
 * (`prompt_cache_breakpoint`, `prompt_cache_options.mode: "explicit"`) are GPT-5.6-and-later only. The request is therefore built
 * cache-friendly by ORDER - the fixed system prompt and schema first, then the payload block, then (a repair call) the repair block - and
 * carries a stable `prompt_cache_key`, which "helps route related requests to the same cache" on these models. DECISION: one key per system
 * prompt text (a hash, so a new prompt version routes apart), never anything from the payload.
 */
export function promptCacheKeyOf(system: string): string {
  return `formatai-learn-${createHash('sha256').update(system).digest('hex').slice(0, 16)}`;
}

export function createOpenAiProvider(opts: CreateOpenAiProviderOptions = {}): LlmProvider {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    });

  return {
    name: 'openai',
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const start = Date.now();
      const { effort, maxOutputTokens } = openAiParamsOf(req.model, req.maxTokens);

      // OpenAI strict structured outputs accept a subset of JSON Schema (every property required, optional ones nullable, no `oneOf`, ...):
      // see the doc comment in schema/toOpenAiStrictSchema.ts. The answer is mapped back below, so it parses with the same zod schema.
      const strictSchema = toOpenAiStrictSchema(req.schema);

      const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
        model: req.model,
        // The closest Responses-API analog to Anthropic's `system`: the fixed instruction block, placed before `input` - the start of the
        // cached prefix (see `promptCacheKeyOf`).
        instructions: req.system,
        // SPEC 9.1/9.3: exactly one user message; its content is one or more blocks, in order (the payload, then a repair block).
        input: [
          {
            role: 'user',
            content: req.content.map((block) => ({ type: 'input_text' as const, text: block.text })),
          },
        ],
        max_output_tokens: maxOutputTokens,
        ...(effort ? { reasoning: { effort } } : {}),
        text: {
          format: {
            type: 'json_schema',
            name: 'learn_result',
            schema: strictSchema,
            strict: true,
          },
        },
        prompt_cache_key: promptCacheKeyOf(req.system),
        // DECISION (SPEC 15 "LLM retention"): the answer is read once and never continued, so the response is not stored as application state
        // (the Responses API stores it by default); what OpenAI keeps is then its abuse-monitoring logs only, as the privacy page says.
        store: false,
      };

      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create(params);
      } catch (err) {
        throw mapOpenAiError(err);
      }

      const raw = response.output_text ?? '';
      const usage: LlmUsage = {
        tokensIn: response.usage?.input_tokens ?? 0,
        tokensOut: response.usage?.output_tokens ?? 0,
        tokensCachedRead: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        tokensCachedWrite: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
      };
      const model = response.model ?? req.model;
      const served = { usage, costUsd: computeCostUsd(model, usage), model, provider: 'openai' as const };

      // Prompt audit X2: the Responses API's cut-off answer (`max_output_tokens` counts a reasoning model's reasoning tokens too) is its
      // own outcome, with the call's usage - never "not valid JSON".
      if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
        return { json: null, raw, truncated: true, ...served, latencyMs: Date.now() - start };
      }

      // A refusal comes back as a `refusal` content part instead of the JSON (structured outputs' documented edge case).
      const refused = response.output?.some(
        (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
      );
      if (refused) throw new LlmError('refused', 'openai', 'the model refused to respond');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new LlmError('invalidJson', 'openai', 'model response was not valid JSON');
      }
      // Undo the strict-mode required+nullable transform so the result validates
      // against the original (non-strict) LearnResult schema again.
      const json = stripOpenAiNulls(req.schema, parsed);

      return { json, raw, ...served, latencyMs: Date.now() - start };
    },
  };
}

/**
 * The SDK's error -> our `LlmError`; `unavailable` marks a fail-over trigger exactly as `mapAnthropicError` does (429 - a rate limit or an
 * account out of credit -, 5xx, 401 / 403, a connection error, a timeout). Every other HTTP error (400 invalid request - an unsupported
 * parameter or schema keyword -, 404 unknown model ...) is the request's fault and fails loudly.
 */
export function mapOpenAiError(err: unknown): LlmError {
  if (err instanceof OpenAI.RateLimitError) {
    return new LlmError('rateLimited', 'openai', 'rate limited', { cause: err, unavailable: 'rateLimited' });
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError('timeout', 'openai', 'request timed out', { cause: err, unavailable: 'timeout' });
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmError('providerError', 'openai', 'could not reach the openai API (connection error)', { cause: err, unavailable: 'network' });
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError('refused', 'openai', `authentication or permission error (status ${err.status})`, { cause: err, unavailable: 'auth' });
  }
  if (err instanceof OpenAI.APIError && !(err instanceof OpenAI.APIUserAbortError)) {
    const unavailable = typeof err.status === 'number' && err.status >= 500 ? 'serverError' : undefined;
    return new LlmError('providerError', 'openai', `openai API error (status ${err.status ?? 'unknown'})`, {
      cause: err,
      ...(unavailable ? { unavailable } : {}),
    });
  }
  return new LlmError('providerError', 'openai', 'unexpected openai provider error', { cause: err });
}
