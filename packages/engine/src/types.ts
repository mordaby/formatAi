// Engine I/O contracts. Shared by read / detectTable / pipeline / write.
// Pure data: no DOM, no Node-only APIs. All row/column indices are 0-based
// unless a field says otherwise (rowNumber is 1-based, as shown in Excel).

// ---------- Reading ----------

/** A cell as read from a file. Formulas are read as their last calculated value. */
export interface RawCell {
  /** Cached value. Dates in xlsx/xls arrive as Excel serial numbers with `isDate: true`. CSV cells are always strings. */
  v: string | number | boolean | null;
  /** Excel number format code, when known (xlsx/xls). */
  z?: string;
  /** True when the cell's number format is a date format (then `v` is an Excel serial). */
  isDate?: boolean;
  /** Bold font, when known (xlsx only). */
  bold?: boolean;
}

export interface CellRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface RawSheet {
  name: string;
  /** Row-major grid. Rows may be ragged; missing cells are `null`. */
  rows: (RawCell | null)[][];
  merges: CellRange[];
  /** From the sheet's right-to-left view flag. Undefined when the file type has no such flag (csv) or it couldn't be read. */
  rightToLeft?: boolean;
  hiddenRows: number[];
  hiddenCols: number[];
  /** Column widths in Excel character units, when known. */
  colWidths: (number | undefined)[];
  /** True when the sheet has charts/images/drawings. */
  hasDrawings?: boolean;
}

// ---------- File types (SPEC 8.13) ----------

/** Output file spec. Mirrors rules `output.file`; defaults: csv delimiter ',', txt '\t', header true, encoding 'utf8bom', quote 'minimal'. */
export interface OutputFileSpec {
  type: 'xlsx' | 'csv' | 'txt';
  delimiter?: ',' | '\t' | ';' | '|';
  /** Write a header row. false = no header line (typical for system load files). */
  header?: boolean;
  encoding?: 'utf8bom' | 'utf8' | 'windows1255';
  quote?: 'minimal' | 'all' | 'none';
}

export interface RawWorkbook {
  fileType: 'xlsx' | 'xls' | 'csv' | 'txt';
  sheets: RawSheet[];
  /** Workbook uses the 1904 date system (serials must be shifted by 1462 days). */
  date1904?: boolean;
  /** csv/txt only: detected encoding. */
  encoding?: 'utf-8' | 'utf-8-bom' | 'windows-1255';
  /** csv/txt only: detected delimiter. */
  delimiter?: ',' | '\t' | ';' | '|';
}

// ---------- Table detection (SPEC 6.1) ----------

export type TableIssueCode =
  | 'noHeaderRow'
  | 'multipleTables'
  | 'mergedHeader'
  | 'splitHeader'
  | 'tooFewDataRows'
  | 'onlyDrawings'
  | 'multipleSheets'
  | 'hiddenRowsOrCols'
  | 'emptySheet';

export interface TableIssue {
  code: TableIssueCode;
  /** 'reject' blocks the file; 'notice' is informational (e.g. hidden rows included). */
  severity: 'reject' | 'notice';
  /** Optional structured details for the i18n message (e.g. { row: 1, fromCol: 'B', toCol: 'D' }). Never cell values. */
  params?: Record<string, string | number>;
}

export interface TableDetection {
  ok: boolean;
  /** 0-based row index of the header row (-1 when not found). */
  headerRow: number;
  /** 0-based index of the first data row. */
  dataStart: number;
  /** 0-based index of the last data row (inclusive). */
  dataEnd: number;
  /** 0-based indices of title rows above the header. */
  titleRows: number[];
  /** 0-based indices of footer rows below the data (totals etc.). */
  footerRows: number[];
  direction: 'rtl' | 'ltr';
  issues: TableIssue[];
}

/** A detected input table, ready for the pipeline. */
export interface InputTable {
  sheetName: string;
  direction: 'rtl' | 'ltr';
  /** Header texts as they appear in the file (not normalized). */
  headers: string[];
  /** Data rows only (no title/header/footer rows), aligned to `headers`. */
  rows: (RawCell | null)[][];
  /** 1-based Excel row number of each data row (same length as `rows`). */
  rowNumbers: number[];
  date1904?: boolean;
}

// ---------- Output ----------

export interface OutCell {
  /**
   * Value to write. Numbers are written as numbers; when `isDate` is true, `v` is an
   * Excel serial (1900 system) and `z` is an Excel date format.
   * Text is written as text (never as a formula).
   */
  v: string | number | boolean | null;
  /** Excel number format code (e.g. "#,##0.00", "dd/mm/yyyy", "@"). */
  z?: string;
  isDate?: boolean;
  /** Display text for CSV output (the pipeline fills it for date cells). When absent, CSV writes the raw value. */
  text?: string;
  bold?: boolean;
  /** Highlight (a flagged cell). */
  flagged?: boolean;
}

// v4 (SPEC 21): 'summaryRow' is a genuine `output.summaryRows`/`group.summaryRows`
// entry (SPEC 8.12); 'subtotal'/'grandTotal' are kept only for a deprecated
// `group.subtotal`/`output.grandTotal`, translated internally (see
// `packages/engine/src/rules/summaryRows.ts`) so old golden fixtures/rules files stay
// byte-identical.
export type OutRowKind = 'title' | 'blank' | 'header' | 'data' | 'subtotal' | 'grandTotal' | 'summaryRow';

export interface OutRow {
  kind: OutRowKind;
  cells: OutCell[];
  bold?: boolean;
  /** For data rows: 1-based Excel row number of the input row it came from. */
  sourceRow?: number;
}

export interface OutputColumn {
  header: string;
  /** Excel character units. */
  width?: number;
  /** Excel number format for the column's data cells. */
  format?: string;
  /** True for numeric columns (used by CSV formula-injection guard). */
  numeric?: boolean;
}

export interface OutputSheet {
  name: string;
  /** File type and text options. Absent = xlsx. csv/txt ignore styles, widths, bold and direction. */
  file?: OutputFileSpec;
  direction: 'rtl' | 'ltr';
  language: 'he' | 'en';
  columns: OutputColumn[];
  /** Every row in order: title, blank, header, data, subtotal, grandTotal. */
  rows: OutRow[];
  /** Merged ranges (e.g. title rows spanning all columns). */
  merges: CellRange[];
}

// ---------- Run results ----------

/** SPEC 8.9 */
export interface Flag {
  fileName?: string;
  /** 1-based, as shown in Excel (input row number). */
  rowNumber: number;
  /** Column id (or header when no id applies). */
  column: string;
  rule: string;
  value: string | number | boolean | null;
  /** i18n key, e.g. "flag.duplicateOf", "flag.parseFailed.date". */
  messageKey: string;
  /** Extra params for the message, e.g. { duplicateOf: 12 }. */
  params?: Record<string, string | number>;
  /** Only for mechanical, safe fixes (padding, day/month swap). */
  suggestion?: string | number;
  /** SPEC 21 v5 item 5: the user chose "keep it as is" for this row in this run (`RowDecision` keep). */
  accepted?: boolean;
}

// ---------- Per-run row decisions (SPEC 21 v5 item 5, issue #36) ----------

/**
 * What the user decided for one flagged input row of THIS run. Applied by `runRules`/`convertFile`
 * without touching the saved rules; never stored anywhere.
 *  - skip: the row is left out of the output.
 *  - keep: the row stays as it is; its flags are accepted (they stay in the flag list with
 *    `accepted: true`, and the cells are not highlighted). A row a `block` validation would leave
 *    out is written too.
 *  - override: replaces cell values of the input row (a one-off value edit) BEFORE normalization,
 *    and the row goes through the whole pipeline again. `values` is keyed by an input column's id
 *    or its header (the rules' declared header, or the file's own); a value is a cell value, so text
 *    is read by the column's type exactly like a file cell (a date as "31/01/2024", a number as "12.5").
 */
export type RowDecision =
  | { action: 'skip' }
  | { action: 'keep' }
  | { action: 'override'; values: Record<string, string | number | boolean | null> };

/** Keyed by the 1-based input row number, as shown in Excel (`Flag.rowNumber`). */
export type RowDecisions = Record<number, RowDecision>;

export interface RunSummary {
  rowsIn: number;
  rowsOut: number;
  rowsFiltered: number;
  /** Rows removed by dedupe action "remove": 1-based row number and the row it duplicates. */
  duplicatesRemoved: { rowNumber: number; duplicateOf: number }[];
  duplicatesFlagged: number;
  /** Rows left out by a validation with severity "block". */
  blockedRows: { rowNumber: number; rule: string; column: string }[];
  /**
   * Present only when the rules hold an across-row (window) function and a row was left out by a `block` validation: how many
   * such rows are still counted in the window results (group totals, running sums, ranks). Counts only; the rows are in `blockedRows`.
   */
  blockedInWindows?: number;
  // The three lists below are present only when the run was given `rowDecisions` (SPEC 21 v5
  // item 5), in input-row order. Skipped rows still count in `rowsIn`, so
  // rowsIn = rowsOut + rowsFiltered + duplicatesRemoved + blockedRows + skippedByUser (plain rows).
  /** Rows the user chose to skip. */
  skippedByUser?: { rowNumber: number }[];
  /** Rows whose values the user edited for this run: the input column ids that changed. */
  editedByUser?: { rowNumber: number; columns: string[] }[];
  /** Rows the user kept as they are, with how many of their flags (or blocks) were accepted. */
  acceptedByUser?: { rowNumber: number; flags: number }[];
}

export type RunErrorCode = 'missingRequiredColumns' | 'noTable' | 'sheetNotFound' | 'invalidRules';

export interface RunError {
  code: RunErrorCode;
  params?: Record<string, string | number>;
  /** For missingRequiredColumns: the headers that weren't found. */
  missing?: string[];
}

export type RunResult =
  | { ok: true; sheet: OutputSheet; flags: Flag[]; summary: RunSummary }
  | { ok: false; error: RunError };
