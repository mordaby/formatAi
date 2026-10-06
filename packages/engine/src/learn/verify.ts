// verifyAgainstExample (SPEC 5 A step 6, 9.2 layer 8, 8.11 "Live check"): runs a
// candidate rules file on the FULL real input table and diffs the result against the
// FULL real example output - data rows and layout rows (titles, header, summary rows,
// blank rows, file type) alike. This is the hold-out test LEARN_PROMPT's system prompt
// describes ("the LLM saw at most 12 rows, so this is the hold-out test") and the same
// check the rules-map editor's own live check (SPEC 8.11) re-runs on every edit.
//
// Pure and synchronous, like the rest of this package: no DOM/Node APIs, no network.
//
// Data rows are compared using the SAME alignment the pair analysis already computed
// (`analysis.alignment`), grouped by input row - exactly the technique
// `apps/api/src/learn/sampleRun.ts` uses for the (much smaller) sample run, generalized
// to the whole file. Grouping by input row, rather than by output position, is what
// makes this uniform across plain rows, expand families (SPEC 8.5) and summary shapes
// (SPEC 8.6: `AlignedRow.in` is "the group's first input row" there too) with no
// per-shape special-casing.
//
// Layout rows (everything that isn't a data row) are compared positionally: the
// sequence of non-data row *kinds* the pair analysis found in the real sheet
// (`analysis.output.rowKinds`) versus the sequence the engine actually produced
// (`result.sheet.rows`). A correct rules file reproduces the same sequence in the same
// order, so a plain position-by-position walk is enough - and any divergence (a missing
// title, a summary row the rules don't emit, an extra blank row) is exactly the kind of
// thing a human glancing at the two files side by side would flag first.
import type { ColumnClass, LearnResult, PayloadCell, Rules, RepairProblem } from '@formatai/shared';
import { DEFAULT_OUTPUT_FILE } from '@formatai/shared';
import { runRules } from '../pipeline/runRules';
import type { InputTable, OutCell, OutRow, OutRowKind, OutputFileSpec, RawCell } from '../types';
import { isoOfSerial } from './analyze/cells';
import type { OutputRowKind, PairAnalysis } from './analyze';
import type { Masker } from './mask';
import { classifyColumns } from './classify';

/** LEARN_PROMPT §4: "At most 10 diff problems are sent." Same cap as the API's sample
 * run (`apps/api/src/learn/sampleRun.ts`), enforced here for the same reason: a repair
 * call only needs enough examples to fix the pattern, not every failing row. */
const MAX_DIFF_PROBLEMS = 10;

export interface VerifyOptions {
  /** SPEC 8.11 "One-off exceptions": 1-based example row numbers (the output sheet's
   * own Excel row number, matching `Flag.rowNumber`'s convention) the user marked
   * "fixed by hand". Excluded from the count and never reported as mismatches. */
  exceptions?: number[];
  /**
   * SPEC 21 v12 item 20 ("a one-time change"): cells of the example the user said were edited by hand once - the example row (1-based, as
   * `exceptions`) in ONE output column (its header). That cell is not compared, so it is never a mismatch (the row still counts, and its
   * other columns are compared as usual); where it differs it is listed in `VerifyResult.oneTime` instead, for the screen to show.
   */
  oneTime?: { exampleRow: number; column: string }[];
  /** SPEC 7.2/9.3: when given, every cell value carried in a `repairProblems` diff - its `row`, `made`, `expected` and `actual` (never the
   * UI-facing `mismatches`) - is masked with it, so a browser-triggered repair call never sends real data when masking is on. */
  masker?: Masker;
  /** The learning loop (`learn/loop.ts`): also list every row the rules got wrong (`VerifyResult.wrongRows`). Off by default: the
   * live check and the Run screen do not need it, and a file with many wrong rows would carry them across the worker boundary. */
  wrongRows?: boolean;
  /**
   * SPEC 21 v5 item 1 (the local partial result): only these output columns (0-based positions) are
   * compared, on the aligned data rows. Everything that is about the whole file's structure - the row count
   * and the title, header, blank and summary rows - is skipped, since a partial result doesn't build all of
   * it yet; the file settings, the unmatched-rows notice and rows the example dropped that the rules still
   * produce are still reported. An empty list checks nothing: `verified` is false with 0 of 0 rows.
   */
  onlyColumns?: number[];
}

export interface Mismatch {
  /** 1-based Excel row number in the example OUTPUT sheet (same convention as
   * `exceptions`/`Flag.rowNumber`). */
  exampleRow: number;
  /** Output column header (as declared by `rules`, falling back to the example's own
   * header for a headerless file - SPEC 8.13). */
  column: string;
  expected: PayloadCell;
  actual: PayloadCell;
}

/**
 * What a layout problem is about, as a code (SPEC 8.11 line status): the rules map reads these instead of the
 * English `message`. `rowCount` and `unalignedRows` are about the data rows; `fileSettings` is the output file's
 * type and text options; `titleRow`, `headerRow`, `blankRow` and `summaryRow` name the kind of layout row that
 * differs (the row the example has, or the extra row the rules make); `runFailed` means the rules could not run.
 */
export type LayoutProblemCode = 'runFailed' | 'unalignedRows' | 'rowCount' | 'fileSettings' | 'titleRow' | 'headerRow' | 'blankRow' | 'summaryRow';

export interface LayoutProblem {
  code: LayoutProblemCode;
  /** The same English sentence as the matching `layoutProblems` entry. */
  message: string;
}

export interface VerifyResult {
  /** Every output data row matches (not counting exceptions) and every layout row
   * (titles, header, summary rows, blank rows, file type) matches too. */
  verified: boolean;
  /** Output data rows that matched every column, not counting exceptions. */
  matched: number;
  /** Output data rows compared, not counting exceptions. */
  total: number;
  mismatches: Mismatch[];
  /** Human-readable layout problems (titles, header, summary rows, blank rows, file
   * type). Always empty when `verified` is true. */
  layoutProblems: string[];
  /** The same problems as `layoutProblems` (same order), each with a `code`, so a UI never has to parse the English. */
  layoutIssues: LayoutProblem[];
  /** SPEC 9.3/LEARN_PROMPT §4: at most 10 `diff` problems (each carrying the real
   * failing row, masked when a masker is given) plus any `rowCount`/`layout`
   * problems - ready to send as the browser-triggered repair call's problem list. */
  repairProblems: RepairProblem[];
  /** Only with `VerifyOptions.wrongRows`: every input row whose output the rules got wrong, in file order (real values). */
  wrongRows?: WrongRow[];
  /** Only with `VerifyOptions.oneTime`: the cells left out that differ from the example (the rows that don't follow the rule, by the user's word). */
  oneTime?: Mismatch[];
}

/** One cell of the example the rules got wrong (the learning loop's counterexamples, `learn/loop.ts`). Real values: never sent as they are. */
export interface WrongCell {
  /** Output column (0-based). */
  out: number;
  /** The example output's data row it is in (an index into `analysis.output.dataRows`). */
  outRow: number;
  expected: PayloadCell;
  actual: PayloadCell;
}

/**
 * One input row of the example whose output the rules got wrong: a cell that differs (or a row of the example the rules do not make, each
 * of its non-empty cells a wrong cell), or rows the rules make that the example does not have (`extra`: an extra row of a family, or any row
 * of an input row the example dropped). Real values, for the learning loop to choose from: it masks what it sends.
 */
export interface WrongRow {
  /** An index into `analysis.input.rows`. */
  inRow: number;
  cells: WrongCell[];
  /** The rows the rules make for this input row that the example does not have, as the rules wrote them. */
  extra: PayloadCell[][];
}

// ---------------------------------------------------------------------------
// Typed cell comparison (mirrors apps/api/src/learn/sampleRun.ts's cellsEqual /
// actualCellValue, generalized to real - not payload-truncated - RawCell input).
// ---------------------------------------------------------------------------

/** RawCell -> PayloadCell (SPEC 7.3): numbers as numbers, real dates as ISO text.
 * `date1904` shifts a real date's serial before conversion - only the INPUT side's own
 * flag is threaded through (`analysis.input.date1904`); like `payload.ts`'s
 * `outputRowCells`, the example output's real date cells are read as the standard 1900
 * system (`PairAnalysis.output` carries no date1904 flag of its own - see payload.ts's
 * DECISION comment). */
function toExpectedCell(cell: RawCell | null | undefined, date1904 = false): PayloadCell {
  if (!cell || cell.v === null) return null;
  if (typeof cell.v === 'number' && cell.isDate) return isoOfSerial(Math.trunc(cell.v) + (date1904 ? 1462 : 0));
  return cell.v;
}

function actualCellValue(cell: OutCell | undefined): PayloadCell {
  if (cell === undefined || cell.v === undefined) return null;
  if (cell.isDate === true && typeof cell.v === 'number') return isoOfSerial(cell.v);
  return cell.v;
}

/** A cell as the user would see it: its value, and whether it is a real date (not text that reads as one). */
interface Seen {
  v: PayloadCell;
  date: boolean;
  /** A date the rules made: the text a csv / txt file writes for it (its column's date format), when known. */
  text?: string;
}

function expectedSeen(cell: RawCell | null | undefined, date1904 = false): Seen {
  return { v: toExpectedCell(cell, date1904), date: cell?.isDate === true && typeof cell.v === 'number' };
}

function actualSeen(cell: OutCell | undefined): Seen {
  const date = cell?.isDate === true && typeof cell.v === 'number';
  return { v: actualCellValue(cell), date, ...(date && cell?.text !== undefined ? { text: cell.text } : {}) };
}

/** Numbers compare with a small epsilon (a decimal.js value that round-trips through
 * `Number` for `OutCell.v` can drift in the last bit); everything else compares exactly. */
function valuesEqual(expected: PayloadCell, actual: PayloadCell): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) < 1e-9;
  // A cell holding empty text and an empty cell look the same in Excel: files often carry "" cells (a formula's =IF(..., "", ...), an
  // export that writes every cell), and the engine writes nothing for an empty value. Only exact "" - text with spaces is not empty.
  if ((expected === '' && actual === null) || (expected === null && actual === '')) return true;
  return expected === actual;
}

/** A number the way a delimited file writes it (no grouping, no symbol): digits with an optional fraction. */
const PLAIN_NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * The typed cell compare (SPEC 9.2 layer 7's "compare typed", mirrored here for the full file): what the user
 * sees, cell by cell. Text compares as exact text, numbers numerically, dates as dates; a number is never equal
 * to text that merely reads like it ("₪1,234.00" is not 1234, "1,234.00" is not either), and text that reads like
 * a date is not a date.
 *
 * The one exception is a csv/txt example output: its cells are always strings (`RawCell.v`: "CSV cells are always
 * strings"), so a real "12" cell matches the engine's own number 12, which the delimited writer writes as plain
 * digits. Only such a plain digit string qualifies - never one with a currency sign, grouping or a percent sign,
 * which the writer would not reproduce. A date the rules make is compared the same way, by the text the writer
 * writes for it (its column's date format): "2024-09-28" in the example is not the date written "28/09/2024".
 */
function cellsMatch(expected: Seen, actual: Seen, delimited: boolean): boolean {
  if (delimited && actual.date && !expected.date && actual.text !== undefined) return typeof expected.v === 'string' && expected.v === actual.text;
  if (expected.date !== actual.date && !(delimited && !expected.date)) return false;
  if (valuesEqual(expected.v, actual.v)) return true;
  if (delimited && typeof expected.v === 'string' && typeof actual.v === 'number') {
    return PLAIN_NUMBER_TEXT.test(expected.v) && Math.abs(Number(expected.v) - actual.v) < 1e-9;
  }
  return false;
}

function rowToPayloadCells(row: (RawCell | null)[] | undefined, count: number, date1904 = false): PayloadCell[] {
  const out: PayloadCell[] = [];
  for (let c = 0; c < count; c++) out.push(toExpectedCell(row?.[c], date1904));
  return out;
}

/** A row's cells masked like the samples' cells of their columns (`types`: their classes, `classify.ts`). */
function maskCells(cells: PayloadCell[], types: readonly ColumnClass[], masker: Masker | undefined): PayloadCell[] {
  if (!masker) return cells;
  return cells.map((v, i) => masker.maskCell(v, types[i] ?? 'text'));
}

/** One output cell's value, masked like the samples' cells of that column (the rules' own value too: it is made from real words). */
function maskOutputCell(v: PayloadCell, column: number, types: readonly ColumnClass[], masker: Masker | undefined): PayloadCell {
  return masker ? masker.maskCell(v, types[column] ?? 'text') : v;
}

// ---------------------------------------------------------------------------
// File spec comparison (SPEC 8.13 defaults, applied on both sides before comparing).
// ---------------------------------------------------------------------------

interface NormalizedFileSpec {
  type: 'xlsx' | 'csv' | 'txt';
  delimiter?: string;
  header?: boolean;
  encoding?: string;
  quote?: string;
}

function normalizeFileSpec(f: { type: 'xlsx' | 'csv' | 'txt'; delimiter?: string; header?: boolean; encoding?: string; quote?: string }): NormalizedFileSpec {
  if (f.type === 'xlsx') return { type: 'xlsx' };
  return {
    type: f.type,
    delimiter: f.delimiter ?? (f.type === 'txt' ? '\t' : ','),
    header: f.header ?? true,
    encoding: f.encoding ?? 'utf8bom',
    quote: f.quote ?? 'minimal',
  };
}

function fileSpecEqual(a: NormalizedFileSpec, b: NormalizedFileSpec): boolean {
  return a.type === b.type && a.delimiter === b.delimiter && a.header === b.header && a.encoding === b.encoding && a.quote === b.quote;
}

// ---------------------------------------------------------------------------
// Layout rows (everything that isn't a data row): positional comparison.
// ---------------------------------------------------------------------------

type LayoutCategory = 'title' | 'header' | 'blank' | 'summary';

function expectedCategory(kind: OutputRowKind): LayoutCategory | 'data' {
  switch (kind) {
    case 'title':
      return 'title';
    case 'header':
      return 'header';
    case 'blank':
      return 'blank';
    case 'summaryGroup':
    case 'summaryEnd':
      return 'summary';
    case 'data':
      return 'data';
  }
}

function actualCategory(kind: OutRowKind): LayoutCategory | 'data' {
  switch (kind) {
    case 'title':
      return 'title';
    case 'header':
      return 'header';
    case 'blank':
      return 'blank';
    case 'subtotal':
    case 'grandTotal':
    case 'summaryRow':
      return 'summary';
    case 'data':
      return 'data';
  }
}

interface LayoutIssue {
  code: LayoutProblemCode;
  /** For the UI: real values. */
  message: string;
  /** For the repair call (`repairProblems`): the same sentence with every value masked like the payload's (see `layoutValue`). */
  repair: string;
}

const LAYOUT_CODE: Record<LayoutCategory, LayoutProblemCode> = { title: 'titleRow', header: 'headerRow', blank: 'blankRow', summary: 'summaryRow' };

/**
 * A layout cell's value as a repair problem may quote it (SPEC 7.2/9.3): with a masker, text is masked the way the payload masks the same
 * rows' text (`maskText`: a title, a summary-row label - label words stay real), a header the example has stays real (headers are sent
 * real), and numbers, booleans and real dates are sent real as everywhere. `undefined`: a value that cannot be masked, which the message
 * then leaves out (it says only where the difference is).
 */
function layoutValue(seen: Seen, masker: Masker | undefined, headers: ReadonlySet<string> | null, cls?: ColumnClass): string | undefined {
  const v = seen.v;
  // A number in an identifier column (amendment 2026-10-06: the first or last ID of a group, in a summary row) is masked like its cells.
  if (masker && typeof v === 'number' && cls === 'identifier' && !seen.date) return JSON.stringify(masker.maskCell(v, cls));
  if (!masker || v === null || typeof v === 'number' || typeof v === 'boolean' || seen.date) return JSON.stringify(v);
  if (typeof v !== 'string') return undefined;
  return JSON.stringify(headers?.has(v) ? v : masker.maskText(v));
}

function compareLayoutRows(analysis: PairAnalysis, actualRows: readonly OutRow[], masker?: Masker): LayoutIssue[] {
  const delimited = analysis.layout.file.type !== 'xlsx';
  // SPEC 8.13: a headerless output has no header row in the real file (rowKinds never
  // marks one), but the engine's own OutputSheet model always carries one structurally
  // (buildSheet writes it unconditionally - only the file WRITER skips it for
  // `file.header: false`). Comparing it here would always flag a header the example
  // "doesn't have", so it's excluded from both sides for a headerless output.
  const headerless = analysis.output.headerless;
  const expected = analysis.output.rowKinds
    .map((kind, sheetRow) => ({ category: expectedCategory(kind), sheetRow }))
    .filter((r): r is { category: LayoutCategory; sheetRow: number } => r.category !== 'data' && !(headerless && r.category === 'header'));
  const actual = actualRows
    .map((row) => ({ category: actualCategory(row.kind), row }))
    .filter((r): r is { category: LayoutCategory; row: OutRow } => r.category !== 'data' && !(headerless && r.category === 'header'));

  const issues: LayoutIssue[] = [];
  const plain = (code: LayoutProblemCode, message: string): void => void issues.push({ code, message, repair: message });
  const knownHeaders = new Set(analysis.output.headers);
  const outTypes = masker ? classifyColumns(analysis).output : [];
  const len = Math.max(expected.length, actual.length);
  for (let i = 0; i < len; i++) {
    const exp = expected[i];
    const act = actual[i];
    if (!exp) {
      plain(LAYOUT_CODE[act!.category], `the rules produce an extra ${act!.category} row the example output doesn't have`);
      continue;
    }
    if (!act) {
      plain(LAYOUT_CODE[exp.category], `the example output has a ${exp.category} row (row ${exp.sheetRow + 1}) the rules don't produce`);
      continue;
    }
    if (exp.category !== act.category) {
      plain(LAYOUT_CODE[exp.category], `row ${exp.sheetRow + 1}: expected a ${exp.category} row, the rules produce a ${act.category} row`);
      continue;
    }
    if (exp.category === 'blank') continue;
    const expectedRow = analysis.output.sheet.rows[exp.sheetRow] ?? [];
    const width = Math.max(expectedRow.length, act.row.cells.length);
    const headers = exp.category === 'header' ? knownHeaders : null;
    for (let c = 0; c < width; c++) {
      const expectedVal = expectedSeen(expectedRow[c]);
      const actualVal = actualSeen(act.row.cells[c]);
      if (!cellsMatch(expectedVal, actualVal, delimited)) {
        const where = `${exp.category} row (row ${exp.sheetRow + 1}), column ${c + 1}`;
        const maskType = exp.category === 'summary' ? outTypes[c] : undefined;
        const [e, a] = [layoutValue(expectedVal, masker, headers, maskType), layoutValue(actualVal, masker, headers, maskType)];
        issues.push({
          code: LAYOUT_CODE[exp.category],
          message: `${where}: expected ${JSON.stringify(expectedVal.v)}, the rules produce ${JSON.stringify(actualVal.v)}`,
          repair: e !== undefined && a !== undefined ? `${where}: expected ${e}, the rules produce ${a}` : `${where}: the value differs from the example`,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Data rows: grouped by input row (SPEC 8.5 families and SPEC 8.6 summary groups
// share this uniformly, via `AlignedRow.in`), typed compare per cell.
// ---------------------------------------------------------------------------

function groupAlignmentByInputRow(analysis: PairAnalysis): { inRow: number; alignedIdx: number[] }[] {
  const order: number[] = [];
  const byIn = new Map<number, number[]>();
  analysis.alignment.rows.forEach((row, k) => {
    let arr = byIn.get(row.in);
    if (!arr) {
      arr = [];
      byIn.set(row.in, arr);
      order.push(row.in);
    }
    arr.push(k);
  });
  return order.map((inRow) => ({ inRow, alignedIdx: byIn.get(inRow)! }));
}

/** The example's input as the rules run on it. */
export function exampleTable(analysis: PairAnalysis): InputTable {
  return {
    sheetName: analysis.input.sheetName,
    direction: analysis.input.direction,
    headers: analysis.input.headers,
    rows: analysis.input.rows,
    rowNumbers: analysis.input.rowNumbers,
    ...(analysis.input.date1904 ? { date1904: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Row by row, for code that fills data parameters from the example (`fillParams.ts`): the same pairing and the same typed compare as the
// full verification below, one cell at a time.
// ---------------------------------------------------------------------------

/**
 * For each aligned row of the example (`analysis.alignment.rows[k]`), the data row the rules made for it, or null: an input row's rows, in
 * order, against the example rows aligned with it - the pairing `verifyAgainstExample` compares.
 */
export function alignedActualRows(analysis: PairAnalysis, sheetRows: readonly OutRow[]): (OutRow | null)[] {
  const byRowNumber = new Map<number, OutRow[]>();
  for (const row of sheetRows) {
    if (row.kind !== 'data' || row.sourceRow === undefined) continue;
    const list = byRowNumber.get(row.sourceRow);
    if (list) list.push(row);
    else byRowNumber.set(row.sourceRow, [row]);
  }
  const out: (OutRow | null)[] = new Array<OutRow | null>(analysis.alignment.rows.length).fill(null);
  for (const { inRow, alignedIdx } of groupAlignmentByInputRow(analysis)) {
    const rowNumber = analysis.input.rowNumbers[inRow];
    const made = rowNumber !== undefined ? (byRowNumber.get(rowNumber) ?? []) : [];
    alignedIdx.forEach((k, r) => {
      out[k] = made[r] ?? null;
    });
  }
  return out;
}

/** The example's cell at aligned row `k`, output column `c`, as the check reads it (a real date as ISO text, with `date` set). */
export function exampleCellAt(analysis: PairAnalysis, k: number, c: number): { v: PayloadCell; date: boolean } {
  const sheetRow = analysis.output.dataRows[analysis.alignment.rows[k]?.out ?? -1];
  return expectedSeen(sheetRow === undefined ? undefined : analysis.output.sheet.rows[sheetRow]?.[c]);
}

/** Whether the rules' cell matches the example's at aligned row `k`, column `c` (the typed compare of the full verification). */
export function cellMatchesExample(analysis: PairAnalysis, k: number, c: number, actual: OutCell | undefined): boolean {
  return cellsMatch(exampleCellAt(analysis, k, c), actualSeen(actual), analysis.layout.file.type !== 'xlsx');
}

export function verifyAgainstExample(rules: LearnResult | Rules, analysis: PairAnalysis, opts: VerifyOptions = {}): VerifyResult {
  const exceptions = new Set(opts.exceptions ?? []);
  const oneTimeCells = opts.oneTime ? new Set(opts.oneTime.map((c) => `${c.exampleRow}\u0000${c.column}`)) : null;
  const oneTime: Mismatch[] = [];
  const masker = opts.masker;
  const only = opts.onlyColumns !== undefined ? new Set(opts.onlyColumns) : null;

  const result = runRules(rules, exampleTable(analysis), {});

  if (!result.ok) {
    const missing = result.error.missing ?? [];
    const message =
      result.error.code === 'missingRequiredColumns' ? `required input column(s) not found: ${missing.join(', ')}` : `rules could not run on the input (${result.error.code})`;
    // (For the repair call, a header the input does not have is a name the answer wrote - unmasked here, so it is masked back.)
    const inputHeaders = new Set(analysis.input.headers);
    const sendable = masker ? `required input column(s) not found: ${missing.map((h) => (inputHeaders.has(h) ? h : masker.maskText(h))).join(', ')}` : message;
    const repairProblems: RepairProblem[] =
      result.error.code === 'missingRequiredColumns' ? [{ kind: 'reference', message: sendable }] : [{ kind: 'schema', path: 'input', message }];
    return { verified: false, matched: 0, total: 0, mismatches: [], layoutProblems: [message], layoutIssues: [{ code: 'runFailed', message }], repairProblems, ...(opts.wrongRows ? { wrongRows: [] } : {}) };
  }

  if (only !== null && only.size === 0) {
    return { verified: false, matched: 0, total: 0, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [], ...(opts.wrongRows ? { wrongRows: [] } : {}) };
  }

  const repairProblems: RepairProblem[] = [];
  let diffCount = 0;
  // (Built only when kept: masking every wrong row's cells to keep 10 took 30 s on a 15,000-row file - engine stress test, STRESS.md.)
  const pushDiff = (build: () => Extract<RepairProblem, { kind: 'diff' }>): boolean => {
    if (diffCount >= MAX_DIFF_PROBLEMS) return false;
    repairProblems.push(build());
    diffCount++;
    return true;
  };

  const delimited = analysis.layout.file.type !== 'xlsx';
  const mismatches: Mismatch[] = [];
  let matched = 0;
  let total = 0;

  const dataRowsActual = result.sheet.rows.filter(
    (r): r is OutRow & { sourceRow: number } => r.kind === 'data' && r.sourceRow !== undefined,
  );
  const byRowNumber = new Map<number, OutRow[]>();
  for (const row of dataRowsActual) {
    const list = byRowNumber.get(row.sourceRow);
    if (list) list.push(row);
    else byRowNumber.set(row.sourceRow, [row]);
  }

  const inputCellsFor = (inRow: number): PayloadCell[] => rowToPayloadCells(analysis.input.rows[inRow], analysis.input.columnCount, analysis.input.date1904);
  // Each column's class in a repair problem: the same as in the payload's samples (`classify.ts`).
  const types: { input: readonly ColumnClass[]; output: readonly ColumnClass[] } = masker ? classifyColumns(analysis) : { input: [], output: [] };
  // The learning loop's wrong rows (only when asked for), one per input row, in file order.
  const wrongRows: WrongRow[] | undefined = opts.wrongRows ? [] : undefined;
  const wrongRowOf = (inRow: number, current: WrongRow | null): WrongRow | null => {
    if (!wrongRows) return null;
    if (current) return current;
    const row: WrongRow = { inRow, cells: [], extra: [] };
    wrongRows.push(row);
    return row;
  };

  for (const { inRow, alignedIdx } of groupAlignmentByInputRow(analysis)) {
    const rowNumber = analysis.input.rowNumbers[inRow];
    const actualGroup = rowNumber !== undefined ? (byRowNumber.get(rowNumber) ?? []) : [];
    const groupLen = Math.max(alignedIdx.length, actualGroup.length);
    let wrong: WrongRow | null = null;

    for (let r = 0; r < groupLen; r++) {
      const k = alignedIdx[r];
      const actualRow = actualGroup[r];

      if (k === undefined) {
        // The engine produced more rows for this input row than the example has. (`row.out` is the example's row - there is none - and
        // what the rules made is `made`: prompt audit X1.)
        const actualCells = actualRow!.cells.map(actualCellValue);
        wrong = wrongRowOf(inRow, wrong);
        wrong?.extra.push(actualCells);
        pushDiff(() => ({
          kind: 'diff',
          out: 0,
          row: { in: maskCells(inputCellsFor(inRow), types.input, masker), out: [] },
          made: maskCells(actualCells, types.output, masker),
          expected: null,
          actual: maskOutputCell(actualCells[0] ?? null, 0, types.output, masker),
        }));
        continue;
      }

      const outIdx = analysis.alignment.rows[k]!.out;
      const sheetRow = analysis.output.dataRows[outIdx];
      if (sheetRow === undefined) continue;
      const exampleRow = sheetRow + 1;
      if (exceptions.has(exampleRow)) continue;

      const expectedRaw = analysis.output.sheet.rows[sheetRow];
      const expectedCells = rowToPayloadCells(expectedRaw, analysis.output.columnCount);
      total++;
      let rowOk = true;
      for (let c = 0; c < analysis.output.columnCount; c++) {
        if (only !== null && !only.has(c)) continue;
        const expected = expectedCells[c] ?? null;
        const actual = actualCellValue(actualRow?.cells[c]);
        if (!cellsMatch(expectedSeen(expectedRaw?.[c]), actualSeen(actualRow?.cells[c]), delimited)) {
          const header = rules.output.columns[c]?.header ?? analysis.output.headers[c] ?? `column${c + 1}`;
          if (oneTimeCells?.has(`${exampleRow}\u0000${header}`)) {
            oneTime.push({ exampleRow, column: header, expected, actual });
            continue;
          }
          rowOk = false;
          mismatches.push({ exampleRow, column: header, expected, actual });
          wrong = wrongRowOf(inRow, wrong);
          wrong?.cells.push({ out: c, outRow: outIdx, expected, actual });
          pushDiff(() => ({
            kind: 'diff',
            out: c,
            row: { in: maskCells(inputCellsFor(inRow), types.input, masker), out: maskCells(expectedCells, types.output, masker) },
            expected: maskOutputCell(expected, c, types.output, masker),
            actual: maskOutputCell(actual, c, types.output, masker),
          }));
        }
      }
      if (rowOk) matched++;
    }
  }

  // Input rows the example dropped entirely must still produce nothing.
  for (const inRow of analysis.alignment.droppedIn) {
    const rowNumber = analysis.input.rowNumbers[inRow];
    const actualRows = rowNumber !== undefined ? (byRowNumber.get(rowNumber) ?? []) : [];
    let wrong: WrongRow | null = null;
    for (const actualRow of actualRows) {
      const actualCells = actualRow.cells.map(actualCellValue);
      wrong = wrongRowOf(inRow, wrong);
      wrong?.extra.push(actualCells);
      pushDiff(() => ({
        kind: 'diff',
        out: 0,
        row: { in: maskCells(inputCellsFor(inRow), types.input, masker), out: [] },
        made: maskCells(actualCells, types.output, masker),
        expected: null,
        actual: maskOutputCell(actualCells[0] ?? null, 0, types.output, masker),
      }));
    }
  }

  const layoutIssues: LayoutProblem[] = [];

  if (analysis.alignment.unalignedOut.length > 0) {
    layoutIssues.push({
      code: 'unalignedRows',
      message: `${analysis.alignment.unalignedOut.length} row(s) in the example output could not be matched to an input row and were not verified`,
    });
  }

  const expectedDataTotal = analysis.output.dataRows.length;
  const actualDataTotal = dataRowsActual.length;
  if (only === null && expectedDataTotal !== actualDataTotal) {
    repairProblems.push({ kind: 'rowCount', expected: expectedDataTotal, actual: actualDataTotal });
    layoutIssues.push({ code: 'rowCount', message: `expected ${expectedDataTotal} data row(s) in the example output, the rules produce ${actualDataTotal}` });
  }

  // ---- layout: file type ----
  const expectedFile: OutputFileSpec = analysis.layout.file;
  const declaredFile = rules.output.file ?? DEFAULT_OUTPUT_FILE;
  if (!fileSpecEqual(normalizeFileSpec(declaredFile), normalizeFileSpec(expectedFile))) {
    const message = `output file settings do not match the example (expected ${JSON.stringify(expectedFile)}, rules declare ${JSON.stringify(declaredFile)})`;
    layoutIssues.push({ code: 'fileSettings', message });
    repairProblems.push({ kind: 'layout', message });
  }

  // ---- layout: titles, header, summary rows, blank rows ----
  for (const issue of only === null ? compareLayoutRows(analysis, result.sheet.rows, masker) : []) {
    layoutIssues.push({ code: issue.code, message: issue.message });
    repairProblems.push({ kind: 'layout', message: issue.repair });
  }

  const layoutProblems = layoutIssues.map((i) => i.message);
  const verified = layoutProblems.length === 0 && repairProblems.length === 0 && matched === total;

  return {
    verified,
    matched,
    total,
    mismatches,
    layoutProblems,
    layoutIssues,
    repairProblems,
    ...(wrongRows ? { wrongRows: wrongRows.sort((a, b) => a.inRow - b.inRow) } : {}),
    ...(oneTimeCells ? { oneTime } : {}),
  };
}
