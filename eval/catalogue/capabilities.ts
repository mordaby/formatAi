// The capabilities the rules language does not have today, as the catalogue found them. (Resolved ones are removed: weekday, makeDate, toDate with month names,
// date("...") literals, keepChars, titleCase and find were added after learn-v6; see SPEC 8.3.) A type that cannot be
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
    title: 'Cut at a computed position / split at the first occurrence',
    gap: '`find(text, search)` gives the position of a marker, but `split` cuts at EVERY separator and `substr` takes literal start/length, so "everything after the FIRST separator" (the rest may hold more separators) or "cut at the position of a marker" still cannot be said.',
    proposal: 'substr with expression start/length (so substr(t, find(t, sep) + n, 999) works); or splitFirst/afterFirst(text, sep)',
  },
  padRight: {
    family: 'text',
    title: 'Pad on the right / to a computed width',
    gap: '`padLeft` only pads on the left, and `substr` takes literal start/length, so fixed-width fields padded on the right (or cut to a width that depends on the value) cannot be said.',
    proposal: 'padRight(text, length, char)',
  },

  // ---- dates ----

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
