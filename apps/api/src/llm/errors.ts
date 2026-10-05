// SPEC 9.6/15: a typed error every provider adapter normalizes into. Messages must
// never include payload text (cell values, headers, file names) - SPEC 15 "Logs never
// contain cell values, file names or payloads." Provider-diagnostic text (an SDK error
// message, a CLI status line) is fine; the untrusted user payload is not.
import type { LlmProviderName } from '@formatai/shared';

export type LlmErrorKind = 'timeout' | 'rateLimited' | 'refused' | 'invalidJson' | 'providerError';

/**
 * SPEC 9.6 "Fallback": why a provider could not serve a call AT ALL - the provider-level failures a call fails over on. Set by each
 * adapter's error mapping; absent on every error that is the request's fault (a 400: our bug, it fails loudly) or the answer's (a refusal,
 * invalid JSON - those go through repair like any wrong answer).
 *   - `network`: the request never got an HTTP answer (connection refused or reset, DNS);
 *   - `timeout`: no answer within the client's timeout;
 *   - `rateLimited`: HTTP 429 (a rate limit, or an account out of credit);
 *   - `overloaded`: Anthropic's `overloaded_error` (HTTP 529);
 *   - `serverError`: any other HTTP 5xx;
 *   - `auth`: HTTP 401 / 403 - a bad, revoked or under-privileged key (see `fallback.ts` for why this fails over too).
 */
export type UnavailableReason = 'network' | 'timeout' | 'rateLimited' | 'overloaded' | 'serverError' | 'auth';

/** SPEC 9.6/13: a call the fallback provider served, and why: the primary's failure, or `circuitOpen` (the primary was not tried). */
export type FallbackReason = UnavailableReason | 'circuitOpen';

/** A call served (or attempted) by the fallback provider instead of the primary (`CompleteResult.fallback`, `LlmError.fallback`). */
export interface CallFallback {
  /** The primary provider the call was meant for. */
  from: LlmProviderName;
  reason: FallbackReason;
}

export interface LlmErrorOptions {
  cause?: unknown;
  /** The call could not be served at all (see `UnavailableReason`): a fail-over trigger. */
  unavailable?: UnavailableReason;
  /** The model this failed call was made with, when it is not the one the caller asked for (the fallback's). */
  model?: string;
  /** The failed call was the fallback's (the primary had failed, or its circuit was open). */
  fallback?: CallFallback;
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: LlmProviderName;
  readonly unavailable?: UnavailableReason;
  readonly model?: string;
  readonly fallback?: CallFallback;

  constructor(kind: LlmErrorKind, provider: LlmProviderName, message: string, options?: LlmErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmError';
    this.kind = kind;
    this.provider = provider;
    if (options?.unavailable) this.unavailable = options.unavailable;
    if (options?.model) this.model = options.model;
    if (options?.fallback) this.fallback = options.fallback;
  }
}
