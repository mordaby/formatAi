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
