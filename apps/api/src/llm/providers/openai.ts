// SPEC 9.6: "No provider SDK is imported anywhere else" - `openai` may only be
// imported from files under this directory.
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
}

export function createOpenAiProvider(opts: CreateOpenAiProviderOptions = {}): LlmProvider {
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey });

  return {
    name: 'openai',
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const start = Date.now();

      // OpenAI strict structured outputs require every property `required` (optional
      // ones made nullable) and reject the schema's few open dictionaries in strict
      // mode - see the doc comment in schema/toOpenAiStrictSchema.ts.
      const strictSchema = toOpenAiStrictSchema(req.schema);

      const hasCacheBreakpoint = req.content.some((block) => block.cache);

      const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
        model: req.model,
        // Closest Responses-API analog to Anthropic's `system`: a frozen instruction
        // block placed before `input`. OpenAI's own prefix caching covers it
        // automatically; there is no separate breakpoint marker for `instructions`
        // itself (only for `input` content items, used below).
        instructions: req.system,
        input: [
          {
            role: 'user',
            content: req.content.map((block) => ({
              type: 'input_text' as const,
              text: block.text,
              ...(block.cache ? { prompt_cache_breakpoint: { mode: 'explicit' as const } } : {}),
            })),
          },
        ],
        max_output_tokens: req.maxTokens ?? limits.llm.maxTokens,
        temperature: limits.llm.temperature,
        text: {
          format: {
            type: 'json_schema',
            name: 'learn_result',
            schema: strictSchema,
            strict: true,
          },
        },
        ...(hasCacheBreakpoint ? { prompt_cache_options: { mode: 'explicit' as const } } : {}),
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

function mapOpenAiError(err: unknown): LlmError {
  if (err instanceof OpenAI.RateLimitError) {
    return new LlmError('rateLimited', 'openai', 'rate limited', { cause: err });
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError('timeout', 'openai', 'request timed out', { cause: err });
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError('refused', 'openai', 'authentication or permission error', { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    return new LlmError('providerError', 'openai', `openai API error (status ${err.status ?? 'unknown'})`, {
      cause: err,
    });
  }
  return new LlmError('providerError', 'openai', 'unexpected openai provider error', { cause: err });
}
