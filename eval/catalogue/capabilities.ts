// The capabilities the rules language does not have today, as the catalogue found them. A type that cannot be
// expressed points at exactly one of these (`CatalogueType.missing.capability`); the report groups the
// non-expressible types by capability and counts how many types adding it would unlock (the "language gaps" list).
//
// Adding a capability: add an entry here, then use its id in a type's `missing`. Keep `proposal` short and concrete
// (an operation or a rules field, with the formula spelling) - it is what a language change would start from.

export type CapabilityFamily = 'crossRow' | 'text' | 'date' | 'shape';

export interface Capability {
  family: CapabilityFamily;
  title: string;
  /** What the language cannot do, in terms of the current op set (SPEC 8.3) and pipeline (SPEC 8.2). */
  gap: string;
  /** A sketch of what would unlock it. */
  proposal: string;
}

export const CAPABILITIES = {
  // ---- across rows: every expression sees exactly one row today (SPEC 8.3 - "pure ... no row context") ----
  rowLookback: {
    family: 'crossRow',
    title: 'Previous / next row access',
    gap: 'An expression sees one row only; there is no way to read the value of the row above (or below), or the last non-empty value above.',
    proposal: 'prev(col [, n]) / next(col), fillDown(col) - evaluated after sort, before output',
  },
  runningAggregate: {
    family: 'crossRow',
    title: 'Running (cumulative) aggregates',
    gap: 'No cumulative sum/count over the rows so far (optionally per group).',
    proposal: 'running(sum|count, col [, by])',
  },
  windowAggregate: {
    family: 'crossRow',
    title: 'Group / whole-column aggregate on every row',
    gap: 'Aggregates exist only as summary rows (an extra row per group / at the end), never as a value repeated on every detail row.',
    proposal: 'groupSum(col, by) / groupCount(by) / total(col)',
  },
  rank: {
    family: 'crossRow',
    title: 'Rank among the rows',
    gap: 'No ordering-aware function: the position of a value among all the rows (optionally per group).',
    proposal: 'rank(col [, by] [, dir])',
  },
  rowIndex: {
    family: 'crossRow',
    title: 'Row number',
    gap: 'No access to the position of the row (1..n); only expand has an index (`indexId`), and only for split cells.',
    proposal: 'rowNumber() (after sort)',
  },

  // ---- text ----
  positionSearch: {
    family: 'text',
    title: 'Position search (indexOf) / split at the first occurrence',
    gap: '`split` cuts at EVERY separator and `substr` takes literal positions, so "everything after the FIRST separator" (the rest may hold more separators) or "cut at the position of a marker" cannot be said.',
    proposal: 'indexOf(text, find) returning a position, and substr with expression arguments; or splitFirst/afterFirst(text, sep)',
  },
  charClass: {
    family: 'text',
    title: 'Pattern / character-class operations',
    gap: 'replaceText is literal-only and there is no regex (by design, SPEC 8.3), so "keep only the digits", "drop everything that is not a letter" or "the leading letters" cannot be said unless every character is listed.',
    proposal: 'keepChars(text, "digits"|"letters"|"letters+digits") / stripChars(text, class) over a closed set of named classes (still no regex)',
  },
  perWordCase: {
    family: 'text',
    title: 'Per-word case (proper case)',
    gap: '`upper` and `lower` change the whole text; capitalizing the first letter of each word needs a word-level operation.',
    proposal: 'properCase(text)',
  },
  padRight: {
    family: 'text',
    title: 'Pad on the right / to a computed width',
    gap: '`padLeft` only pads on the left, and `substr` takes literal start/length, so fixed-width fields padded on the right (or cut to a width that depends on the value) cannot be said.',
    proposal: 'padRight(text, length, char)',
  },

  // ---- dates ----
  dateLiteral: {
    family: 'date',
    title: 'Date constants',
    gap: 'An expression constant is a string, number, boolean or null - never a date - so "days until a fixed date" or "is before 2026-01-01" cannot be written (and there is no clock, by design).',
    proposal: 'date("2026-01-01") literal, or a `dateConst` leaf',
  },
  weekday: {
    family: 'date',
    title: 'Weekday of a date',
    gap: '`datePart` gives year, month and day only; the weekday (number or name) cannot be derived without a date constant to count from.',
    proposal: 'datePart "weekday" (and "quarter"/"week"), with weekday names in the output language for dateFormat (dddd)',
  },
  monthNameParse: {
    family: 'date',
    title: 'Parsing dates written with month names',
    gap: 'Input date formats are numeric tokens (D, M, YY ...); a text such as "5 September 2026" / "5 בספטמבר 2026" is never read as a date.',
    proposal: 'MMMM / MMM tokens in `inputFormats`, in the file language',
  },
  makeDate: {
    family: 'date',
    title: 'Date from separate day / month / year parts',
    gap: 'There is no constructor: three numeric columns can be joined into ISO TEXT, but the type checker rejects text where a date is declared (checked: with typeCheck bypassed, the runtime already coerces ISO text to a date and reproduces the output).',
    proposal: 'toDate(text) (ISO), or let typeCheck accept ISO text for a computed column declared `date`; then makeDate = toDate(concat(year, "-", ...))',
  },

  // ---- shape ----
  pivotOutput: {
    family: 'shape',
    title: 'Rows to columns (pivot)',
    gap: 'The output columns are fixed in the rules; a column per distinct value of an input column (and the cross-tab aggregation) cannot be said. Pre-flight blocks a pivot example (SPEC 6.3).',
    proposal: 'transform.pivot { rowKey, columnKey, valueColumn, agg } with data-driven output columns',
  },
} as const satisfies Record<string, Capability>;

export type CapabilityId = keyof typeof CAPABILITIES;

export const CAPABILITY_FAMILY_TITLES: Readonly<Record<CapabilityFamily, string>> = {
  crossRow: 'Across rows',
  text: 'Text',
  date: 'Dates',
  shape: 'Output shape',
};
