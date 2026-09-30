// Wire types of the API endpoints the web app calls (M2). Type-only: no runtime code, so the
// browser bundle can import them freely. The server's source of truth is `apps/api/src/routes`.
import type { ApiErrorCode, LimitCode } from './codes';
import type { AiLearnPeriod, TierLimits } from './config/tiers';
import type { LearnPayload, RepairProblem } from './payload';
import type { LearnResult, Rules, RulesMetaLearnPath, RulesMetaSource, RulesMetaStatus } from './rules/schema';

/** The error body of every non-2xx API response (SPEC 9.5). `limit` accompanies `limitHit`. */
export interface ApiErrorBody {
  error: ApiErrorCode;
  limit?: LimitCode;
  /** `limitHit { limit: 'aiLearns' }`: the period the exhausted quota is counted over. */
  period?: AiLearnPeriod;
  /** `aiAttemptsExhausted`: true when this very answer counted the pair as one AI learn (SPEC 21 v5). */
  counted?: boolean;
  /** `invalidRules` / `formatMismatch` (registry): what failed, in the same shape a repair call takes. */
  problems?: RepairProblem[];
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
  /** SPEC 21 v5: the caller's AI-learn quota after this answer (absent on a cache hit, which costs nothing). */
  quota?: AiLearnQuotaState;
  /** True when this answer counted as one AI learn (it verified on the server). A learn that only failed the
   * server checks counts later, if the browser reports it verified or saved with accepted differences
   * (`LearnOutcomeRequest`). */
  counted?: boolean;
  /** Failed AI attempts so far on this example pair, of `limits.learn.maxFailedAiAttempts`. */
  failedAttempts?: number;
}

/** SPEC 21 v5: what is left of a signed-in user's AI learns. */
export interface AiLearnQuotaState {
  /** AI learns still available in the period; `null` for an unlimited quota. */
  remaining: number | null;
  period: AiLearnPeriod;
}

/** GET /api/learn/quota (signed-in only): what is left of the caller's AI learns, before any learn was made. */
export interface LearnQuotaResponse {
  quota: AiLearnQuotaState;
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

/**
 * POST /api/learn/:learnId/outcome body (SPEC 21 v5 item 3): what the browser found out after its own full
 * verification. `verified` (every row matches) and `accepted` (saved with accepted differences) make the learn
 * count once, if it does not count yet; `failed` says the attempt did not work out. Idempotent.
 */
export interface LearnOutcomeRequest {
  outcome: 'verified' | 'accepted' | 'failed';
}

/** POST /api/learn/:learnId/outcome 200 body. */
export interface LearnOutcomeResponse {
  /** Whether this learn is counted against the quota now. */
  counted: boolean;
  quota: AiLearnQuotaState;
  failedAttempts: number;
  /** True once the failed-attempt cap on this example pair is reached (the AI is no longer called for it). */
  exhausted: boolean;
}

// ---- Sign-in (SPEC 12, 5 E) ----

export type AuthProviderId = 'google' | 'microsoft';

/** GET /api/auth/providers: the providers that are configured, Google first. Only these are offered. */
export interface AuthProvidersResponse {
  providers: AuthProviderId[];
}

/** A signed-in user as the web app sees it. */
export interface MeUser {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  /** The verified email when there is one, else any email the provider gave; absent when none. */
  email?: string;
  /** New users are `registered`; an admin sets `paid`. */
  tier: 'registered' | 'paid';
  /** Linked providers (link a second one from settings). */
  providers: AuthProviderId[];
  isAdmin: boolean;
  /** Null until the user has saved one (then the browser's language decides). */
  uiLanguage: 'he' | 'en' | null;
}

/** GET /api/me, and the 200 body of PATCH /api/me (body: `{ uiLanguage }`, nothing else). */
export interface MeResponse {
  user: MeUser | null;
}

/**
 * Where the browser lands after `/api/auth/<provider>/start` or `/callback`: the `returnTo` path with
 * `?authError=<code>` on failure, or `?linked=<provider>` when a second provider was linked.
 * `expired`: no sign-in in progress (cookie missing or older than 10 minutes); `denied`: declined at the provider;
 * `failed`: the provider's answer didn't validate; `sessionMismatch`: linking, but the signed-in user changed;
 * `identityInUse`: linking, that account belongs to another user; `providerLinked`: linking, already has that provider.
 */
export type AuthRedirectError = 'expired' | 'denied' | 'failed' | 'sessionMismatch' | 'identityInUse' | 'providerLinked';

// ---- Registry (SPEC 8.12, 13): formats and their conversions, signed-in users only ----

/** SPEC 13 `conversions.status`. */
export type ConversionStatus = RulesMetaStatus;

/** Fields the browser sends when it saves a learned result (POST /api/formats, POST /api/formats/:id/conversions). */
export interface SaveConversionFields {
  /** The full rules file (SPEC 8.1). `name` and `meta` are filled in by the server when missing. */
  rules: Rules | LearnResult;
  /** Not `needsReview`: only the server sets that (SPEC 8.12). */
  status: Exclude<ConversionStatus, 'needsReview'>;
  /** Rows the user accepted as different (SPEC 8.11); 0 unless `differencesAccepted`. */
  acceptedDifferences: number;
  /** Example row numbers marked "fixed by hand" (SPEC 8.11). */
  exampleExceptions: number[];
  learnPath: RulesMetaLearnPath;
  masking: boolean;
  model?: string;
  promptVersion?: string;
  source?: RulesMetaSource;
}

/** POST /api/formats body: creates the format (from the rules' output side) and its first conversion. */
export interface CreateFormatRequest extends SaveConversionFields {
  /** The format's name, e.g. "Priority catalog load". */
  name: string;
  /** The first source's name; default "Source 1". */
  sourceName?: string;
}

/** POST /api/formats/:id/conversions body (SPEC 5 A2). The rules must pass the format lock. */
export interface AttachSourceRequest extends SaveConversionFields {
  /** Default: the first free "Source N". */
  sourceName?: string;
}

/** PATCH /api/conversions/:id body: rename the source, and/or save edited rules as a new version. */
export interface UpdateConversionRequest {
  sourceName?: string;
  /** Saving rules needs `status` (the browser verified them) and `acceptedDifferences`. */
  rules?: Rules | LearnResult;
  status?: Exclude<ConversionStatus, 'needsReview'>;
  acceptedDifferences?: number;
  exampleExceptions?: number[];
  /** Optimistic concurrency: 409 `versionConflict` when the conversion is no longer at this version. */
  baseVersion?: number;
}

/** PATCH /api/formats/:id body. */
export interface RenameFormatRequest {
  name: string;
}

/** POST /api/conversions/:id/runs body: counts only, never rows, values or file names. */
export interface RecordRunRequest {
  rows: number;
  flagged: number;
}

/** POST /api/conversions/:id/aliases body (SPEC 5 C): the file's header `alias` was confirmed to be the input column `header`. */
export interface AddAliasRequest {
  header: string;
  alias: string;
}

/** One input column of a conversion's signature (SPEC 8.12 "input signature"). */
export interface SignatureColumn {
  header: string;
  aliases: string[];
  type: string;
  required: boolean;
}

export interface FormatSummary {
  id: string;
  name: string;
  origin: 'learned' | 'template';
  version: number;
  fileType: string;
  outputColumns: number;
  /** The output headers, in order (the browser compares them with an example output, SPEC 5 A2). */
  outputHeaders: string[];
  /** How many sources (conversions) it has. */
  sources: number;
  /** Sources per status. */
  statuses: Partial<Record<ConversionStatus, number>>;
  runCount: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversionSummary {
  id: string;
  formatId: string;
  sourceName: string;
  status: ConversionStatus;
  acceptedDifferences: number;
  learnPath: RulesMetaLearnPath;
  version: number;
  runCount: number;
  lastRunAt?: string;
  /** Counts of the last run (SPEC 8.12: shown with a "format changed since last run" notice). */
  lastRun?: { rows: number; flagged: number };
  createdAt: string;
  updatedAt: string;
}

/** The conversion with everything the browser needs to open its editor or run it. */
export interface ConversionDetail extends ConversionSummary {
  rules: Rules;
  exampleExceptions: number[];
  masking: boolean;
  model?: string;
  promptVersion?: string;
  inputSignature: { columns: SignatureColumn[] };
}

/** The format side (SPEC 8.12) - `Format` in format.ts, kept opaque here to keep this file type-light. */
export interface FormatDetail extends FormatSummary {
  output: unknown;
  layout: unknown;
  outputValidations: unknown[];
}

/** GET /api/formats */
export interface ListFormatsResponse {
  formats: FormatSummary[];
}

/** GET /api/formats/:id */
export interface GetFormatResponse {
  format: FormatDetail;
  conversions: ConversionSummary[];
}

/** POST /api/formats 201 body. */
export interface CreateFormatResponse {
  format: FormatSummary;
  conversion: ConversionSummary;
}

/** POST /api/formats/:id/conversions 201 body. */
export interface AttachSourceResponse {
  conversion: ConversionSummary;
}

/** PATCH /api/conversions/:id 200 body. */
export interface UpdateConversionResponse {
  conversion: ConversionSummary;
  /** Set when the save changed the output side, i.e. the FORMAT (SPEC 8.12 "Editing a format"). */
  formatChanged: boolean;
  /** The other sources the format change was written to. */
  affectedSources: number;
  /** Of those, the ones whose references no longer resolve and now need review. */
  needsReview: { id: string; sourceName: string }[];
}

/** GET /api/conversions/:id/versions: newest first, the current one included. */
export interface ConversionVersionSummary {
  version: number;
  at: string;
  status: ConversionStatus;
  acceptedDifferences: number;
  current: boolean;
}
export interface ListVersionsResponse {
  versions: ConversionVersionSummary[];
}

/** GET /api/signatures: what the browser needs to match a dropped file to a conversion (SPEC 8.12). */
export interface SignatureEntry {
  conversionId: string;
  formatId: string;
  formatName: string;
  sourceName: string;
  status: ConversionStatus;
  columns: SignatureColumn[];
}
export interface SignaturesResponse {
  signatures: SignatureEntry[];
}

/** POST /api/conversions/:id/runs 200 body. */
export interface RecordRunResponse {
  runCount: number;
  lastRunAt: string;
}
