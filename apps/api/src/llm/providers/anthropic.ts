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

function isModel(model: string, prefix: string): boolean {
  return model === prefix || model.startsWith(`${prefix}-`);
}

function supportsTemperature(model: string): boolean {
  return !NO_TEMPERATURE_MODEL_PREFIXES.some((prefix) => isModel(model, prefix));
}

// Prompt audit X2: thinking per model. Thinking tokens count toward `max_tokens` whether or not their text is returned, and the request used
// to send no `thinking` field, so a model that thinks by default (Sonnet 5, the escalation slot) spent part of the 4,000 on thinking and an
// answer could be cut off. Per the current Anthropic API docs (the claude-api skill, "Thinking & Effort"; checked 2026-10-04):
//   - Haiku 4.5, Opus 4.8 / 4.7, Opus 4.6 / Sonnet 4.6 and older: no thinking unless the request asks for it - nothing is sent;
//   - Sonnet 5, Opus 5: adaptive thinking when the field is omitted; `{ type: "disabled" }` is accepted at effort `high` or below (no
//     effort is sent, so the default `high` applies);
//   - Sonnet 5.5: `{ type: "disabled" }` is a 400; `{ type: "between_tools" }` is its lowest setting (no extended thinking; effort `high`
//     or below, no other field beside it);
//   - Opus 5.5, Fable 5 / 5.1, Mythos: thinking cannot be turned off (any setting but adaptive is a 400) - they get room for it instead.
// The more specific prefix is listed first: `claude-sonnet-5-5` also starts with `claude-sonnet-5-`.
//
// DECISION (cost versus quality): thinking off wherever the model allows it, and a bigger `max_tokens` only where it cannot be turned
// off. The answer is one schema-constrained JSON object that the first-try model (Haiku 4.5) writes without thinking; the escalation slot is
// a stronger model on the same single-shot task, not a reasoning mode. Left on, adaptive thinking at Sonnet 5's default effort (high) spends
// billed output tokens ($10/MTok) and seconds on every escalation, bounded only by `max_tokens` - which then cuts the answer. Nothing in
// the eval has shown that thinking makes this answer better; whether it pays for itself on the hardest learns is an eval question now that
// a cut answer is recorded as `truncated`. Turning it back on is a change of this table plus room in `max_tokens`.
const ALWAYS_THINKING_MODEL_PREFIXES = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-1', 'claude-mythos-5', 'claude-mythos-preview'];
const BETWEEN_TOOLS_MODEL_PREFIXES = ['claude-sonnet-5-5'];
const DISABLE_THINKING_MODEL_PREFIXES = ['claude-sonnet-5', 'claude-opus-5'];

/** The `thinking` field (absent: none sent) and the `max_tokens` default of a model (`maxTokens`: the request's own, when it set one). */
export function thinkingParamsOf(model: string, maxTokens?: number): { thinking?: Anthropic.ThinkingConfigParam; maxTokens: number } {
  if (ALWAYS_THINKING_MODEL_PREFIXES.some((p) => isModel(model, p))) return { maxTokens: maxTokens ?? limits.llm.maxTokensThinking };
  const base = maxTokens ?? limits.llm.maxTokens;
  if (BETWEEN_TOOLS_MODEL_PREFIXES.some((p) => isModel(model, p))) return { thinking: { type: 'between_tools' }, maxTokens: base };
  if (DISABLE_THINKING_MODEL_PREFIXES.some((p) => isModel(model, p))) return { thinking: { type: 'disabled' }, maxTokens: base };
  return { maxTokens: base };
}

/** X2: the stop reasons of an answer cut off before it was complete (`model_context_window_exceeded`: the context filled up mid-answer). */
const TRUNCATED_STOP_REASONS: readonly (Anthropic.StopReason | null)[] = ['max_tokens', 'model_context_window_exceeded'];

export function createAnthropicProvider(opts: CreateAnthropicProviderOptions = {}): LlmProvider {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });

  return {
    name: 'anthropic',
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const start = Date.now();
      const { thinking, maxTokens } = thinkingParamsOf(req.model, req.maxTokens);

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        max_tokens: maxTokens,
        // X2: thinking off where the model allows it (see `thinkingParamsOf`); nothing sent where it never thinks unasked.
        ...(thinking ? { thinking } : {}),
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

      const usage: LlmUsage = {
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        tokensCachedRead: response.usage.cache_read_input_tokens ?? 0,
        tokensCachedWrite: response.usage.cache_creation_input_tokens ?? 0,
      };
      const served = { usage, costUsd: computeCostUsd(response.model, usage), model: response.model, provider: 'anthropic' as const };

      // X2: an answer cut off at the limit is its own outcome (with the call's usage: it is billed), never "not valid JSON".
      if (TRUNCATED_STOP_REASONS.includes(response.stop_reason)) {
        return { json: null, raw, truncated: true, ...served, latencyMs: Date.now() - start };
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new LlmError('invalidJson', 'anthropic', 'model response was not valid JSON');
      }

      return { json, raw, ...served, latencyMs: Date.now() - start };
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
