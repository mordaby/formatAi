// The Format type (SPEC 8.12): the shape of a file a company produces, owned by the
// company and shared by every conversion attached to it. A Format is derived from a
// conversion's rules file by `packages/engine/src/registry/formatOf.ts` (pure,
// id-independent apart from the caveat below), and used by
// `packages/engine/src/registry/checkFormatLock.ts` to enforce SPEC 8.12's format lock.
//
// SPEC 8.12: "It holds: `output` (columns, headers, number formats, widths, title rows,
// summary rows, direction, language, `file`); the layout parts that live in `transform`,
// normalized to output headers: `sort`, and `group` (by, summary rows, blank rows,
// showDetailRows, per-column agg); output validations (`on: 'output'`)."
//
// v4 change (SPEC 21): the sum-only, id-based `grandTotal`/`subtotal` are replaced by
// generic `summaryRows` (SPEC 8.12). A `SummaryRow`'s `cells`/`labelColumn` already name
// OUTPUT HEADERS, not ids (SPEC 8.12: "so a summary row belongs to the format"), so -
// unlike `sort`/`group.by`, which are translated from ids by `formatOf` - a rules file's
// own `output.summaryRows`/`group.summaryRows` need no translation at all here; only the
// deprecated, id-based `grandTotal`/`subtotal` still need one (SPEC 21 v4, done by
// `packages/engine/src/rules/summaryRows.ts`, shared with the engine's runtime layout so
// an old-style and a new-style conversion of the same format normalize to the same
// `summaryRows` and compare equal under `checkFormatLock`).
//
// DECISION: SPEC 8.12 only calls out `sort` and `group` as "normalized to output
// headers" - `output` itself (titleRows' `agg.column`) keeps referencing whatever ids
// the conversion's `transform`/`input` declared. That is intentional, not an oversight:
// a second conversion taught in attach mode (SPEC 5 A2) is taught against the existing
// format/rules, so it is expected to reuse the same computed/input ids the first
// conversion used for anything `output` still references by id. `checkFormatLock`
// therefore compares `output` as-is (minus `columns[].from`), and only `sort`/`group`
// get the id -> output-header translation before comparing.
import type {
  HeaderStyle,
  OutputColumnAgg,
  OutputFile,
  SummaryRow,
  TitleRow,
  Validation,
} from './rules/schema';

/** `output.columns[]` minus `from` (SPEC 8.12: "except columns[].from"). */
export interface FormatOutputColumn {
  header: string;
  format?: string;
  width?: number;
  agg?: OutputColumnAgg;
}

/** SPEC 8.12 "output" side of a format. `file` is always present (defaults made
 * explicit by `formatOf`, so `absent == { type: 'xlsx' }` never has to be special-cased
 * again downstream). `summaryRows` is always present too (an empty array when the
 * format has none), so an old-style (translated) and a new-style conversion compare
 * equal without a presence/absence special case. */
export interface FormatOutput {
  file: OutputFile;
  sheetName: string;
  direction: 'rtl' | 'ltr';
  language: 'he' | 'en';
  titleRows: TitleRow[];
  columns: FormatOutputColumn[];
  headerStyle?: HeaderStyle;
  /** SPEC 8.12 v4: summary rows after all data rows, in order (already header-keyed -
   * see the file header). */
  summaryRows: SummaryRow[];
}

/** `transform.sort`, with `column` (an id) replaced by the output header it feeds
 * (SPEC 8.12: "its sort ... after code maps ids to output headers, must equal the
 * format's"). Same normalized shape LEARN_PROMPT §3 uses for `target.layout.sort`. */
export interface FormatSortKey {
  header: string;
  dir: 'asc' | 'desc';
}

/** `transform.group`, ids replaced by output headers, plus the per-output-column `agg`
 * map (SPEC 8.6 summary outputs: "each output column gets `agg`"). `agg` is keyed by
 * output header directly (an output column's `agg` sits on the column itself, so no id
 * translation is needed for it - unlike `by`, which comes from `transform`). */
export interface FormatGroup {
  by: string;
  showDetailRows: boolean;
  blankRowsAfter?: number;
  agg?: Record<string, OutputColumnAgg>;
  /** SPEC 8.12 v4: summary rows after this group, in order (see `FormatOutput.summaryRows`). */
  summaryRows: SummaryRow[];
}

export interface FormatLayout {
  sort: FormatSortKey[];
  group?: FormatGroup;
}

/** SPEC 8.12. Owned by the company; conversions attach to it and are held to its
 * `output`/`layout`/`outputValidations` by the format lock. */
export interface Format {
  output: FormatOutput;
  layout: FormatLayout;
  /** `validations` with `on: 'output'` (SPEC 8.8: "belongs to the format"). */
  outputValidations: Validation[];
}
