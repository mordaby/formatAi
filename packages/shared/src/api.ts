// Wire types of the API endpoints the web app calls (M2). Type-only: no runtime code, so the
// browser bundle can import them freely. The server's source of truth is `apps/api/src/routes`.
import type { ApiErrorCode, LimitCode } from './codes';
import type { TierLimits } from './config/tiers';
import type { LearnPayload, RepairProblem } from './payload';
import type { LearnResult } from './rules/schema';

/** The error body of every non-2xx API response (SPEC 9.5). `limit` accompanies `limitHit`. */
export interface ApiErrorBody {
  error: ApiErrorCode;
  limit?: LimitCode;
}

/** GET /api/session (SPEC 12): no user data. */
export interface SessionResponse {
  /** True once the API has set (or seen) the visitor's httpOnly `anonId` cookie. The id itself
   * is never exposed to scripts. */
  anonId: boolean;
  /** `free` = not signed in (`tiers.anonymous`). Signed-in tiers arrive in M3. */
  tier: 'free';
  /** The tier's limits: the client-enforced ones (rows, columns, preview) and the rest, for display. */
  limits: TierLimits;
  /** Present when Turnstile is configured; absent in dev without it (learns then skip the check). */
  turnstileSiteKey?: string;
}

/** POST /api/learn body. `turnstileToken` is required for anonymous visitors when Turnstile is configured. */
export interface LearnRequest {
  payload: LearnPayload;
  turnstileToken?: string;
  /** Skip the owner's structure cache and learn afresh (counts as a learn) - e.g. when the
   * browser's full verification rejected a cached result. */
  noCache?: boolean;
}

/** POST /api/learn 200 body. */
export interface LearnResponse {
  rules: LearnResult | null;
  verified: boolean;
  problems: RepairProblem[];
  /** Present on an LLM learn; required (once) for /api/learn/repair. Absent on a cache hit. */
  learnId?: string;
  /** True when saved rules for this exact structure were returned without an LLM call. */
  cached: boolean;
}

/** POST /api/learn/repair body: at most one repair per `learnId`. */
export interface RepairRequest {
  payload: LearnPayload;
  previousRules: LearnResult;
  problems: RepairProblem[];
  learnId: string;
}

/** POST /api/learn/repair 200 body. */
export type RepairResponse = Omit<LearnResponse, 'learnId' | 'cached'>;
