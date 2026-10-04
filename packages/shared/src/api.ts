// Wire types of the API endpoints the web app calls (M2). Type-only: no runtime code, so the
// browser bundle can import them freely. The server's source of truth is `apps/api/src/routes`.
import type { ApiErrorCode, LimitCode } from './codes';
import type { AiLearnPeriod, TierLimits } from './config/tiers';
import type { LearnPayload, RepairProblem, Sample } from './payload';
import type { LearnAlternative, LearnResult, Rules, RulesMetaLearnPath, RulesMetaSource, RulesMetaStatus, Validation } from './rules/schema';
import type { SourceColumn, SourceInputReading, SourceInputSignature, SourceLockProblem } from './source';

/** What an error's `problems` may hold: what the checks found in a rules file, or what the source lock found (SPEC 8.15). */
export type ApiProblem = RepairProblem | SourceLockProblem;

/** The error body of every non-2xx API response (SPEC 9.5). `limit` accompanies `limitHit`. */
export interface ApiErrorBody {
  error: ApiErrorCode;
  limit?: LimitCode;
  /** `limitHit { limit: 'aiLearns' }`: the period the exhausted quota is counted over. */
  period?: AiLearnPeriod;
  /** `aiAttemptsExhausted`: true when this very answer counted the pair as one AI learn (SPEC 21 v5). */
  counted?: boolean;
  /** `invalidRules` / `formatMismatch` / `sourceMismatch` (registry): what failed, in the same shape a repair call takes. */
  problems?: ApiProblem[];
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
  /**
   * learn-v8: the second rules the answer gave for some of its columns, each checked like the answer (formula, references, types,
   * limits) - an invalid one is not here. In the answer's own vocabulary (masked when masking is on), like `rules`; the browser tests each
   * on every row of the example. Never cached and never part of `rules`. Absent when there are none.
   */
  alternatives?: LearnAlternative[];
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

/** POST /api/learn/repair body: one round of the learning loop, at most `limits.llm.browserRepairCalls` per `learnId`. */
export interface RepairRequest {
  payload: LearnPayload;
  previousRules: LearnResult;
  problems: RepairProblem[];
  learnId: string;
  /**
   * The learning loop (SPEC 9.3): every row of the example the browser sent since the learn, this round's included, masked like the
   * samples (`withRows`). The server checks the answer against the samples plus all of them. Absent: none.
   */
  rows?: Sample[];
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

/**
 * Which source a saved conversion belongs to (SPEC 8.15 "Saving"). Without `sourceId` and `newSource` the server looks
 * for one of the caller's sources the example input matches (the same matching and threshold as flow C, on
 * `inputHeaders`) and REUSES it, answering `sourceReused`; otherwise it creates a new one.
 */
export interface SourceChoice {
  /** Use this existing source of the caller's (explicit reuse): 404 if it isn't theirs, 422 `sourceMismatch` if it doesn't fit. */
  sourceId?: string;
  /** Create a new source with this name, even when an existing one would match (409 `nameTaken` if the name is in use). */
  newSource?: { name: string };
  /**
   * The headers of the example INPUT file (structure only - never a value): what the server matches against the caller's
   * sources. Without it the headers the rules declare are used, which is usually a subset of the file's.
   */
  inputHeaders?: string[];
  /**
   * The name of the source to CREATE when neither `sourceId` nor `newSource` is given and no existing source matches (default: the first free
   * "Source N"). A name the user typed: in use by another source (case-insensitively) it is refused, 409 `nameTaken`.
   */
  sourceName?: string;
  /**
   * A DEFAULT name for that source, derived by the client from the example input file's name (`defaultSourceName`; nothing from the file's
   * cells): used when neither `sourceId`, `newSource` nor `sourceName` names it. Never refused for a clash - it becomes "name (2)", "name (3)"
   * - and dropped when it is not a usable name (then "Source N").
   */
  suggestedSourceName?: string;
}

/** POST /api/formats body: creates the format (from the rules' output side), its source (or reuses one) and the conversion. */
export interface CreateFormatRequest extends SaveConversionFields, SourceChoice {
  /** The format's name, e.g. "Priority catalog load". */
  name: string;
}

/** POST /api/formats/:id/conversions body (SPEC 5 A2). The rules must pass the format lock and the source lock. */
export interface AttachSourceRequest extends SaveConversionFields, SourceChoice {}

/** The source a save used, when it was an existing one: the UI says "Reused your source X". */
export interface SourceReused {
  id: string;
  name: string;
}

/** PATCH /api/conversions/:id body: rename the source, and/or save edited rules as a new version. */
export interface UpdateConversionRequest {
  /** Renames the conversion's SOURCE (source names are the company's; every conversion of it shows the new name). */
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

/** POST /api/sources/:id/aliases (and, forwarded to the conversion's source, POST /api/conversions/:id/aliases) body
 * (SPEC 5 C): the file's header `alias` was confirmed to be the input column `header`. */
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
  /** The source it belongs to (SPEC 8.15, 13): every conversion has one. */
  sourceId: string;
  /** The SOURCE's name: the only name there is (a conversion keeps no copy of it). */
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
  /** How many formats its source feeds, this one included (SPEC 8.15): an edit of the input side is said to change the source for all of them when this is more than 1. */
  sourceFormats: number;
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

/** The source a save put the conversion in. `formats`: how many formats it feeds now, this save included. */
export interface SavedSourceRef {
  id: string;
  name: string;
  formats: number;
}

/** POST /api/formats 201 body. */
export interface CreateFormatResponse {
  format: FormatSummary;
  conversion: ConversionSummary;
  /** The source the conversion belongs to. */
  source: SavedSourceRef;
  /** Present when an existing source was used instead of creating one (SPEC 8.15 "Saving"). */
  sourceReused?: SourceReused;
}

/** POST /api/formats/:id/conversions 201 body. */
export interface AttachSourceResponse {
  conversion: ConversionSummary;
  source: SavedSourceRef;
  sourceReused?: SourceReused;
}

/** PATCH /api/conversions/:id 200 body. */
export interface UpdateConversionResponse {
  conversion: ConversionSummary;
  /** Set when the save changed the output side, i.e. the FORMAT (SPEC 8.12 "Editing a format"). */
  formatChanged: boolean;
  /** The other sources the format change was written to. */
  affectedSources: number;
  /** Of those (format siblings, and - after a source change - the other conversions of the source), the ones whose
   * references no longer resolve and now need review. `formatId` / `formatName` say which format each one belongs to (it is not
   * always the saved conversion's own: a source feeds several formats). */
  needsReview: { id: string; sourceName: string; formatId?: string; formatName?: string }[];
  /** Set when the save changed the input side, i.e. the SOURCE (SPEC 8.15 "Editing a source"): it was written to the
   * source and to every other conversion of it. Additive: absent = false. */
  sourceChanged?: boolean;
  /** The other conversions (formats fed by the same source) the source change was written to. */
  affectedConversions?: number;
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

/** One conversion of a source: the format it feeds (SPEC 8.15). */
export interface SourceConversionRef {
  conversionId: string;
  formatId: string;
  formatName: string;
  status: ConversionStatus;
}

/**
 * GET /api/signatures: what the browser needs to match a dropped file (SPEC 8.12, 8.15) - ONE ENTRY PER SOURCE, with the
 * conversions (formats) it feeds. A source with no conversion yet has an empty `conversions`.
 */
export interface SignatureEntry {
  sourceId: string;
  /** The source's name. */
  name: string;
  columns: SignatureColumn[];
  /**
   * Headers of this kind of file that no format uses and that need no notice (SPEC 8.15, 13): the example's columns no rule reads, and the
   * ones the user dismissed as "new column". Header names only. Absent when there are none.
   */
  ignoredHeaders?: string[];
  conversions: SourceConversionRef[];
}
export interface SignaturesResponse {
  signatures: SignatureEntry[];
}

// ---- Sources (SPEC 8.15, 13) ----

export interface SourceSummary {
  id: string;
  name: string;
  /** How many columns its signature has. */
  columns: number;
  /** The formats it feeds: one per conversion. */
  conversions: SourceConversionRef[];
  /** Conversions per status. */
  statuses: Partial<Record<ConversionStatus, number>>;
  version: number;
  runCount: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A source with its structure (headers, types, reading options, input checks - never a value). */
export interface SourceDetail extends SourceSummary {
  inputSignature: SourceInputSignature;
  inputReading: SourceInputReading;
  inputValidations: Validation[];
}

/** GET /api/sources */
export interface ListSourcesResponse {
  sources: SourceSummary[];
}

/** GET /api/sources/:id, and the 200 body of PATCH. */
export interface GetSourceResponse {
  source: SourceDetail;
}

/** A column in a source edit: `was` is the header it had before, when this edit renames it (so its conversions follow). */
export type SourceColumnEdit = SourceColumn & { was?: string };

/**
 * PATCH /api/sources/:id body: a rename, and/or an edit of the structure. A structural edit makes a new version of the source
 * and is written to every conversion of it (SPEC 8.15); `required` is derived from the conversions and is not edited here.
 */
export interface UpdateSourceRequest {
  name?: string;
  inputSignature?: { columns: SourceColumnEdit[] };
  inputReading?: SourceInputReading;
  inputValidations?: Validation[];
  /** Optimistic concurrency: 409 `versionConflict` when the source is no longer at this version. */
  baseVersion?: number;
}

export interface UpdateSourceResponse {
  source: SourceDetail;
  /** True when the structure changed (not just the name). */
  structureChanged: boolean;
  /** The conversions the change was written to. */
  affectedConversions: number;
  /** Of those, the ones whose rules no longer resolve and now need review. */
  needsReview: { id: string; formatId: string; formatName: string }[];
}

/** DELETE /api/sources/:id 200 body (409 `sourceInUse` while it has conversions). */
export interface DeleteSourceResponse {
  deleted: true;
}

/** POST /api/sources/:id/aliases 200 body. */
export interface AddAliasResponse {
  inputSignature: { columns: SignatureColumn[] };
}

/**
 * POST /api/sources/:id/ignored-headers body (SPEC 8.15): the file headers the user dismissed as "new column" - header names only, never a
 * value. Added once per source, deduplicated by normalized header, capped (`limits.registry.maxIgnoredHeaders`).
 */
export interface IgnoreHeadersRequest {
  headers: string[];
}

/** POST /api/sources/:id/ignored-headers 200 body: every header the source now ignores. */
export interface IgnoreHeadersResponse {
  ignoredHeaders: string[];
}

/** POST /api/conversions/:id/runs 200 body. */
export interface RecordRunResponse {
  runCount: number;
  lastRunAt: string;
}
