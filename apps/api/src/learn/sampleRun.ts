// SPEC 9.2 layer 7 "Run on the samples": rebuild a minimal InputTable from the
// payload's samples and dropped rows (the API never sees the real file - that's the
// browser's job, SPEC 5 A step 6, the hold-out test since the LLM only saw up to 12
// rows), run the candidate rules through the deterministic engine, and diff the result
// against what the payload says each sample should produce.
import { formatYmd, runRules, serialToYmd, ymdToSerial } from '@formatai/engine';
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
 * Rebuilds a minimal `InputTable` from the payload: input headers in column-position
 * order (`payload.input.columns[].i`), one row per sample (`in`, in sample order)
 * followed by one row per dropped row. Row numbers are assigned 1-based in that same
 * order, purely so the engine's `OutRow.sourceRow` (shared by every row an expand
 * family produces) can be matched back to the sample/dropped row it came from once the
 * rules have run.
 */
export function buildSampleInputTable(payload: LearnPayload): InputTable {
  const columnsByPosition: (PayloadColumn | undefined)[] = [];
  for (const c of payload.input.columns) columnsByPosition[c.i] = c;
  const headers = columnsByPosition.map((c) => c?.header ?? '');

  const inputRows: PayloadCell[][] = [...payload.samples.map((s) => s.in), ...(payload.dropped ?? [])];

  const rows = inputRows.map((cells) => headers.map((_, i) => toRawCell(cells[i] ?? null, columnsByPosition[i])));
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

/** Numbers compare numerically with a small epsilon (a `decimal.js` value that
 * round-trips through `Number` for the engine's `OutCell.v` can drift in the last
 * bit), dates compare as ISO text, everything else compares exactly. */
function cellsEqual(expected: PayloadCell, actual: OutCell | undefined): boolean {
  if (actual === undefined) return expected === null;
  if (expected === null) return actual.v === null;
  if (actual.isDate === true && typeof actual.v === 'number') {
    return typeof expected === 'string' && serialToIso(actual.v) === expected;
  }
  if (typeof expected === 'number') {
    return typeof actual.v === 'number' && Math.abs(actual.v - expected) < 1e-9;
  }
  return actual.v === expected;
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
): boolean {
  for (let out = 0; out < expectedRow.length; out++) {
    const expected = expectedRow[out] ?? null;
    const actualCell = actualRow?.cells[out];
    if (cellsEqual(expected, actualCell)) continue;
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

/**
 * SPEC 9.2 layer 7: runs `rules` on the payload's samples and dropped rows, and diffs
 * the result. Each sample's expected output row(s) - a family: all rows, in order -
 * must appear for its input row; a dropped row must produce none. At most
 * `MAX_DIFF_PROBLEMS` `diff` problems are returned; a mismatched total row count
 * across every sample and dropped row is reported once, as a single `rowCount`
 * problem, in addition to (not instead of) any `diff` problems.
 */
export function runOnSamples(rules: LearnResult | Rules, payload: LearnPayload): RepairProblem[] {
  const table = buildSampleInputTable(payload);
  const result = runRules(rules, table, {});
  const ctx: DiffCtx = { problems: [], diffCount: 0 };

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
      if (!compareRow(ctx, expectedRows[r]!, actualRows[r], i, family ? r : undefined)) {
        stop = true;
        return;
      }
    }
    // Extra actual rows beyond what this sample expected (e.g. a filter/expand bug
    // that produces too many rows for one input row).
    for (let r = expectedRows.length; r < actualRows.length; r++) {
      const extra = actualRows[r]!;
      if (
        !pushDiff(ctx, {
          kind: 'diff',
          out: 0,
          sample: i,
          ...(family ? { familyRow: r } : {}),
          expected: null,
          actual: actualCellValue(extra.cells[0]),
        })
      ) {
        stop = true;
        return;
      }
    }
  });

  // Dropped rows must produce nothing at all.
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
          row: { in: droppedRow, out: actual.cells.map(actualCellValue) },
          actual: actualCellValue(actual.cells[0]),
        })
      ) {
        stop = true;
        return;
      }
    }
  });

  if (expectedTotal !== dataRows.length) {
    ctx.problems.push({ kind: 'rowCount', expected: expectedTotal, actual: dataRows.length });
  }

  return ctx.problems;
}
