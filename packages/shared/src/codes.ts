// Closed code vocabularies referenced across the rules schema, the engine and
// the UI (SPEC 8.10 for unsupported/assumption codes, SPEC 6.3 for pre-flight
// block reasons). The LLM writes codes, never prose (SPEC 8.10); the UI turns
// each code into i18n text (see src/i18n/messages.ts).

// ---------- SPEC 8.10: unsupported ----------

export const UNSUPPORTED_REASON_CODES = [
  'externalData',
  'pivot',
  'rowExpansion',
  'crossRowCalculation',
  'hiddenByMasking',
  'ambiguous',
  'other',
] as const;
export type UnsupportedReasonCode = (typeof UNSUPPORTED_REASON_CODES)[number];

// ---------- SPEC 8.10: assumptions ----------

export const ASSUMPTION_REASON_CODES = [
  'rateGuessed',
  'roundingGuessed',
  'filterGuessed',
  'sortGuessed',
  'formatGuessed',
  'titleGuessed',
  // SPEC 9.2 layer 6 "Overfitting lint": never a rejection, but every finding (a
  // constant/condition/switch/table/value-map entry that only fits one sample row,
  // or an expression far larger than any other column needs) becomes a "Please
  // check" line with this code, code-added rather than LLM-written.
  'overfitSuspected',
  'other',
] as const;
export type AssumptionReasonCode = (typeof ASSUMPTION_REASON_CODES)[number];

// ---------- SPEC 6.3: pre-flight block reasons ----------
// DECISION: SPEC 6.3 lists these as prose bullets, not a code list. Coding them
// as a closed enum here so preflight results, events (`preflight {reason}`) and
// i18n can all key off the same strings:
//   - a 6.1 rejection (see the engine's TableIssueCode for which one)
//   - row expansion that fits none of the three family patterns
//   - pivot
//   - no output column can be traced to the input at all
//   - the two files are identical
//   - the files are over the tier's limits
export const PREFLIGHT_BLOCK_REASONS = [
  'tableRejected',
  'rowExpansionUnsupported',
  'pivotDetected',
  'noColumnTraced',
  'identicalFiles',
  'overTierLimits',
] as const;
export type PreflightBlockReason = (typeof PREFLIGHT_BLOCK_REASONS)[number];

// ---------- SPEC 6.4: pre-flight warn reasons ----------
// DECISION: same rationale as PREFLIGHT_BLOCK_REASONS above - SPEC 6.4 lists these
// as prose ("Some output columns are unknown", "Rows couldn't be aligned"), coded
// here as a closed enum so preflight results and i18n share one vocabulary. Unlike
// a block, the user can continue past a warn ("try anyway"), and doing so still counts
// as a learn. `unknownOutputColumns` is informational only (severity 'info', never a stop):
// the AI step tries those columns, and what it can't produce stays empty.
export const PREFLIGHT_WARN_REASONS = ['unknownOutputColumns', 'rowsNotAligned'] as const;
export type PreflightWarnReason = (typeof PREFLIGHT_WARN_REASONS)[number];

// Every Flag.messageKey the engine can emit (SPEC 8.9). Params per key are listed next to it.
export const FLAG_MESSAGE_KEYS = [
  // rule "type": a value kept as-is because it doesn't fit the declared type. params: { type }
  'flag.parseFailed.number',
  'flag.parseFailed.integer',
  'flag.parseFailed.date', // suggestion: the day/month-swapped date, when mechanical
  'flag.parseFailed.idLike',
  'flag.parseFailed.boolean',
  // rule "dedupe". params: { duplicateOf }
  'flag.duplicateOf',
  // rule "expr" (computed columns, fixedFanOut set)
  'flag.expr.divByZero',
  'flag.expr.notNumber',
  'flag.expr.notDate',
  // rule "valueMap"
  'flag.valueMapMissing',
  // rule "expr" (lookup, SPEC 8.3/8.14). params: none; value is the lookup key
  'flag.lookupMissing',
  // declared validations (SPEC 8.8)
  'flag.validation.required',
  'flag.validation.israeliIdChecksum',
  'flag.validation.range', // params: { min?, max? }
  'flag.validation.lengthEquals', // params: { length }; suggestion: padded value
  'flag.validation.oneOf',
  'flag.validation.unique', // params: { firstRow }
  'flag.validation.dateRange', // params: { from, to }
  'flag.validation.cutoffRange', // params: { low, high, value } (numbers, or ISO dates)
] as const;

export type FlagMessageKey = (typeof FLAG_MESSAGE_KEYS)[number];

// ---------- API error codes (SPEC 9.5, 11, 15) ----------
// Stable machine codes the API returns as `{ error: <code>, limit?: <LimitCode> }`; the web maps each
// to UI text (see `apiErrorMessages` / `limitMessages` in i18n/messages.ts). The API never sends prose.
export const API_ERROR_CODES = [
  // 400: the request body is malformed (never says what was wrong - SPEC 15).
  'invalidPayload',
  'invalidPreviousRules',
  'invalidProblems',
  'invalidLearnId',
  // 400: a loop round's rows (SPEC 9.3) are malformed or larger than the loop allows (rows per round, rows in one learn, the payload byte cap).
  'invalidRows',
  // 403: Turnstile token missing or rejected (anonymous learns, SPEC 9.5).
  'turnstileFailed',
  // 429: a per-tier limit was hit; `limit` says which one (see LIMIT_CODES).
  'limitHit',
  // 429: the daily anonymous budget is spent - the UI says "Sign in to keep going".
  'anonBudgetExhausted',
  // 503: the daily overall budget is spent - the kill switch.
  'budgetExhausted',
  // 429: too many requests from one IP in a minute.
  'rateLimited',
  // 403 (SPEC 21 v5): the AI step is for signed-in users only. The local result is shown first.
  'signInForAi',
  // 409 (SPEC 21 v5): the failed-attempt cap on this example pair was reached; `counted` says whether it
  // was counted as one AI learn by this very answer.
  'aiAttemptsExhausted',
  // ---- registry (M3, SPEC 8.12) ----
  // 401: saving, listing and editing formats needs a sign-in.
  'signInRequired',
  // 404: no such format / conversion / version - also when it belongs to someone else.
  'notFound',
  // 400: malformed registry request body (never says what was wrong).
  'invalidRequest',
  // 422: the rules file failed the checks (structure, references, types, limits); `problems` says which.
  'invalidRules',
  // 422: attach / restore - the rules don't reproduce the format; `problems` are `formatMismatch` ones.
  'formatMismatch',
  // 409: another source of yours already has that name (source names are the company's, SPEC 8.15).
  'nameTaken',
  // 422 (SPEC 8.15): the conversion's input side doesn't match its source (the source lock); `problems` are `sourceMismatch` ones.
  'sourceMismatch',
  // 409 (SPEC 8.15): a source that still feeds a format can't be deleted.
  'sourceInUse',
  // 409: that alias already names another input column of the conversion.
  'aliasConflict',
  // 409: the conversion/format was changed by someone else since `baseVersion`.
  'versionConflict',
  // 503: the registry needs the database, which is not configured.
  'unavailable',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The `limit` that accompanies `limitHit` (also the `limit_hit { limit }` event prop, SPEC 11). */
export const LIMIT_CODES = [
  // Legacy (M2, before the AI-only-for-signed-in rule): the API no longer sends these two.
  'learnsPerDay',
  'learnsPerMonth',
  'repairsPerLearn',
  // 429: the user's AI-learn quota for its period is used up (`period` accompanies it).
  'aiLearns',
  // 403: saved formats (registered: lifetime total; delete frees a slot).
  'savedFormats',
  // 429: paid tier's new formats this calendar month (DECISION 9).
  'newFormatsPerMonth',
  // 403: sources (conversions) per format.
  'sourcesPerFormat',
  // 403: rules per format (functions, tables, columns, filters, ... SPEC 8.14).
  'rulesPerFormat',
] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];
