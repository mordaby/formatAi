// The API client (SPEC 5 A steps 5-6, 9.5, 12). The wire types live in
// packages/shared/src/api.ts (the API's own contract); this file only adds transport,
// error mapping and the base URL. Everything a caller could get wrong is in one place
// (`request`), so a change to the API shape is a one-file edit.
//
// SPEC 2/15: the only bodies ever sent are JSON (the learn payload, rules, problems).
// There is deliberately no method that takes a File or a Blob.
import {
  API_ERROR_CODES,
  LIMIT_CODES,
  type ApiErrorBody,
  type ApiErrorCode,
  type LearnPayload,
  type LearnRequest,
  type LearnResponse,
  type LearnResult,
  type LimitCode,
  type RepairProblem,
  type RepairRequest,
  type RepairResponse,
  type SessionResponse,
} from '@formatai/shared';
import { webConfig } from './config';

/** Errors the client itself derives (no usable API error body): no connection, a 5xx, a 413, anything else. */
export type ClientErrorCode = 'network' | 'server' | 'payloadTooLarge' | 'unknown';
export type ApiFailureCode = ApiErrorCode | ClientErrorCode;

/** Every failed API call rejects with one of these; branch on `code`, never on the message. */
export class ApiError extends Error {
  readonly code: ApiFailureCode;
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** For `limitHit`: which limit. */
  readonly limit: LimitCode | undefined;
  /** From a `Retry-After` header, when the server sent one. */
  readonly retryAfterSec: number | undefined;

  constructor(code: ApiFailureCode, status: number, extra: { limit?: LimitCode | undefined; retryAfterSec?: number | undefined } = {}) {
    super(`API error: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.limit = extra.limit;
    this.retryAfterSec = extra.retryAfterSec;
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
  const extra = {
    limit: isLimitCode(b.limit) ? b.limit : undefined,
    retryAfterSec: Number.isFinite(parsedRetry) ? parsedRetry : undefined,
  };
  if (isApiErrorCode(b.error)) return new ApiError(b.error, status, extra);
  // No (known) code in the body: fall back to what the status says.
  if (status === 429) return new ApiError('rateLimited', status, extra);
  if (status === 413) return new ApiError('payloadTooLarge', status, extra);
  if (status >= 500) return new ApiError('server', status, extra);
  return new ApiError('unknown', status, extra);
}

export interface Api {
  /** GET /api/session: sets/reads the anonymous-id cookie and reports the tier and its limits. */
  session(signal?: AbortSignal): Promise<SessionResponse>;
  /** POST /api/learn. `turnstileToken` is required for anonymous visitors when Turnstile is configured. */
  learn(payload: LearnPayload, opts?: { turnstileToken?: string | undefined; noCache?: boolean; signal?: AbortSignal }): Promise<LearnResponse>;
  /** POST /api/learn/repair: at most one per `learnId`. */
  repair(
    learnId: string,
    payload: LearnPayload,
    previousRules: LearnResult,
    problems: RepairProblem[],
    opts?: { signal?: AbortSignal },
  ): Promise<RepairResponse>;
}

export interface CreateApiOptions {
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function createApi(options: CreateApiOptions = {}): Api {
  const baseUrl = options.baseUrl ?? webConfig.apiBaseUrl;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        // The anonymous-id cookie is httpOnly and set by the API; it must ride along (also cross-origin, when the API is on another origin).
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
  }

  return {
    session: (signal) => request<SessionResponse>('GET', '/api/session', undefined, signal),
    learn: (payload, opts = {}) => {
      const req: LearnRequest = {
        payload,
        ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
        ...(opts.noCache ? { noCache: true } : {}),
      };
      return request<LearnResponse>('POST', '/api/learn', req, opts.signal);
    },
    repair: (learnId, payload, previousRules, problems, opts = {}) => {
      const req: RepairRequest = { payload, previousRules, problems, learnId };
      return request<RepairResponse>('POST', '/api/learn/repair', req, opts.signal);
    },
  };
}

let shared: Api | undefined;
/** The app-wide client (same-origin in dev through the Vite proxy). */
export function getApi(): Api {
  return (shared ??= createApi());
}
