// The worker methods the rules editor uses (SPEC 8.11 "Live check", 9.2 "layers 1-6 run in the browser on
// every save"): types only, re-exported from engineApi.ts so the rest of the app sees one worker surface.
import type { Format, LearnResult, PayloadCell, Rules, Tier } from '@formatai/shared';
import type { FileBytes } from './engineApi';

// ---------- the example kept in worker memory ----------

/** Read the example files again (for a saved conversion: example files are never stored, SPEC 8.12). */
export interface LoadExampleArgs {
  input: FileBytes;
  output: FileBytes;
  /** Attach mode: the format the output must already match. */
  target?: Format;
}

export type LoadExampleOutput =
  | { ok: true; exampleId: string; inputRows: number; outputRows: number }
  | { ok: false; reason: 'analysisFailed' };

// ---------- live check / full check ----------

export interface LiveCheckArgs {
  /** `LearnOutput.exampleId` (or `loadExample`'s). An id the worker no longer holds fails with code `exampleGone`. */
  exampleId: string;
  rules: LearnResult | Rules;
  /** 1-based example-output rows marked "fixed by hand": left out of every count. */
  exceptions?: number[];
  /** Allow a subset above 5,000 example rows (default true). `false` checks every row. */
  subset?: boolean;
}

/** One row of the preview table: row number, source values, "your example", "this rule". */
export interface PreviewRow {
  /** 1-based Excel row in the example output. */
  exampleRow: number;
  /** 1-based Excel row in the example input the row was made from, when known. */
  inputRow?: number;
  ok: boolean;
  /** The input row's values, in input column order. */
  source: PayloadCell[];
  /** The example output's values, per example column. */
  expected: PayloadCell[];
  /** What these rules produce, per example column. */
  actual: PayloadCell[];
  /** Positions in `expected`/`actual` that differ. */
  badColumns: number[];
}

export interface CellMismatch {
  exampleRow: number;
  /** Output header. */
  column: string;
  /** Position of the column (-1 when it can't be told). */
  columnIndex: number;
  expected: PayloadCell;
  actual: PayloadCell;
}

export interface ColumnCheck {
  header: string;
  /** False for a column the example doesn't have (added in the editor): nothing to compare it with. */
  inExample: boolean;
  matched: number;
  total: number;
}

export interface LiveCheckResult {
  /** Every row and every layout row matches (not counting exceptions). Never true for a `partial` check. */
  verified: boolean;
  /** "Matches X of Y rows": example rows that matched on every column, not counting exceptions. */
  matched: number;
  total: number;
  /** "Save with N differences": rows that differ plus layout problems. */
  differences: number;
  perColumn: ColumnCheck[];
  /** Cell-level mismatches, capped (see `mismatchCount` for the real number). */
  mismatches: CellMismatch[];
  mismatchCount: number;
  /** Mismatching rows first, then matching ones, capped. */
  preview: PreviewRow[];
  /** Titles, header, summary rows, blank rows, row count, file type, or a run that failed outright. */
  layoutProblems: string[];
  /** Only a subset of the rows was checked (big example): press Apply for all of them. */
  partial: boolean;
  checkedInputRows: number;
  totalInputRows: number;
  /** Milliseconds the check took in the worker. */
  ms: number;
}

// ---------- static checks ----------

export type StaticProblemLayer = 'structure' | 'references' | 'types' | 'limits' | 'formatLock';

export interface StaticProblem {
  layer: StaticProblemLayer;
  /** reference | depth | duplicateId | arity | type | limit | formatMismatch | schema | internal */
  kind: string;
  path?: string;
  message: string;
}

export interface StaticCheckOptions {
  tier: Tier;
  /** The format this conversion belongs to: turns on the format lock (SPEC 8.12). */
  format?: Format;
}

export interface StaticChecksArgs extends StaticCheckOptions {
  rules: LearnResult | Rules;
}
