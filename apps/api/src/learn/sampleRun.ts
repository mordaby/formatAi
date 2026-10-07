// SPEC 9.2 layer 7 "Run on the samples": rebuild a minimal InputTable from the
// payload's samples and dropped rows (the API never sees the real file - that's the
// browser's job, SPEC 5 A step 6, the hold-out test since the LLM only saw up to 12
// rows), run the candidate rules through the deterministic engine, and diff the result
// against what the payload says each sample should produce.
import { actualSeen, cellsMatch, columnsReportedUnsupported, formatYmd, runRules, serialToYmd, ymdToSerial } from '@formatai/engine';
import type { InputTable, OutCell, OutRow } from '@formatai/engine';
import type {
  LearnPayload,
  LearnResult,
  PayloadCell,
  PayloadColumn,
  RepairProblem,
  Rules,
  Sample,
} from '@formatai/shared';

/** LEARN_PROMPT §4: "At most 10 diff problems are sent." Enforced here, at the
 * source - `sampleRun` is the only layer that ever produces `diff`/`rowCount`
 * problems (SPEC 9.2 layer 7). */
const MAX_DIFF_PROBLEMS = 10;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoToSerial(iso: string): number | null {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return null;
  return ymdToSerial({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
}

function serialToIso(serial: number): string {
  return formatYmd(serialToYmd(serial), 'YYYY-MM-DD', 'en');
}

/**
 * One payload cell -> one raw input cell, reconstructed the way the real file would
 * have produced it (SPEC 7, LEARN_PROMPT §3's `PayloadCell`: "real Excel dates are
 * ISO YYYY-MM-DD strings; text dates stay as written").
 *
 * A date column whose stats say the underlying storage is a plain Excel serial number
 * (`stats.serialDates`) gets its ISO string turned back into a serial number with
 * `isDate: true`. That bypasses `inputFormats` matching entirely and is the most
 * robust reconstruction: LEARN_PROMPT tells the LLM to declare
 * `inputFormats: ["excelSerial"]` for such a column, but "excelSerial" only matches a
 * bare number (`PLAIN_NUMBER_RE`), never a dashed ISO string, so feeding the ISO text
 * as-is would wrongly fail to parse. A genuine Excel date cell is read via `isDate`
 * before `inputFormats` is even consulted (`normalizeCell`), so this mirrors it
 * exactly. Every other date column's ISO string is left as plain text instead: the
 * engine's default date formats include "YYYY-MM-DD", so it parses correctly whether
 * or not the LLM's declared `inputFormats` happens to repeat it. Numbers and booleans
 * pass through as-is; any other string passes through as plain text.
 */
function toRawCell(
  value: PayloadCell,
  col: PayloadColumn | undefined,
): { v: string | number | boolean | null; isDate?: boolean } | null {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return { v: value };
  if (col?.type === 'date' && col.stats?.serialDates === true) {
    const serial = isoToSerial(value);
    if (serial !== null) return { v: serial, isDate: true };
  }
  return { v: value };
}

/**
 * Rebuilds a minimal `InputTable` from the payload: the input columns the payload lists, in column-position order
 * (`payload.input.columns[].i`), one row per sample (`in`, in sample order) followed by one row per dropped row - each
 * cell read at its column's position. Row numbers are assigned 1-based in that same order, purely so the engine's
 * `OutRow.sourceRow` (shared by every row an expand family produces) can be matched back to the sample/dropped row it
 * came from once the rules have run.
 *
 * DECISION (API audit C3, 2026-10-07): the table has exactly the listed columns - never one column per position up to
 * the largest `i`. The rules find their columns by header (`mapHeaders`), so a position nobody lists (an empty header
 * that could match nothing) adds nothing, and one large `i` (the schema caps it at Excel's last column too) can no
 * longer make the table millions of cells wide.
 */
export function buildSampleInputTable(payload: LearnPayload): InputTable {
  const columns: PayloadColumn[] = [...payload.input.columns].sort((a, b) => a.i - b.i);
  const headers = columns.map((c) => c.header);

  const inputRows: PayloadCell[][] = [...payload.samples.map((s) => s.in), ...(payload.dropped ?? [])];

  const rows = inputRows.map((cells) => columns.map((c) => toRawCell(cells[c.i] ?? null, c)));
  const rowNumbers = inputRows.map((_, i) => i + 1);

  return {
    sheetName: 'sample',
    direction: payload.input.direction,
    headers,
    rows,
    rowNumbers,
  };
}

// ---------- Typed comparison (SPEC 9.2 layer 7: "compare typed") ----------

/**
 * API audit P1 (2026-10-07): the browser's own typed compare (engine `cellsMatch`, the full verification's), so the sample run never calls a
 * cell wrong that the browser calls right. It used to compare strictly (`actual.v === expected`): a csv / txt example's "12.50" - text, as
 * every delimited cell is - against the 12.5 the rules make was a `diff`, and a correct price rule failed on the server.
 *
 * The payload's cells are what the example holds: numbers as numbers, text as text, and a real Excel date as ISO "YYYY-MM-DD" text. So an
 * expected cell is compared as text first; in a workbook, ISO-shaped text is compared as a date too (the payload cannot say which it was -
 * the old compare accepted both as well). In a delimited output every cell is text, and a date the rules make is compared by the text the
 * writer writes for it.
 */
function cellsEqual(expected: PayloadCell, actual: OutCell | undefined, delimited: boolean): boolean {
  const made = actualSeen(actual);
  if (cellsMatch({ v: expected, date: false }, made, delimited)) return true;
  return !delimited && typeof expected === 'string' && ISO_DATE_RE.test(expected) && cellsMatch({ v: expected, date: true }, made, delimited);
}

function actualCellValue(actual: OutCell | undefined): PayloadCell {
  if (actual === undefined) return null;
  if (actual.isDate === true && typeof actual.v === 'number') return serialToIso(actual.v);
  return actual.v;
}

/** A `Sample` is a family (`out: PayloadCell[][]`) when its `out` is empty (an
 * all-skipped expand family produces zero rows) or its first element is itself an
 * array; otherwise `out` is one row (`PayloadCell[]`). */
function familyRows(sample: Sample): PayloadCell[][] {
  const out = sample.out;
  if (out.length === 0 || Array.isArray(out[0])) return out as PayloadCell[][];
  return [out as PayloadCell[]];
}

function isFamilySample(sample: Sample): boolean {
  return Array.isArray(sample.out) && (sample.out.length === 0 || Array.isArray(sample.out[0]));
}

// ---------- Diffing ----------

interface DiffCtx {
  problems: RepairProblem[];
  diffCount: number;
  /** The example output is a csv / txt file (its cells are text): see `cellsEqual`. */
  delimited: boolean;
}

/** Returns false once the cap (`MAX_DIFF_PROBLEMS`) is reached, so callers can stop
 * doing further comparison work for this run. */
function pushDiff(ctx: DiffCtx, problem: Extract<RepairProblem, { kind: 'diff' }>): boolean {
  if (ctx.diffCount >= MAX_DIFF_PROBLEMS) return false;
  ctx.problems.push(problem);
  ctx.diffCount++;
  return true;
}

function compareRow(
  ctx: DiffCtx,
  expectedRow: PayloadCell[],
  actualRow: OutRow | undefined,
  sample: number,
  familyRow: number | undefined,
  ignore: ReadonlySet<number>,
): boolean {
  for (let out = 0; out < expectedRow.length; out++) {
    if (ignore.has(out)) continue;
    const expected = expectedRow[out] ?? null;
    const actualCell = actualRow?.cells[out];
    if (cellsEqual(expected, actualCell, ctx.delimited)) continue;
    const problem: Extract<RepairProblem, { kind: 'diff' }> = {
      kind: 'diff',
      out,
      sample,
      expected,
      actual: actualCellValue(actualCell),
    };
    if (familyRow !== undefined) problem.familyRow = familyRow;
    if (!pushDiff(ctx, problem)) return false;
  }
  return true;
}

/** Whether `v` (an expression tree, or anything inside one) holds an across-row (window) function call. */
function hasWindowCall(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasWindowCall);
  if (typeof v !== 'object' || v === null) return false;
  if ((v as { op?: unknown }).op === 'window') return true;
  return Object.values(v).some(hasWindowCall);
}

/** Whether `v` (an expression tree) reads one of the column ids in `ids`. */
function readsColumnOf(v: unknown, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  if (Array.isArray(v)) return v.some((x) => readsColumnOf(x, ids));
  if (typeof v !== 'object' || v === null) return false;
  const col = (v as { col?: unknown }).col;
  if (typeof col === 'string' && ids.has(col)) return true;
  return Object.values(v).some((x) => readsColumnOf(x, ids));
}

/**
 * The output columns whose value depends on rows other than the one they are written for, so they cannot be checked on the sample table:
 *   - a summary output (`group.showDetailRows: false`, SPEC 8.6): every column with an `agg` other than `first` (a sum, count, average, min,
 *     max or last over the group). The samples hold ONE input row per group - the group's first row - so such a column over the sample table
 *     is the first row's own value, never the group's total; the correct rules would "differ" on every sample, and the repair call would be
 *     pushed away from them. (`first` is the first row's value: it is compared.)
 *   - a column read from a computed column that uses a window function (`runningSum`, `groupSum`, `previous`, `rank` ...), directly or through
 *     another computed column: over the sample rows only, a running total, a group total or a rank is not the one over the file.
 * The browser's full verification compares all of them on every row of the real example (SPEC 9.2 layer 8).
 */
function columnsReadingOtherRows(rules: LearnResult | Rules): number[] {
  const crossRow = new Set<string>();
  for (const c of rules.transform.computed) {
    if (hasWindowCall(c.expr) || readsColumnOf(c.expr, crossRow)) crossRow.add(c.id);
  }
  const summaryOutput = rules.transform.group !== undefined && !rules.transform.group.showDetailRows;
  const out: number[] = [];
  rules.output.columns.forEach((col, i) => {
    if (col.from === null) return;
    if (crossRow.has(col.from) || (summaryOutput && (col.agg ?? 'first') !== 'first')) out.push(i);
  });
  return out;
}

/**
 * The output columns that are not compared with the samples.
 *
 * Plain learn: a column the answer honestly reports as unsupported (`from: null` AND an `unsupported` entry, any reason code - typically
 * `externalData`: its values are not in the input) is left empty on purpose, so it is never a diff: SPEC 4/8.10, a partial, correct rules
 * file beats a complete, wrong one, and "needs your input" is not an error. Every other column is compared, as it always was - a `from: null`
 * column WITHOUT an entry never gets here (layer 2 rejects it), and a column with a `from` is compared even if the answer also lists it.
 * (That the answer produced SOMETHING is `runChecks`' business, not a comparison.)
 *
 * Completion mode: the AI step is answerable for the columns it was asked to produce (`complete.columns`) and nothing else: the other
 * columns are the user's own rules (checked against the whole example in the browser, and kept by the fixed lock - they may depart from
 * the example on purpose), and a listed column the answer reports as unsupported is left empty on purpose (that the answer produced anything
 * at all is the fixed lock's business).
 */
function columnsNotCompared(rules: LearnResult | Rules, payload: LearnPayload): ReadonlySet<number> {
  // (Both modes: a column that reads other rows is checked on the whole file by the browser, never on the samples - see its own doc.)
  const ignore = new Set<number>(columnsReadingOtherRows(rules));
  if (!payload.complete) {
    for (const i of columnsReportedUnsupported(rules)) ignore.add(i);
    return ignore;
  }
  const produced = new Set(payload.complete.columns.filter((i) => rules.output.columns[i]?.from != null));
  for (let i = 0; i < payload.output.columns.length; i++) if (!produced.has(i)) ignore.add(i);
  return ignore;
}

/**
 * SPEC 9.2 layer 7: runs `rules` on the payload's samples and dropped rows, and diffs
 * the result. Each sample's expected output row(s) - a family: all rows, in order -
 * must appear for its input row; a dropped row must produce none. At most
 * `MAX_DIFF_PROBLEMS` `diff` problems are returned; a mismatched total row count
 * across every sample and dropped row is reported once, as a single `rowCount`
 * problem, in addition to (not instead of) any `diff` problems.
 */
export function runOnSamples(rules: LearnResult | Rules, payload: LearnPayload): RepairProblem[] {
  const ignore = columnsNotCompared(rules, payload);
  const table = buildSampleInputTable(payload);
  const result = runRules(rules, table, {});
  const ctx: DiffCtx = { problems: [], diffCount: 0, delimited: payload.output.file.type !== 'xlsx' };

  if (!result.ok) {
    if (result.error.code === 'missingRequiredColumns') {
      const missing = result.error.missing ?? [];
      ctx.problems.push({
        kind: 'reference',
        message: `required input column(s) not found in the payload: ${missing.join(', ')}`,
      });
    } else {
      ctx.problems.push({
        kind: 'schema',
        path: 'input',
        message: `rules could not run on the samples (${result.error.code})`,
      });
    }
    return ctx.problems;
  }

  const dataRows = result.sheet.rows.filter((r): r is OutRow & { sourceRow: number } => r.kind === 'data' && r.sourceRow !== undefined);
  const byRowNumber = new Map<number, OutRow[]>();
  for (const row of dataRows) {
    const list = byRowNumber.get(row.sourceRow);
    if (list) list.push(row);
    else byRowNumber.set(row.sourceRow, [row]);
  }

  let expectedTotal = 0;
  let stop = false;
  payload.samples.forEach((sample, i) => {
    if (stop) return;
    const rowNumber = i + 1;
    const actualRows = byRowNumber.get(rowNumber) ?? [];
    const family = isFamilySample(sample);
    const expectedRows = familyRows(sample);
    expectedTotal += expectedRows.length;

    for (let r = 0; r < expectedRows.length; r++) {
      if (!compareRow(ctx, expectedRows[r]!, actualRows[r], i, family ? r : undefined, ignore)) {
        stop = true;
        return;
      }
    }
    // Extra actual rows beyond what this sample expected (e.g. a filter/expand bug
    // that produces too many rows for one input row). The row the rules made is `made`, like every row the example does not have
    // (prompt audit X1); a loop round's row named here gets `row.out: []` (`rowsNamed`, learn.ts).
    for (let r = expectedRows.length; r < actualRows.length; r++) {
      const extra = actualRows[r]!;
      if (
        !pushDiff(ctx, {
          kind: 'diff',
          out: 0,
          sample: i,
          ...(family ? { familyRow: r } : {}),
          made: extra.cells.map(actualCellValue),
          expected: null,
          actual: actualCellValue(extra.cells[0]),
        })
      ) {
        stop = true;
        return;
      }
    }
  });

  // Dropped rows must produce nothing at all. `row.out` is the example's output for the row - nothing - and the row the rules made is
  // `made` (prompt audit X1: `row.out` used to carry the made row here, the example's row everywhere else).
  const dropped = payload.dropped ?? [];
  dropped.forEach((droppedRow, j) => {
    if (stop) return;
    const rowNumber = payload.samples.length + j + 1;
    const actualRows = byRowNumber.get(rowNumber) ?? [];
    for (const actual of actualRows) {
      if (
        !pushDiff(ctx, {
          kind: 'diff',
          out: 0,
          row: { in: droppedRow, out: [] },
          made: actual.cells.map(actualCellValue),
          expected: null,
          actual: actualCellValue(actual.cells[0]),
        })
      ) {
        stop = true;
        return;
      }
    }
  });

  // (Not once the diff cap stopped the walk: `expectedTotal` only counts the samples reached, so the two numbers would not be comparable.)
  if (!stop && expectedTotal !== dataRows.length) {
    ctx.problems.push({ kind: 'rowCount', expected: expectedTotal, actual: dataRows.length });
  }

  return ctx.problems;
}
