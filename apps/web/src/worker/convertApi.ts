// The worker methods of "convert a file" (SPEC 5 C, 5 D, 8.15, 21 v5 item 5): types only, re-exported from engineApi.ts so the
// rest of the app sees one worker surface. Matching a file to a saved SOURCE, running one of its conversions with the user's row
// decisions (the review happens BEFORE the file is written), and packing a batch into a zip and a summary workbook.
import type { ConversionMatch, ConversionPick, Flag, OutputSheet, RowDecisions, RunError, RunSummary } from '@formatai/engine';
import type { LearnResult, Rules, SignatureColumn } from '@formatai/shared';
import type { FileBytes } from './engineApi';

// ---------- the headers of a file ----------

export interface HeadersArgs {
  file: FileBytes;
}

export type HeadersOutput =
  | { ok: true; headers: string[]; sheetName: string; direction: 'rtl' | 'ltr'; rows: number }
  /** `unreadable`: the file doesn't open. `noTable`: it opens, but there is no table with a header row. */
  | { ok: false; reason: 'unreadable' | 'noTable' };

// ---------- matching a file to a saved source (SPEC 8.12, 8.15) ----------

/** What the API's GET /api/signatures gives (one entry per SOURCE), in the shape the engine's matcher takes. */
export interface SignatureInput {
  /** The source's id (the engine calls it a conversion id; it only needs a key). */
  id: string;
  /** The source's name, shown next to the score in the "which source is this file?" list. */
  name: string;
  columns: SignatureColumn[];
}

export interface MatchFileArgs {
  file: FileBytes;
  signatures: SignatureInput[];
}

export type MatchFileOutput =
  | {
      ok: true;
      /** The file's own headers, as read. */
      headers: string[];
      /** Every signature, best first (`matchConversions`). */
      ranked: ConversionMatch[];
      /** `pickConversion`: one clear winner, or the top matches for the user to choose from. */
      pick: ConversionPick;
    }
  | { ok: false; reason: 'unreadable' | 'noTable' };

// ---------- running a conversion, with the user's decisions about flagged rows ----------

/** One input column of a flagged row, as the run read it: what "Fix this row only" lets the user edit. */
export interface RowInputCell {
  /** The rules' input column id (the key of a `RowDecision` override). */
  columnId: string;
  /** The rules' declared header. */
  header: string;
  /** The cell as text/number; a date cell shows as text in the column's own format so an edit can be read back. */
  value: string | number | boolean | null;
}

export interface ConvertRunArgs {
  rules: LearnResult | Rules;
  file: FileBytes;
  /**
   * `review`: run the rules and, if any row is flagged or left out by a check, stop BEFORE writing and hand back what
   * the user must look at (`written: false`). Nothing to look at: the file is written right away.
   * `write`: always write the file, applying `rowDecisions`.
   */
  mode: 'review' | 'write';
  /** Per-run decisions keyed by the 1-based input row number (never stored: SPEC 21 v5 item 5). */
  rowDecisions?: RowDecisions;
  /** Output rows kept in `preview` for the on-screen preview of a written file. */
  previewRows: number;
}

interface ConvertRunBase {
  ok: true;
  flags: Flag[];
  summary: RunSummary;
  fileType: 'xlsx' | 'csv' | 'txt';
}

export type ConvertRunOutput =
  | { ok: false; error: RunError }
  /** A review is needed: the rows to look at, and each one's input values. No file has been written. */
  | (ConvertRunBase & { written: false; rowInputs: Record<number, RowInputCell[]> })
  | (ConvertRunBase & {
      written: true;
      /** The whole output file, transferred back. */
      bytes: ArrayBuffer;
      preview: OutputSheet;
      totalRows: number;
    });

// ---------- packing a batch ----------

export interface BatchOutputFile {
  /** The folder in the zip (the format's name); empty = the top level. */
  folder: string;
  fileName: string;
  bytes: ArrayBuffer;
}

/** A plain table for the summary workbook. The strings are already in the UI language: the worker has no dictionary. */
export interface SummaryTable {
  sheetName: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
}

export interface BatchArgs {
  outputs: BatchOutputFile[];
  /** Sheet 1: one row per file. Sheet 2: one row per flag. */
  summary: { files: SummaryTable; flags: SummaryTable; language: 'he' | 'en' };
  /** The summary workbook's file name (it is in the zip too). */
  summaryFileName: string;
}

export interface BatchOutput {
  /** Every converted file (in a folder per format) and the summary workbook. */
  zip: ArrayBuffer;
  /** The summary workbook alone. */
  summary: ArrayBuffer;
}
