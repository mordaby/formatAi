// The API client (SPEC 5 A steps 5-6, 9.5, 12). The wire types live in packages/shared/src/api.ts (the API's own
// contract); the transport and the typed error live in ./api/http.ts, and the sign-in and registry calls in
// ./api/auth.ts and ./api/registry.ts. This file composes them into the one `Api` object the app injects
// (see services.tsx) and keeps the learn calls.
//
// SPEC 2/15: the only bodies ever sent are JSON (the learn payload, rules, problems).
// There is deliberately no method that takes a File or a Blob.
import type { LearnPayload, LearnRequest, LearnResponse, LearnResult, RepairProblem, RepairRequest, RepairResponse, Sample, SessionResponse } from '@formatai/shared';
import { createAuthApi, type AuthApi } from './api/auth';
import { createContactApi, type ContactApi } from './api/contact';
import { createHttp, type CreateHttpOptions } from './api/http';
import { createRegistryApi, type RegistryApi } from './api/registry';

export { ApiError, isApiError, toApiError, type ApiFailureCode, type ClientErrorCode } from './api/http';

export interface Api {
  /** GET /api/session: sets/reads the anonymous-id cookie and reports the tier and its limits. */
  session(signal?: AbortSignal): Promise<SessionResponse>;
  /** POST /api/learn. `turnstileToken` is required for anonymous visitors when Turnstile is configured. */
  learn(payload: LearnPayload, opts?: { turnstileToken?: string | undefined; noCache?: boolean; signal?: AbortSignal }): Promise<LearnResponse>;
  /**
   * POST /api/learn/repair: one round of the learning loop, at most `limits.llm.browserRepairCalls` per `learnId`. `rows`: every row the loop sent
   * so far, masked. `overfitRepaired`: the learn already had its one repair for a rule that copies rows (SPEC 9.2 layer 6).
   */
  repair(
    learnId: string,
    payload: LearnPayload,
    previousRules: LearnResult,
    problems: RepairProblem[],
    opts?: { signal?: AbortSignal; rows?: Sample[] | undefined; overfitRepaired?: boolean | undefined },
  ): Promise<RepairResponse>;
  /** Sign-in: providers, who is signed in, sign out, the saved language, linking, the AI quota. */
  auth: AuthApi;
  /** A signed-in user's formats and conversions, and the learn outcome report. */
  registry: RegistryApi;
  /** The public forms: the business lead form, the paid waitlist, feedback (SPEC 16.1 screen 7, 13). */
  contact: ContactApi;
  /** The API's base URL ('' = same origin): where the sign-in buttons navigate to. */
  baseUrl: string;
}

export type CreateApiOptions = CreateHttpOptions;

export function createApi(options: CreateApiOptions = {}): Api {
  const { request, baseUrl } = createHttp(options);

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
      const req: RepairRequest = { payload, previousRules, problems, learnId, ...(opts.rows && opts.rows.length > 0 ? { rows: opts.rows } : {}), ...(opts.overfitRepaired ? { overfitRepaired: true } : {}) };
      return request<RepairResponse>('POST', '/api/learn/repair', req, opts.signal);
    },
    auth: createAuthApi(request),
    registry: createRegistryApi(request),
    contact: createContactApi(request),
    baseUrl,
  };
}

let shared: Api | undefined;
/** The app-wide client (same-origin in dev through the Vite proxy). */
export function getApi(): Api {
  return (shared ??= createApi());
}
