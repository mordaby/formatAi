// The one place that talks HTTP to the API: the typed error every failed call rejects with, and `createHttp`, the
// JSON request function every client (learn, sign-in, registry, convert) is built on. Everything a caller could get
// wrong (credentials, JSON, the error body, the network) is here, so a change to the API's shape is a one-file edit.
//
// SPEC 2/15: the only bodies ever sent are JSON (the learn payload, rules, names). There is deliberately no
// method that takes a File or a Blob.
import { API_ERROR_CODES, LIMIT_CODES, type AiLearnPeriod, type ApiErrorBody, type ApiErrorCode, type ApiProblem, type LimitCode } from '@formatai/shared';
import { webConfig } from '../config';

/** Errors the client itself derives (no usable API error body): no connection, a 5xx, a 413, anything else. */
export type ClientErrorCode = 'network' | 'server' | 'payloadTooLarge' | 'unknown';
export type ApiFailureCode = ApiErrorCode | ClientErrorCode;

export interface ApiErrorExtra {
  limit?: LimitCode | undefined;
  retryAfterSec?: number | undefined;
  period?: AiLearnPeriod | undefined;
  counted?: boolean | undefined;
  problems?: ApiProblem[] | undefined;
}

/** Every failed API call rejects with one of these; branch on `code`, never on the message. */
export class ApiError extends Error {
  readonly code: ApiFailureCode;
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** For `limitHit`: which limit. */
  readonly limit: LimitCode | undefined;
  /** From a `Retry-After` header, when the server sent one. */
  readonly retryAfterSec: number | undefined;
  /** `limitHit { limit: 'aiLearns' }`: the period the exhausted quota is counted over. */
  readonly period: AiLearnPeriod | undefined;
  /** `aiAttemptsExhausted`: whether that answer counted the example pair as one AI learn. */
  readonly counted: boolean | undefined;
  /** `invalidRules` / `formatMismatch` / `sourceMismatch`: what failed (SPEC 8.15: the source lock's findings too). */
  readonly problems: ApiProblem[] | undefined;

  constructor(code: ApiFailureCode, status: number, extra: ApiErrorExtra = {}) {
    super(`API error: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.limit = extra.limit;
    this.retryAfterSec = extra.retryAfterSec;
    this.period = extra.period;
    this.counted = extra.counted;
    this.problems = extra.problems;
  }
}

export function isApiError(e: unknown, code?: ApiFailureCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

function isLimitCode(value: unknown): value is LimitCode {
  return typeof value === 'string' && (LIMIT_CODES as readonly string[]).includes(value);
}

/** Maps a failed response (status + parsed JSON body, when there was one) to a typed error. */
export function toApiError(status: number, body: unknown, retryAfter?: string | null): ApiError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Partial<ApiErrorBody>;
  const parsedRetry = retryAfter ? Number(retryAfter) : NaN;
  const extra: ApiErrorExtra = {
    limit: isLimitCode(b.limit) ? b.limit : undefined,
    retryAfterSec: Number.isFinite(parsedRetry) ? parsedRetry : undefined,
    period: b.period === 'lifetime' || b.period === 'month' || b.period === 'day' || b.period === 'unlimited' ? b.period : undefined,
    counted: typeof b.counted === 'boolean' ? b.counted : undefined,
    problems: Array.isArray(b.problems) ? b.problems : undefined,
  };
  if (isApiErrorCode(b.error)) return new ApiError(b.error, status, extra);
  // No (known) code in the body: fall back to what the status says.
  if (status === 429) return new ApiError('rateLimited', status, extra);
  if (status === 413) return new ApiError('payloadTooLarge', status, extra);
  if (status >= 500) return new ApiError('server', status, extra);
  return new ApiError('unknown', status, extra);
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A JSON request: resolves with the parsed body, rejects with an `ApiError`. */
export type HttpRequest = <T>(method: HttpMethod, path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;

export interface CreateHttpOptions {
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function createHttp(options: CreateHttpOptions = {}): { request: HttpRequest; baseUrl: string } {
  const baseUrl = options.baseUrl ?? webConfig.apiBaseUrl;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  const request: HttpRequest = async <T>(method: HttpMethod, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        // The anonymous-id and session cookies are httpOnly and set by the API; they must ride along (also cross-origin).
        credentials: 'include',
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      // An abort is the caller's own doing, not a network problem.
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError('network', 0);
    }
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      throw toApiError(res.status, parsed, res.headers.get('retry-after'));
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError('server', res.status);
    }
  };
  return { request, baseUrl };
}
