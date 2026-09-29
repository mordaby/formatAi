// Every Flag.messageKey the v1 pipeline can emit (SPEC 8.9), for the i18n
// dictionary. Params per key are listed next to it.

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
