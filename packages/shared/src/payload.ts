// The learn payload (LEARN_PROMPT.md §3) and the repair block (§4).
// Built in the browser (packages/engine learn/payload), sent to POST /api/learn,
// and the only user-derived content the LLM ever sees. Contains no file names,
// no UI language and no user identity.

/** A sample cell. Numbers are JSON numbers; real Excel dates are ISO "YYYY-MM-DD" strings; text dates stay as written. */
export type PayloadCell = string | number | boolean | null;

export type ProfileType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'currency'
  | 'percent'
  | 'date'
  | 'boolean'
  | 'idLike'
  | 'empty';

/** `stats` keys are included only when relevant, to save tokens (LEARN_PROMPT §3). */
export interface PayloadColumnStats {
  /** Share of empty cells, 0..1. */
  empty?: number;
  /** Distinct ratio 0..1 (omit when `values` is given). */
  distinct?: number;
  /** Distinct count, when small. */
  values?: number;
  /** [min, max] text length. */
  len?: [number, number];
  /** [min, max] numeric value, or ISO dates for date columns. */
  range?: [number, number] | [string, string];
  key?: boolean;
  leadingZerosLost?: boolean;
  israeliId?: boolean;
  /** Dates stored as Excel serial numbers. */
  serialDates?: boolean;
}

export interface PayloadColumn {
  /** 0-based position. */
  i: number;
  header: string;
  type: ProfileType;
  /** D = digit, A = Latin letter, H = Hebrew letter, other characters literal; "|" separates alternatives. */
  shape?: string;
  stats?: PayloadColumnStats;
  /** Output columns only: Excel number format of the data cells. */
  format?: string;
  /** Output columns only: column width (Excel character units). */
  width?: number;
}

export interface InputLayout {
  /** 0-based row index of the header row. */
  headerRow: number;
  /** Rows above the header to skip. */
  rowsAbove: number;
  /** Values that start footer rows to stop at (e.g. "סה\"כ"). */
  footerFirstCell: string[];
}

export interface TitleRowLayout {
  /** 0-based row index in the output sheet. */
  row: number;
  text?: string;
  blank?: boolean;
  bold?: boolean;
  /** The title contains a date/period derived from an input column. */
  containsDate?: { in: number; agg: 'min' | 'max'; format: string };
}

export interface OutputLayout {
  sheetName: string;
  direction: 'rtl' | 'ltr';
  language: 'he' | 'en';
  titleRows: TitleRowLayout[];
  /** 0-based row index of the header row in the output sheet. */
  headerRow: number;
  headerBold: boolean;
  /** One row per group, no detail rows. */
  summary: boolean;
  groupBy: {
    out: number;
    blankRowsAfter: number;
    subtotal?: { labelOut: number; label: string; sums: number[] };
  } | null;
  grandTotal: { labelOut: number; label: string; sums: number[] } | null;
  sort: { out: number; dir: 'asc' | 'desc' }[] | null;
}

/** An aligned pair, or (when rows expand) a family: one input row and all its output rows, in order. */
export type Sample =
  | { in: PayloadCell[]; out: PayloadCell[] }
  | { in: PayloadCell[]; out: PayloadCell[][] };

// ---------- Hints (LEARN_PROMPT §3) ----------
// Computed on ALL rows of the real data. `in` = input column positions, `out` = output column position.
// With masking on, values inside hints (pairs, filter values, constants) are masked with the same map as samples.

interface HintBase {
  /** Share of aligned rows where the relation holds, 0..1. */
  coverage: number;
  /** Sample indices where it fails (only when coverage < 1). */
  failsOn?: number[];
}

type Round = { round?: number };

export type ColumnHint = HintBase & { out: number } & (
  | { rel: 'copy'; in: [number] }
  | { rel: 'normalize'; in: [number] }
  | { rel: 'padLeft'; in: [number]; length: number; char?: string }
  | { rel: 'substr'; in: [number]; from: 'start' | 'end' | number; length: number }
  | { rel: 'concat'; in: number[]; separator: string }
  | { rel: 'valueMap'; in: [number]; pairs: [string, string][] }
  | { rel: 'constant'; in: []; value: PayloadCell }
  | { rel: 'dateFormat'; in: [number]; from: string; to: string }
  | { rel: 'numberFormat'; in: [number]; format: string }
  | ({ rel: 'mulConst' | 'addConst'; in: [number]; const: number } & Round)
  | ({ rel: 'add' | 'sub' | 'mul' | 'div'; in: [number, number] } & Round)
  | ({ rel: 'sum'; in: number[] } & Round)
  | { rel: 'aggregate'; in: [number]; fn: 'sum' | 'count' | 'min' | 'max' }
);

export type RowHint = HintBase &
  (
    | {
        rel: 'filter';
        in: [number];
        keptValues?: PayloadCell[];
        droppedValues?: PayloadCell[];
        droppedWhen?: { op: 'isEmpty' | 'notEmpty' | 'gt' | 'gte' | 'lt' | 'lte'; value?: number };
      }
    | { rel: 'dedupe'; in: number[]; keys: number[] | 'all'; keep: 'first' | 'last' }
  );

export type ExpandHint = HintBase &
  (
    | { rel: 'expand'; mode: 'columnsToRows'; in: number[]; labelOut: number; valueOut: number; skipEmpty: boolean }
    | { rel: 'expand'; mode: 'splitCell'; in: [number]; separator: string; out: number }
    | { rel: 'expand'; mode: 'fixedFanOut'; size: number; positions: ColumnHint[][] }
  );

export type Hint = ColumnHint | RowHint | ExpandHint;

export interface LearnPayload {
  masking: boolean;
  input: {
    sheetName: string;
    direction: 'rtl' | 'ltr';
    layout: InputLayout;
    columns: PayloadColumn[];
  };
  output: {
    layout: OutputLayout;
    columns: PayloadColumn[];
  };
  /** Up to 12 pairs, or up to 6 families when rows expand. */
  samples: Sample[];
  /** Up to 5 input rows that don't appear in the output. */
  dropped?: PayloadCell[][];
  hints: Hint[];
  /** Output column positions that can't be produced from the input. */
  skipColumns?: number[];
}

// ---------- Repair (LEARN_PROMPT §4) ----------

export type RepairProblem =
  | { kind: 'schema'; path: string; message: string }
  | { kind: 'reference'; message: string }
  | {
      kind: 'diff';
      out: number;
      /** Index into payload.samples. */
      sample?: number;
      /** Row inside a family sample, 0-based. */
      familyRow?: number;
      /** A failing row from the browser's full verification (masked when masking is on). */
      row?: { in: PayloadCell[]; out: PayloadCell[] };
      expected?: PayloadCell;
      actual: PayloadCell;
    }
  | { kind: 'rowCount'; expected: number; actual: number }
  | { kind: 'layout'; message: string };

export interface RepairBlock<Rules = unknown> {
  mode: 'repair';
  previousRules: Rules;
  /** At most 10 `diff` problems. */
  problems: RepairProblem[];
}

/** Appended to the repair user content (LEARN_PROMPT §4). */
export const REPAIR_INSTRUCTION = 'Fix only what the problems require. Keep everything else identical.';
