// Types for the column profile (SPEC 7.1) and the pair analysis (SPEC 6.2).
//
// Everything here is computed in the browser, on the real (unmasked) data,
// before any LLM call. Column references follow the payload's conventions
// (LEARN_PROMPT §3): `in` = input column position, `out` = output column
// position, both 0-based. Relations are shaped like the payload's hints so the
// payload builder can turn them into `Hint`s directly: copy the relation, map
// `failing` (aligned-row indices) to sample indices as `failsOn`, and drop the
// bookkeeping fields (`matched`, `total`, `failCount`).
//
// Row references:
//  - "input row"        = index into `input.rows` (the detected data rows, 0-based)
//  - "output data row"  = index into `output.dataRows` (0-based)
//  - "aligned row"      = index into `alignment.rows`; `failing` lists use it
//  - "sheet row"        = 0-based row index in the output sheet (`output.sheet.rows`)

import type {
  Band,
  InputLayout,
  OutputLayout,
  PayloadCell,
  ProfileType,
  SummaryAgg,
  SummaryRowLayout,
  TitleRowLayout,
  WindowFn,
  WindowTies,
} from '@formatai/shared';
import type { DelimitedSniffResult } from '../../io/detectFileSpec';
import type { OutputFileSpec, RawCell, RawSheet, TableDetection, TableIssue } from '../../types';

export type { SummaryAgg };

// ---------- Column profile (SPEC 7.1) ----------

/** What `profileColumns` reads: headers and data rows (no title/header/footer rows). */
export interface ProfileTable {
  headers: string[];
  rows: (RawCell | null)[][];
  /** Output side: column widths in Excel character units (RawSheet.colWidths). */
  colWidths?: (number | undefined)[];
  /** Workbook uses the 1904 date system. */
  date1904?: boolean;
}

export interface ProfileOptions {
  /** Output columns: also record each column's Excel number format and width. */
  output?: boolean;
}

export interface ColumnProfile {
  /** 0-based position. */
  i: number;
  header: string;
  type: ProfileType;
  /** D = digit, A = Latin letter, H = Hebrew letter, other characters literal; "|" separates alternatives (capped). */
  shape?: string;
  rows: number;
  nonEmpty: number;
  /** Share of empty cells, 0..1. */
  emptyRate: number;
  /** Distinct non-empty values (after text normalization). */
  distinctCount: number;
  /** distinctCount / nonEmpty (0 when the column is empty). */
  distinctRatio: number;
  /** [min, max] text length of non-empty values (text-like columns). */
  len?: [number, number];
  /** [min, max] value: numbers for numeric columns, ISO dates for date columns. */
  range?: [number, number] | [string, string];
  /** Unique and never empty. */
  key: boolean;
  /** Digit strings whose leading zeros were dropped (e.g. 8-digit ids in a 9-digit id column). */
  leadingZerosLost: boolean;
  /** 9 digits with a valid check digit on >= 95% of rows, after padding. */
  israeliId: boolean;
  /** Dates stored as plain Excel serial numbers (set by the pair analysis when a relation proves it). */
  serialDates: boolean;
  /** Numeric column whose values are (at least partly) text, e.g. "1,234.50". */
  numbersAsText: boolean;
  /** Date columns: the token format of text dates ("DD/MM/YYYY"), or "excel" for real date cells. */
  dateFormat?: string;
  /** Text dates where every value also reads as a valid date with day and month swapped. */
  dayMonthAmbiguous?: boolean;
  /** Output columns: the most common Excel number format of the data cells. */
  format?: string;
  /** Output columns: width in Excel character units. */
  width?: number;
}

// ---------- Options ----------

export type AnalysisStage = 'tables' | 'profile' | 'align' | 'shape' | 'relations' | 'dropped' | 'layout' | 'done';

export interface AnalysisProgress {
  stage: AnalysisStage;
  /** Overall progress, 0..1. */
  fraction: number;
}

export interface AnalyzeOptions {
  /** Sheet index (0-based) or name. Default: the first non-empty sheet. */
  inputSheet?: number | string;
  outputSheet?: number | string;
  /** The output file spec, when already known (e.g. attach mode). Default: detectFileSpec on the output workbook. */
  outputFileSpec?: OutputFileSpec;
  /** sniffDelimitedText() of the output file's bytes (csv/txt), so detectFileSpec can see `quote: 'all'`. */
  outputSniff?: DelimitedSniffResult;
  onProgress?: (p: AnalysisProgress) => void;
  /** Aligned rows used for the first pass over candidate relations (SPEC 6.2). Default 2000. */
  sampleSize?: number;
  /** Seed of the sample's PRNG. Default 1. */
  seed?: number;
  /** Relations below this coverage are not reported. Default 0.9 (SPEC 6.2: partial hints). */
  minCoverage?: number;
}

// ---------- Tables ----------

export type OutputRowKind = 'title' | 'header' | 'data' | 'blank' | 'summaryGroup' | 'summaryEnd';

export interface SideIssue extends TableIssue {
  side: 'input' | 'output';
}

export interface InputSide {
  sheetIndex: number;
  sheetName: string;
  direction: 'rtl' | 'ltr';
  detection: TableDetection;
  /** Payload-ready input layout (LEARN_PROMPT §3). */
  layout: InputLayout;
  headers: string[];
  columnCount: number;
  /** Data rows only, aligned to `headers`. */
  rows: (RawCell | null)[][];
  /** 1-based Excel row number of each data row. */
  rowNumbers: number[];
  date1904: boolean;
  profile: ColumnProfile[];
}

export interface OutputSide {
  sheetIndex: number;
  sheetName: string;
  direction: 'rtl' | 'ltr';
  detection: TableDetection;
  sheet: RawSheet;
  /** Detected (or given) file spec. */
  file: OutputFileSpec;
  /** No header row: columns are identified by position only (SPEC 8.13). */
  headerless: boolean;
  /** Sheet row of the header, -1 when headerless. */
  headerRow: number;
  /** Header texts ('' for every column when headerless). */
  headers: string[];
  columnCount: number;
  /** Kind of every sheet row, from row 0 to the last non-empty row. */
  rowKinds: OutputRowKind[];
  /** Sheet rows of the data rows, in order. The output data-row index is the position here. */
  dataRows: number[];
  /** Profile of the data rows only. */
  profile: ColumnProfile[];
}

// ---------- Alignment (SPEC 6.2 step 2) ----------

export interface KeyMatch {
  /** Input column(s) of the key (1 or 2). */
  in: number[];
  /** Output column(s) of the key, same order. */
  out: number[];
  /** Share of output data rows whose key was found in the input. */
  matchRate: number;
  /** Share of found keys that point to exactly one input row. */
  uniqueness: number;
}

export interface AlignedRow {
  /** Output data-row index. */
  out: number;
  /** Input row index. For summary shapes: the group's first input row. */
  in: number;
}

export interface Alignment {
  /** key: by a key column; group: summary output (one row per group); position: same row order (no key); none: couldn't align. */
  method: 'key' | 'group' | 'position' | 'none';
  key: KeyMatch | null;
  /** One entry per aligned output data row, in output order. */
  rows: AlignedRow[];
  /** Output data rows that matched no input row. */
  unalignedOut: number[];
  /** Input rows that produced no output row. */
  droppedIn: number[];
}

// ---------- Shape (SPEC 6.2 step 3) ----------

export interface Family {
  /** Input row. */
  in: number;
  /** Aligned-row indices of its output rows, in output order. */
  rows: number[];
}

/** A column the family pattern creates (SPEC 8.5), usable as a relation operand. */
export type CreatedKind = 'label' | 'value' | 'part' | 'position' | 'count';

export interface CreatedColumn {
  /**
   * Operand index used in relation `in` arrays: always >= input.columnCount
   * (input.columnCount + position in `created`).
   */
  index: number;
  kind: CreatedKind;
}

export type FamilyPattern =
  | {
      mode: 'columnsToRows';
      /** Input columns turned into rows, in input order. */
      in: number[];
      /** Output column holding the label (the input header). */
      labelOut: number;
      /** Output column holding the cell. */
      valueOut: number;
      skipEmpty: boolean;
    }
  | {
      mode: 'splitCell';
      in: [number];
      separator: string;
      /** Output column holding the part. */
      out: number;
      trim: boolean;
      skipEmpty: boolean;
    }
  | {
      mode: 'fixedFanOut';
      size: number;
      /** Relations per position (0-based), per output column; failing lists use global aligned-row indices. */
      positions: ColumnAnalysis[][];
    };

export type PairShape =
  | { kind: 'plain' }
  | {
      kind: 'summary';
      /** Input column whose distinct values are the output rows. */
      groupIn: number;
      /** Output column holding the group value. */
      groupOut: number;
      /** Input rows of each group, parallel to `alignment.rows`. */
      groups: number[][];
    }
  | { kind: 'pivot'; in: number; outColumns: number[] }
  | { kind: 'families'; pattern: FamilyPattern; families: Family[]; created: CreatedColumn[] }
  | {
      kind: 'rowExpansion';
      families: Family[];
      /** [smallest, largest] family size. */
      sizes: [number, number];
    };

// ---------- Relations (SPEC 6.2 step 4) ----------

export interface RelationStats {
  /** Output column. */
  out: number;
  /** Share of aligned rows (groups, for summary shapes) where the relation holds, 0..1. */
  coverage: number;
  matched: number;
  total: number;
  /** Aligned-row indices where it fails, ascending, capped (see failCount). */
  failing: number[];
  failCount: number;
}

type Round = { round?: number };

/**
 * One tested relation. Operands in `in` are input columns, or created family
 * columns when >= input.columnCount (see PairShape families.created).
 */
export type RelationBody =
  | { rel: 'copy'; in: [number] }
  | { rel: 'normalize'; in: [number]; case?: 'upper' | 'lower' }
  | { rel: 'padLeft'; in: [number]; length: number; char: string }
  /** from: 'start' (prefix), 'end' (suffix) or a 1-based start position (like the engine's substr). */
  | { rel: 'substr'; in: [number]; from: 'start' | 'end' | number; length: number }
  /** Whole part of a split: index is 1-based, negative counts from the end (the engine's split). */
  | { rel: 'split'; in: [number]; separator: string; index: number }
  | { rel: 'concat'; in: number[]; separator: string; skipEmpty: boolean }
  /**
   * Fixed text around and between 1-2 input values, identical on every row (`<id>:"<name>"`). `parts` is the
   * output text in order: a string is fixed text (never empty), `{ in: n }` is the value of column n (a column
   * may appear twice). `in` lists the columns used, once each, in order of first use. Coverage is always 1:
   * a template that fails on any row is not reported (SPEC 6.2 step 4; `limits.learn.template`).
   */
  | { rel: 'template'; in: number[]; parts: (string | { in: number })[] }
  | { rel: 'valueMap'; in: [number]; pairs: [string, string][] }
  | { rel: 'constant'; in: []; value: PayloadCell }
  /**
   * from: the input's text date format ("DD/MM/YYYY"), "date" for real date cells, or
   * "excelSerial" for plain serial numbers. to: token format of text output dates, or
   * the Excel number format of real output date cells.
   */
  | { rel: 'dateFormat'; in: [number]; from: string; to: string }
  /** The output is the number rendered as text with this Excel-style format. */
  | { rel: 'numberFormat'; in: [number]; format: string }
  | ({
      rel: 'mulConst' | 'addConst';
      in: [number];
      const: number;
      /** exact decimal text of const */
      constText: string;
      /**
       * mulConst only: the output is the input DIVIDED by this constant (x / 1.17), `const` being its reciprocal (0.854701...).
       * Set instead of a plain factor when the divisor has fewer significant digits than the factor: the roundest of the
       * two readings is the real one (an exact rate), and it does not drift on next month's values.
       */
      divisor?: number;
      /** exact decimal text of `divisor` */
      divisorText?: string;
    } & Round)
  | ({ rel: 'add' | 'sub' | 'mul' | 'div'; in: [number, number] } & Round)
  | ({ rel: 'sum'; in: number[] } & Round)
  /** Summary shapes: the output value is this aggregate of the group's input rows. */
  | { rel: 'aggregate'; in: [number]; fn: SummaryAgg }
  /**
   * Across rows, and ORDER-INDEPENDENT (the only window patterns the free engine writes): every row shows its group's total of
   * `in[0]` (`groupSum`), or how many rows its group has (`groupCount`, `in` empty). The group is the rows with the same value
   * of the `by` column. Exact on every aligned row (coverage 1) or not built; see windows.ts. The order-dependent and other window
   * patterns are `WindowFinding`s (hints only).
   */
  | { rel: 'window'; fn: 'groupSum' | 'groupCount'; in: number[]; by: [number] };

export type RelationKind = RelationBody['rel'];

/** What a window finding orders its rows by: the input's row order, the order the output shows, or exact sort keys. */
export type WindowOrder = 'file' | 'output' | { in: number; dir: 'asc' | 'desc' }[];

/**
 * An across-row (window) pattern one output column follows (docs/proposals/window-operations.md): `fn` of `in` over the groups of
 * `by`, in `order`. Computed on all aligned rows with exact decimal arithmetic, in the INPUT's row order (what the engine will run), so a
 * finding at coverage 1 is a fact. `built`: the free engine writes it as a rule (a group's total, a count per group); every other
 * finding is a hint for the AI step and is only sent once learn-v7 documents window functions (`limits.learn.window.hintsEnabled`).
 */
export interface WindowFinding {
  out: number;
  fn: WindowFn;
  /** The column read: `[x]`, none for `rowNumber`, `rank` and `groupCount`. */
  in: number[];
  /** The group columns (one); none = all rows are one group. */
  by: number[];
  order: WindowOrder;
  ties?: WindowTies;
  coverage: number;
  matched: number;
  total: number;
  /** Aligned-row indices where it fails, ascending, capped. */
  failing: number[];
  failCount: number;
  built: boolean;
  /** Other (column, group) readings that fit just as well, at most 3: the pattern is exact on the example but ambiguous. */
  alt?: { in?: number[]; by?: number[] }[];
}

export type Relation = RelationStats & RelationBody;

/**
 * SPEC 6.2 step 4 (v5): an output column no relation explains, but that the INPUT determines - a functional
 * dependency with real evidence (see derived.ts) - or that is COMPOSED from input values (their text sits inside the
 * output cells, e.g. `<id> - <first> <last>`, beyond the light `template`). The AI can solve such a column (e.g.
 * `Size = "bulk" if Qty >= 10 else "single"`), so it is NOT external data: it is not skipped, and it counts as
 * "needs the AI step".
 */
export type Derivation = { coverage: number; /** Aligned rows where it fails, ascending, capped. */ failing: number[]; failCount: number } & (
  | {
      kind: 'category';
      /** The determining input (or created family) columns: 1, or 2 together. */
      in: number[];
      /** Distinct values (or value pairs) of the determining columns. */
      keys: number;
    }
  | {
      kind: 'bands';
      in: [number];
      /** Contiguous ranges of the input column with one output value each (<= 5 breakpoints). */
      bands: Band[];
    }
  | {
      kind: 'composition';
      /** The input columns whose value sits inside the output text, ordered by where they first appear in it. */
      in: number[];
    }
);

export interface ColumnAnalysis {
  out: number;
  header: string;
  /** Best first: coverage desc, then the simplest. Only relations with coverage >= minCoverage. */
  relations: Relation[];
  /** No relation reached minCoverage (SPEC 6.2 "unknown"). Whether it is external data or derived: see `derived`. */
  unknown: boolean;
  /**
   * Unknown columns only: set when the input determines the values (a `derived` column, solvable by the AI).
   * An unknown column with `derived === null` is EXTERNAL data: its values don't come from the input file
   * (SPEC 6.4: wording only, the AI step still tries it) - see `isExternalColumn`.
   */
  derived: Derivation | null;
  /**
   * Across-row (window) patterns this column follows, best first: a built one (see `Relation` `window`) and/or hint-only ones. Only
   * set when found; the free engine builds the order-independent ones from `relations`, never from here.
   */
  windows?: WindowFinding[];
}

// ---------- Dropped rows ----------

export interface FilterRelation {
  rel: 'filter';
  in: [number];
  /** Values seen in kept rows (when few). */
  keptValues?: PayloadCell[];
  /** Values seen only in dropped rows (when few). */
  droppedValues?: PayloadCell[];
  /** Emptiness or a numeric (or ISO date) threshold that drops the rows. */
  droppedWhen?: { op: 'isEmpty' | 'notEmpty' | 'gt' | 'gte' | 'lt' | 'lte'; value?: number | string };
  /** Share of (kept + filter-dropped) input rows the filter classifies correctly. */
  coverage: number;
  /** Input rows it misclassifies, ascending, capped. */
  failing: number[];
  failCount: number;
}

export interface DedupeRelation {
  rel: 'dedupe';
  /** Input columns compared: the key, or every column. */
  in: number[];
  keys: number[] | 'all';
  keep: 'first' | 'last';
  /** Share of the duplicate rows consistent with `keep`. */
  coverage: number;
  /** Each dropped copy with the kept input row it duplicates. */
  duplicates: { row: number; of: number }[];
}

export interface DroppedAnalysis {
  /** Input rows that produced no output row (excluding explainedByExpand). */
  rows: number[];
  /** Input rows that produce no output because the family pattern skips empty cells. */
  explainedByExpand: number[];
  dedupe: DedupeRelation | null;
  /** Filters explaining the dropped rows that dedupe doesn't, best first. */
  filters: FilterRelation[];
  /** Dropped rows explained neither by dedupe nor by the best filter. */
  unexplained: number[];
}

// ---------- Layout (SPEC 6.2 step 5) ----------

export type TitlePart = { text: string } | { in: number; agg: 'min' | 'max'; format: string; language: 'he' | 'en' };

export interface TitleRowAnalysis extends TitleRowLayout {
  /** When the title contains dates: the title split into literal text and date parts (SPEC 8.7 `parts`). */
  parts?: TitlePart[];
}

export interface SummaryRowAnalysis extends SummaryRowLayout {
  /** Sheet rows of every occurrence (one per group, or one at the end). */
  rows: number[];
  /** The label differs between occurrences (`label` holds the first). */
  labelVaries?: boolean;
  /** Output columns with values that no aggregate explains on every group. */
  unexplained: number[];
}

export interface LayoutAnalysis extends OutputLayout {
  titleRows: TitleRowAnalysis[];
  groupBy: { out: number; blankRowsAfter: number; summaryRows?: SummaryRowAnalysis[] } | null;
  summaryRows: SummaryRowAnalysis[];
  /** Blank rows between the last group (or the data) and the summary rows at the end. */
  blankRowsBeforeSummary: number;
  /** Blank body rows no rule explains (sheet rows). */
  unexplainedBlankRows: number[];
  /** The output keeps the input's row order (no sort needed). */
  orderMatchesInput: boolean;
  /** Excel number format per output column (data cells). */
  columnFormats: (string | undefined)[];
  /** Width per output column. */
  columnWidths: (number | undefined)[];
  file: OutputFileSpec;
}

// ---------- Result ----------

export interface PairAnalysis {
  ok: true;
  /** Notices (hidden rows, several sheets) from both sides. */
  issues: SideIssue[];
  /** The two sheets hold exactly the same cells (SPEC 6.3 block). */
  identical: boolean;
  input: InputSide;
  output: OutputSide;
  /** Output headers that are values of one input column (SPEC 6.3 block), when found. */
  pivot: { in: number; outColumns: number[] } | null;
  alignment: Alignment;
  shape: PairShape;
  /** One per output column, in output order. */
  columns: ColumnAnalysis[];
  dropped: DroppedAnalysis;
  layout: LayoutAnalysis;
  /** The aligned rows the first pass used (seeded random sample). */
  sample: { size: number; seed: number };
}

export interface PairAnalysisFailure {
  ok: false;
  /** At least one 'reject' issue (SPEC 6.1). */
  issues: SideIssue[];
}

export type PairAnalysisResult = PairAnalysis | PairAnalysisFailure;
