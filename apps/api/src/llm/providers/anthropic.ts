// SPEC 9.6: "No provider SDK is imported anywhere else" - `@anthropic-ai/sdk` may only
// be imported from files under this directory.
import Anthropic from '@anthropic-ai/sdk';
import { limits } from '@formatai/shared';
import { LlmError } from '../errors.js';
import { computeCostUsd } from '../cost.js';
import type { CompleteRequest, CompleteResult, LlmProvider, LlmUsage } from '../types.js';

export interface CreateAnthropicProviderOptions {
  apiKey?: string;
  /** Dependency injection for tests: an already-constructed (or mocked) client. */
  client?: Anthropic;
}

// SPEC 9.1: "temperature 0 if the model supports it." Per the current Anthropic API
// docs, `temperature` (and the rest of top-level sampling) is REMOVED (400) on:
// Fable 5/5.1, Mythos 5/5.1/preview, Opus 5.5, Opus 5, Opus 4.7, Opus 4.8, and
// Sonnet 5. It is still accepted on Opus 4.6, Sonnet 4.6, Haiku 4.5, and older
// models. This matters here because config/models.ts's `escalation` slot
// (claude-sonnet-5) is one of the models where sending `temperature` 400s.
const NO_TEMPERATURE_MODEL_PREFIXES = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-mythos-5-1',
  'claude-mythos-5',
  'claude-mythos-preview',
  'claude-opus-4-8',
  'claude-opus-4-7',
];

function supportsTemperature(model: string): boolean {
  return !NO_TEMPERATURE_MODEL_PREFIXES.some((prefix) => model === prefix || model.startsWith(`${prefix}-`));
}

export function createAnthropicProvider(opts: CreateAnthropicProviderOptions = {}): LlmProvider {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });

  return {
    name: 'anthropic',
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const start = Date.now();

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        max_tokens: req.maxTokens ?? limits.llm.maxTokens,
        // LEARN_PROMPT §1: system prompt, marked with a cache breakpoint.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        // SPEC 9.1/9.3: exactly one user message; its content is one or more blocks,
        // with a cache breakpoint on any block the caller flagged (the repair call's
        // original-payload block).
        messages: [
          {
            role: 'user',
            content: req.content.map((block) => ({
              type: 'text' as const,
              text: block.text,
              ...(block.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
            })),
          },
        ],
        output_config: { format: { type: 'json_schema', schema: req.schema } },
      };

      if (supportsTemperature(req.model)) {
        params.temperature = limits.llm.temperature;
      }

      let response: Anthropic.Message;
      try {
        response = await client.messages.create(params);
      } catch (err) {
        throw mapAnthropicError(err);
      }

      if (response.stop_reason === 'refusal') {
        throw new LlmError('refused', 'anthropic', 'the model refused to respond');
      }

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );
      const raw = textBlock?.text ?? '';

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new LlmError('invalidJson', 'anthropic', 'model response was not valid JSON');
      }

      const usage: LlmUsage = {
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        tokensCachedRead: response.usage.cache_read_input_tokens ?? 0,
        tokensCachedWrite: response.usage.cache_creation_input_tokens ?? 0,
      };

      return {
        json,
        raw,
        usage,
        costUsd: computeCostUsd(response.model, usage),
        latencyMs: Date.now() - start,
        model: response.model,
        provider: 'anthropic',
      };
    },
  };
}

function mapAnthropicError(err: unknown): LlmError {
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError('rateLimited', 'anthropic', 'rate limited', { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('timeout', 'anthropic', 'request timed out', { cause: err });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('refused', 'anthropic', 'authentication or permission error', { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError('providerError', 'anthropic', `anthropic API error (status ${err.status ?? 'unknown'})`, {
      cause: err,
    });
  }
  return new LlmError('providerError', 'anthropic', 'unexpected anthropic provider error', { cause: err });
}
