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
] as const;

export type FlagMessageKey = (typeof FLAG_MESSAGE_KEYS)[number];
