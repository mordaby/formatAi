// The rules editor's two engine-side checks, run in the worker (SPEC 8.11 "Live check", 9.2 layers 1-5):
//
// - `checkExample`: runs the rules on the example kept in worker memory since the learn, and compares the
//   result with the example output (`verifyAgainstExample`). Returns counts, per-column counts, a preview
//   with mismatching rows first, and how long it took. Above `fullCheckAboveRows` example rows it runs on a
//   deterministic prefix subset and says so (`partial`); `subset: false` runs every row (Apply).
// - `staticChecks`: zod, checkRules, typeCheck, checkLimits and (inside a format) the format lock; and, for a conversion about to
//   join an existing source, the source lock (SPEC 8.15).
//
// Pure functions over a `PairAnalysis` and rules, so a Node test runs the same code the worker does.
import {
  checkFormatLock,
  checkLimits,
  checkSourceLock,
  typeCheck,
  verifyAgainstExample,
  type PairAnalysis,
  type VerifyResult,
} from '@formatai/engine';
import type { Format, LearnResult, PayloadCell, Rules, SourceStructure } from '@formatai/shared';
import { checkRules, LearnResultSchema, RulesSchema } from '@formatai/shared';
import { editorConfig } from '../editor/config';
import type { ExampleInputColumn } from '../editor/types';
import type { LiveCheckResult, PreviewRow, StaticCheckOptions, StaticProblem } from './editorApi';

// ---------- the example kept in worker memory ----------

/** Thrown (with `code: 'exampleGone'`) when the editor asks about an example the worker no longer holds. */
export class ExampleGoneError extends Error {
  readonly code = 'exampleGone';
  constructor() {
    super('The example is no longer in memory (the worker restarted). Load the example files again.');
    this.name = 'ExampleGoneError';
  }
}

let current: { id: string; analysis: PairAnalysis } | undefined;

/**
 * Keeps this example (only the last one) and returns its id. The id is random, so an id from before a worker
 * restart can never be mistaken for a newer example.
 */
export function rememberExample(analysis: PairAnalysis, keepId?: string): string {
  // `keepId`: a completion run re-reads the same two files, so the example it holds is the one the screen already checks against.
  const id = keepId ?? crypto.randomUUID();
  current = { id, analysis };
  return id;
}

/**
 * The example INPUT's columns for the rules editor's source dropdowns (SPEC 8.11): the header and what the profile knows
 * about the values (never the values). A column no rule declares yet can still be chosen.
 */
export function exampleInputOf(analysis: PairAnalysis): ExampleInputColumn[] {
  return analysis.input.profile.map((p) => ({
    header: p.header,
    type: p.type,
    ...(p.israeliId ? { israeliId: true } : {}),
    ...(p.leadingZerosLost ? { leadingZerosLost: true } : {}),
    ...(p.serialDates ? { serialDates: true } : {}),
    ...(p.len !== undefined ? { maxLength: p.len[1] } : {}),
    ...(p.dateFormat !== undefined ? { dateFormat: p.dateFormat } : {}),
  }));
}

export function getExample(id: string): PairAnalysis {
  if (!current || current.id !== id) throw new ExampleGoneError();
  return current.analysis;
}

/** For tests: forget the example. */
export function forgetExample(): void {
  current = undefined;
}

// ---------- the live check ----------

function exampleRowCount(a: PairAnalysis): number {
  return Math.max(a.input.rows.length, a.output.dataRows.length);
}

/**
 * The first `maxRows` input rows and the aligned example rows they explain. A contiguous prefix (not a random
 * sample) keeps what spans rows coherent: duplicates, expand families, and sort (which the comparison ignores,
 * since it groups by input row). Checks that need every row (titles, summary rows, the row count) are skipped.
 */
export function subsetAnalysis(a: PairAnalysis, maxRows: number): PairAnalysis {
  return {
    ...a,
    input: { ...a.input, rows: a.input.rows.slice(0, maxRows), rowNumbers: a.input.rowNumbers.slice(0, maxRows) },
    alignment: {
      ...a.alignment,
      rows: a.alignment.rows.filter((r) => r.in < maxRows),
      droppedIn: a.alignment.droppedIn.filter((i) => i < maxRows),
      unalignedOut: [],
    },
  };
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function cellValue(cell: { v: string | number | boolean | null; isDate?: boolean } | null | undefined, date1904 = false): PayloadCell {
  if (!cell || cell.v === null) return null;
  if (typeof cell.v === 'number' && cell.isDate) {
    const serial = Math.trunc(cell.v) + (date1904 ? 1462 : 0);
    return new Date(EXCEL_EPOCH + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return cell.v;
}

function runFailed(v: VerifyResult): boolean {
  return v.repairProblems.length > 0 && v.repairProblems.every((p) => p.kind === 'reference' || p.kind === 'schema');
}

/** The preview table: mismatching example rows first (in example order), then matching rows up to `limit`. */
function buildPreview(a: PairAnalysis, rules: LearnResult | Rules, v: VerifyResult, exceptions: ReadonlySet<number>, limit: number): PreviewRow[] {
  const headers = new Map<string, number>();
  const width = Math.max(rules.output.columns.length, a.output.columnCount);
  for (let c = 0; c < width; c++) {
    const h = rules.output.columns[c]?.header ?? a.output.headers[c] ?? `column${c + 1}`;
    if (!headers.has(h)) headers.set(h, c);
  }
  const bad = new Map<number, typeof v.mismatches>();
  for (const m of v.mismatches) {
    const list = bad.get(m.exampleRow);
    if (list) list.push(m);
    else bad.set(m.exampleRow, [m]);
  }

  const byRow = new Map<number, number>(); // example row -> input row index
  for (const r of a.alignment.rows) {
    const sheetRow = a.output.dataRows[r.out];
    if (sheetRow !== undefined) byRow.set(sheetRow + 1, r.in);
  }

  const make = (exampleRow: number): PreviewRow => {
    const sheetRow = exampleRow - 1;
    const expected: PayloadCell[] = [];
    for (let c = 0; c < a.output.columnCount; c++) expected.push(cellValue(a.output.sheet.rows[sheetRow]?.[c]));
    const actual = [...expected];
    const badColumns: number[] = [];
    for (const m of bad.get(exampleRow) ?? []) {
      const c = headers.get(m.column);
      if (c === undefined) continue;
      actual[c] = m.actual;
      badColumns.push(c);
    }
    const inRow = byRow.get(exampleRow);
    return {
      exampleRow,
      ...(inRow !== undefined ? { inputRow: a.input.rowNumbers[inRow] ?? inRow + 1 } : {}),
      ok: badColumns.length === 0,
      source: inRow !== undefined ? (a.input.rows[inRow] ?? []).map((cell) => cellValue(cell, a.input.date1904)) : [],
      expected,
      actual,
      badColumns: badColumns.sort((x, y) => x - y),
    };
  };

  const rows: PreviewRow[] = [];
  for (const exampleRow of [...bad.keys()].sort((x, y) => x - y)) {
    if (rows.length >= limit) return rows;
    rows.push(make(exampleRow));
  }
  for (const r of a.alignment.rows) {
    if (rows.length >= limit) break;
    const sheetRow = a.output.dataRows[r.out];
    if (sheetRow === undefined) continue;
    const exampleRow = sheetRow + 1;
    if (exceptions.has(exampleRow) || bad.has(exampleRow)) continue;
    rows.push(make(exampleRow));
  }
  return rows;
}

export interface CheckExampleOptions {
  /** 1-based rows of the example output marked "fixed by hand": left out of every count. */
  exceptions?: number[];
  /** Allow the subset above `fullCheckAboveRows` rows (default true). `false` checks every row. */
  subset?: boolean;
  /** SPEC 21 v5 item 1: the local partial result compares only the columns code built (0-based positions in `rules.output.columns`). */
  onlyColumns?: number[];
}

export function checkExample(analysis: PairAnalysis, rules: LearnResult | Rules, opts: CheckExampleOptions = {}): LiveCheckResult {
  const started = performance.now();
  const exceptions = opts.exceptions ?? [];
  const rowsInExample = exampleRowCount(analysis);
  const partial = opts.subset !== false && rowsInExample > editorConfig.fullCheckAboveRows;
  const target = partial ? subsetAnalysis(analysis, editorConfig.subsetRows) : analysis;

  const v = verifyAgainstExample(rules, target, { exceptions, ...(opts.onlyColumns ? { onlyColumns: opts.onlyColumns } : {}) });

  // Per column: every aligned row is compared on every example column, so a column's misses are its mismatches.
  const missesByHeader = new Map<string, number>();
  for (const m of v.mismatches) missesByHeader.set(m.column, (missesByHeader.get(m.column) ?? 0) + 1);
  const width = Math.max(rules.output.columns.length, analysis.output.columnCount);
  const perColumn: LiveCheckResult['perColumn'] = [];
  for (let c = 0; c < width; c++) {
    const header = rules.output.columns[c]?.header ?? analysis.output.headers[c] ?? `column${c + 1}`;
    const inExample = c < analysis.output.columnCount;
    perColumn.push({ header, inExample, matched: inExample ? v.total - (missesByHeader.get(header) ?? 0) : 0, total: inExample ? v.total : 0 });
  }

  // A subset can't tell whether titles, summary rows or the row count match: only the file settings (and a failed run) count.
  const layoutIssues = partial ? (runFailed(v) ? v.layoutIssues : v.layoutIssues.filter((i) => i.code === 'fileSettings')) : v.layoutIssues;
  const layoutProblems = layoutIssues.map((i) => i.message);

  const verified = !partial && v.verified;
  let differences = v.total - v.matched + layoutProblems.length;
  if (!partial && !v.verified && differences === 0) differences = 1; // e.g. rows the rules add that the example doesn't have

  const preview = buildPreview(target, rules, v, new Set(exceptions), editorConfig.previewRows);
  return {
    verified,
    matched: v.matched,
    total: v.total,
    differences,
    perColumn,
    mismatches: v.mismatches.slice(0, editorConfig.maxMismatches).map((m) => ({ ...m, columnIndex: columnIndexOf(rules, analysis, m.column) })),
    mismatchCount: v.mismatches.length,
    preview,
    layoutProblems,
    layoutIssues,
    partial,
    checkedInputRows: target.input.rows.length,
    totalInputRows: analysis.input.rows.length,
    ms: Math.round((performance.now() - started) * 10) / 10,
  };
}

function columnIndexOf(rules: LearnResult | Rules, a: PairAnalysis, header: string): number {
  const i = rules.output.columns.findIndex((c) => c.header === header);
  return i >= 0 ? i : a.output.headers.indexOf(header);
}

// ---------- static checks (SPEC 9.2 layers 1-5) ----------

export function runStaticChecks(rules: LearnResult | Rules, opts: StaticCheckOptions): StaticProblem[] {
  const problems: StaticProblem[] = [];

  // Layer 1: structure. Everything after assumes a valid shape.
  const parsed = 'meta' in rules ? RulesSchema.safeParse(rules) : LearnResultSchema.safeParse(rules);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 10).map((i) => ({ layer: 'structure', kind: 'schema', path: i.path.map(String).join('.'), message: i.message }));
  }

  const guard = (layer: StaticProblem['layer'], run: () => { kind: string; path?: string; message: string }[]): void => {
    try {
      for (const p of run()) problems.push({ layer, kind: p.kind, ...(p.path === undefined ? {} : { path: p.path }), message: p.message });
    } catch (e) {
      problems.push({ layer, kind: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  };

  guard('references', () => checkRules(rules));
  guard('types', () => typeCheck(rules));
  guard('limits', () => checkLimits(rules, opts.tier));
  if (opts.format) {
    const format: Format = opts.format;
    guard('formatLock', () => checkFormatLock(rules, format));
  }
  if (opts.source) {
    const source: SourceStructure = opts.source;
    // DECISION: aliases are not compared here. The check is for a conversion about to be saved into an EXISTING source, and there the
    // server merges the file's aliases into the source instead of refusing (SPEC 8.15 "Saving": saving = reuse).
    guard('sourceLock', () => checkSourceLock(rules, source, { ignoreAliases: true }));
  }
  return problems;
}
