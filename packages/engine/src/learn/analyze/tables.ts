// Table detection for both files and classification of the example output's
// rows (SPEC 6.1, 6.2 step 1): title, header, data, blank, summary after a
// group, summary at the end. Summary rows are found by their values (they equal
// an aggregate of the rows above) together with structure or a repeated label,
// never by a word list alone.

import Decimal from 'decimal.js';
import { detectFileSpecWithConfidence, type HeaderConfidence } from '../../io/detectFileSpec';
import { detectTable, nonEmptySheets } from '../../io/detectTable';
import { isFooterLabel } from '../../io/text';
import type { OutputFileSpec, RawCell, RawSheet, RawWorkbook, TableDetection } from '../../types';
import {
  EMPTY,
  TEXT,
  columnFromCells,
  decOf,
  detectTextDates,
  gather,
  isEmptyRaw,
  normFast,
  rawText,
  type ColumnData,
} from './cells';
import type { AnalyzeOptions, InputSide, OutputRowKind, OutputSide, SideIssue } from './types';

// ---------- sheets ----------

function pickSheet(wb: RawWorkbook, sel: number | string | undefined): number {
  if (typeof sel === 'number') return sel >= 0 && sel < wb.sheets.length ? sel : -1;
  if (typeof sel === 'string') return wb.sheets.findIndex((s) => s.name === sel);
  const nonEmpty = nonEmptySheets(wb);
  return nonEmpty.length > 0 ? nonEmpty[0]! : wb.sheets.length > 0 ? 0 : -1;
}

function sheetNotices(wb: RawWorkbook, sel: number | string | undefined, side: 'input' | 'output'): SideIssue[] {
  if (sel !== undefined) return [];
  // SPEC 6.1: several non-empty sheets -> the UI asks; the analysis uses the first.
  return nonEmptySheets(wb).length > 1 ? [{ side, code: 'multipleSheets', severity: 'notice' }] : [];
}

function lastNonEmptyHeader(row: (RawCell | null)[] | undefined): number {
  if (!row) return -1;
  for (let c = row.length - 1; c >= 0; c--) if (!isEmptyRaw(row[c])) return c;
  return -1;
}

function lastNonEmptyRow(sheet: RawSheet): number {
  for (let r = sheet.rows.length - 1; r >= 0; r--) {
    const row = sheet.rows[r];
    if (row && row.some((c) => !isEmptyRaw(c))) return r;
  }
  return -1;
}

// ---------- input ----------

export interface InputData {
  side: Omit<InputSide, 'profile'>;
  cols: ColumnData[];
}

export function readInput(
  wb: RawWorkbook,
  sel: number | string | undefined,
): { ok: true; data: InputData; notices: SideIssue[] } | { ok: false; issues: SideIssue[] } {
  const idx = pickSheet(wb, sel);
  const sheet = idx >= 0 ? wb.sheets[idx] : undefined;
  if (!sheet) return { ok: false, issues: [{ side: 'input', code: 'emptySheet', severity: 'reject' }] };
  const detection = detectTable(sheet, { mode: 'input' });
  const issues: SideIssue[] = detection.issues.map((i) => ({ ...i, side: 'input' as const }));
  if (!detection.ok) return { ok: false, issues };

  const headerCells = sheet.rows[detection.headerRow] ?? [];
  const columnCount = Math.max(1, lastNonEmptyHeader(headerCells) + 1);
  const headers: string[] = [];
  for (let c = 0; c < columnCount; c++) headers.push(rawText(headerCells[c]));
  const rows: (RawCell | null)[][] = [];
  const rowNumbers: number[] = [];
  for (let r = detection.dataStart; r <= detection.dataEnd; r++) {
    rows.push(sheet.rows[r] ?? []);
    rowNumbers.push(r + 1);
  }
  const date1904 = wb.date1904 === true;
  const cols: ColumnData[] = [];
  for (let c = 0; c < columnCount; c++) {
    const cells: (RawCell | null)[] = new Array(rows.length);
    for (let r = 0; r < rows.length; r++) cells[r] = rows[r]![c] ?? null;
    const col = columnFromCells(cells, date1904);
    detectTextDates(col);
    cols.push(col);
  }
  const footerFirstCell: string[] = [];
  for (const fr of detection.footerRows) {
    const first = (sheet.rows[fr] ?? []).find((c) => !isEmptyRaw(c));
    const t = first ? rawText(first).trim() : '';
    if (t !== '' && !footerFirstCell.includes(t)) footerFirstCell.push(t);
  }
  return {
    ok: true,
    notices: [...issues, ...sheetNotices(wb, sel, 'input')],
    data: {
      side: {
        sheetIndex: idx,
        sheetName: sheet.name,
        direction: detection.direction,
        detection,
        layout: { headerRow: detection.headerRow, rowsAbove: detection.headerRow, footerFirstCell },
        headers,
        columnCount,
        rows,
        rowNumbers,
        date1904,
      },
      cols,
    },
  };
}

// ---------- output ----------

export interface OutputData {
  side: Omit<OutputSide, 'profile'>;
  /** Columns over every sheet row (0..last non-empty row), indexed by sheet row. */
  all: ColumnData[];
  /** Columns over the data rows only (text dates detected), indexed by output data row. */
  cols: ColumnData[];
  /**
   * True when `side.headerless` is only a default that the pair itself should confirm (see
   * headerCheck.ts): the file spec was detected (not given), it is a csv/txt, the first row is not
   * a header by other proof, and the detection had either no type evidence (all-text columns,
   * default header) or read the first row as data.
   */
  headerUncertain: boolean;
}

function firstNonEmptyRow(sheet: RawSheet): number {
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    if (row && row.some((c) => !isEmptyRaw(c))) return r;
  }
  return -1;
}

/** The first row of a "headerless" file repeats the input's headers: it is a header after all. */
function firstRowIsHeader(sheet: RawSheet, inputHeaders: string[]): boolean {
  const r = firstNonEmptyRow(sheet);
  if (r < 0) return false;
  const known = new Set(inputHeaders.map((h) => normFast(h).toLowerCase()).filter((h) => h !== ''));
  const cells = (sheet.rows[r] ?? []).filter((c) => !isEmptyRaw(c));
  if (cells.length < 2) return false;
  const hits = cells.filter((c) => known.has(normFast(rawText(c)).toLowerCase())).length;
  return hits / cells.length >= 0.5;
}

/**
 * Reads the example output. `forceHeader` reads it one way regardless of the detected file spec:
 * true = a header row is present, false = every row is data (used by headerCheck.ts to test both
 * readings against the input). A forced true reading that finds no header row fails.
 */
export function readOutput(
  wb: RawWorkbook,
  opts: AnalyzeOptions,
  inputHeaders: string[],
  forceHeader?: boolean,
): { ok: true; data: OutputData; notices: SideIssue[] } | { ok: false; issues: SideIssue[] } {
  const idx = pickSheet(wb, opts.outputSheet);
  const sheet = idx >= 0 ? wb.sheets[idx] : undefined;
  if (!sheet) return { ok: false, issues: [{ side: 'output', code: 'emptySheet', severity: 'reject' }] };

  const detected = opts.outputFileSpec === undefined;
  let file: OutputFileSpec;
  let confidence: HeaderConfidence = 'evidence';
  if (opts.outputFileSpec !== undefined) file = opts.outputFileSpec;
  else {
    const d = detectFileSpecWithConfidence(wb, idx, opts.outputSniff);
    file = d.spec;
    confidence = d.headerConfidence;
  }
  let headerless = file.header === false;
  // The header answer is a default (not proof) for a detected csv/txt spec with no type evidence
  // (all-text columns) or one that read the first row as data.
  let uncertain = detected && file.type !== 'xlsx' && (headerless || confidence === 'ambiguous');
  // DECISION: a first row that repeats the input's headers is a header, whatever the types below
  // it say. Only when the spec was detected, never when it was given.
  if (uncertain && firstRowIsHeader(sheet, inputHeaders)) {
    headerless = false;
    file = { ...file, header: true };
    uncertain = false;
  }
  if (forceHeader !== undefined) {
    headerless = !forceHeader;
    file = { ...file, header: forceHeader };
    uncertain = false;
  }
  let detection: TableDetection = detectTable(sheet, headerless ? { noHeader: true } : { mode: 'output' });
  if (forceHeader === undefined && !headerless && !detection.ok && detection.issues.some((i) => i.code === 'noHeaderRow')) {
    // A sheet with no header row at all is a headerless output (SPEC 8.13).
    headerless = true;
    file = { ...file, header: false };
    detection = detectTable(sheet, { noHeader: true });
    uncertain = false;
  }
  const issues: SideIssue[] = detection.issues.map((i) => ({ ...i, side: 'output' as const }));
  if (!detection.ok) return { ok: false, issues };

  const last = lastNonEmptyRow(sheet);
  const headerCells = headerless ? [] : (sheet.rows[detection.headerRow] ?? []);
  let columnCount = headerless ? 0 : lastNonEmptyHeader(headerCells) + 1;
  for (let r = detection.dataStart; r <= last; r++) columnCount = Math.max(columnCount, lastNonEmptyHeader(sheet.rows[r]) + 1);
  columnCount = Math.max(1, columnCount);
  const headers: string[] = [];
  for (let c = 0; c < columnCount; c++) headers.push(headerless ? '' : rawText(headerCells[c]));

  const all: ColumnData[] = [];
  for (let c = 0; c < columnCount; c++) {
    const cells: (RawCell | null)[] = new Array(last + 1);
    for (let r = 0; r <= last; r++) cells[r] = sheet.rows[r]?.[c] ?? null;
    all.push(columnFromCells(cells, wb.date1904 === true));
  }
  const rowKinds = classifyRows(sheet, detection, all, last);
  const dataRows: number[] = [];
  rowKinds.forEach((k, r) => {
    if (k === 'data') dataRows.push(r);
  });
  const cols = all.map((col) => {
    const g = gather(col, dataRows);
    detectTextDates(g);
    return g;
  });

  return {
    ok: true,
    notices: [...issues, ...sheetNotices(wb, opts.outputSheet, 'output')],
    data: {
      side: {
        sheetIndex: idx,
        sheetName: sheet.name,
        direction: detection.direction,
        detection,
        sheet,
        file,
        headerless,
        headerRow: headerless ? -1 : detection.headerRow,
        headers,
        columnCount,
        rowKinds,
        dataRows,
      },
      all,
      cols,
      headerUncertain: uncertain,
    },
  };
}

// ---------- row classification ----------

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function rowBold(sheet: RawSheet, r: number): boolean {
  const row = sheet.rows[r] ?? [];
  let any = false;
  for (const c of row) {
    if (isEmptyRaw(c)) continue;
    if (!c!.bold) return false;
    any = true;
  }
  return any;
}

/** Label of a row: its first non-numeric text cell. */
function labelOf(cols: ColumnData[], r: number): { c: number; text: string } | null {
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c]!;
    if (col.kind[r] === TEXT && col.numKey[r] === null) return { c, text: col.text[r]! };
  }
  return null;
}

function signatures(cols: ColumnData[], r: number): string[] {
  const label = labelOf(cols, r);
  if (label) {
    const norm = normFast(label.text).toLowerCase();
    const firstWord = norm.split(' ')[0] ?? norm;
    return [`L${label.c}:${norm}`, `W${label.c}:${firstWord}`];
  }
  let mask = 'M';
  for (let c = 0; c < cols.length; c++) mask += cols[c]!.kind[r] === EMPTY ? '0' : '1';
  return [mask];
}

type ScopeAgg = 'sum' | 'average' | 'count' | 'min' | 'max' | 'first' | 'last';

/** Running float aggregates of a set of rows, per column (pre-filter only). */
class ScopeStats {
  rows: number[] = [];
  readonly sum: Float64Array;
  readonly cnt: Float64Array;
  readonly ne: Float64Array;
  readonly nz: Float64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly first: Float64Array;
  readonly last: Float64Array;
  bold = 0;
  private readonly cols: ColumnData[];
  constructor(cols: ColumnData[]) {
    this.cols = cols;
    const C = cols.length;
    this.sum = new Float64Array(C);
    this.cnt = new Float64Array(C);
    this.ne = new Float64Array(C);
    this.nz = new Float64Array(C);
    this.min = new Float64Array(C);
    this.max = new Float64Array(C);
    this.first = new Float64Array(C);
    this.last = new Float64Array(C);
    this.reset();
  }
  reset(): void {
    this.rows = [];
    this.sum.fill(0);
    this.cnt.fill(0);
    this.ne.fill(0);
    this.nz.fill(0);
    this.min.fill(Infinity);
    this.max.fill(-Infinity);
    this.first.fill(NaN);
    this.last.fill(NaN);
    this.bold = 0;
  }
  add(r: number, bold: boolean): void {
    this.rows.push(r);
    if (bold) this.bold++;
    for (let c = 0; c < this.cols.length; c++) {
      const col = this.cols[c]!;
      if (col.kind[r] === EMPTY) continue;
      this.ne[c]!++;
      const v = col.num[r]!;
      if (Number.isNaN(v)) continue;
      this.sum[c]! += v;
      this.cnt[c]!++;
      if (v !== 0) this.nz[c]!++;
      if (v < this.min[c]!) this.min[c] = v;
      if (v > this.max[c]!) this.max[c] = v;
      if (Number.isNaN(this.first[c]!)) this.first[c] = v;
      this.last[c] = v;
    }
  }
  /**
   * Aggregates of column c that equal v (float). Trivial coincidences are
   * skipped when minRows >= 2: a sum needs >= 2 non-zero values, an average
   * needs values that differ.
   */
  hits(c: number, v: number, aggs: ScopeAgg[], minRows: number): ScopeAgg[] {
    const n = this.rows.length;
    if (n < minRows) return [];
    const out: ScopeAgg[] = [];
    const cnt = this.cnt[c]!;
    const varied = this.min[c]! !== this.max[c]!;
    for (const agg of aggs) {
      let ok = false;
      switch (agg) {
        case 'sum':
          ok = cnt > 0 && approx(v, this.sum[c]!) && (minRows < 2 || this.nz[c]! >= 2);
          break;
        case 'average':
          ok = cnt > 0 && approx(v, this.sum[c]! / cnt) && (minRows < 2 || varied);
          break;
        case 'count':
          ok = v === n || v === this.ne[c]!;
          break;
        case 'min':
          ok = cnt > 0 && approx(v, this.min[c]!);
          break;
        case 'max':
          ok = cnt > 0 && approx(v, this.max[c]!);
          break;
        case 'first':
          ok = cnt > 0 && approx(v, this.first[c]!);
          break;
        case 'last':
          ok = cnt > 0 && approx(v, this.last[c]!);
          break;
      }
      if (ok) out.push(agg);
    }
    return out;
  }
}

/** Exact aggregate of a column over `rows` (null when not computable). */
function exactAgg(col: ColumnData, rows: number[], agg: ScopeAgg): Decimal | null {
  if (agg === 'count') {
    let ne = 0;
    for (const r of rows) if (col.kind[r] !== EMPTY) ne++;
    return new Decimal(ne);
  }
  let sum = new Decimal(0);
  let cnt = 0;
  let pick: Decimal | null = null;
  for (const r of rows) {
    if (col.kind[r] === EMPTY) continue;
    const d = decOf(col, r);
    if (d === null) continue;
    cnt++;
    if (agg === 'sum' || agg === 'average') sum = sum.plus(d);
    else if (agg === 'first') {
      if (pick === null) pick = d;
    } else if (agg === 'last') pick = d;
    else if (pick === null || (agg === 'min' ? d.lt(pick) : d.gt(pick))) pick = d;
  }
  if (agg === 'sum') return cnt > 0 ? sum : null;
  if (agg === 'average') return cnt > 0 ? sum.div(cnt) : null;
  return pick;
}

function sameValue(v: Decimal, target: Decimal, agg: ScopeAgg): boolean {
  if (v.toSignificantDigits(15).eq(target)) return true;
  if (agg === 'average') {
    // An average shown rounded (e.g. to 2 places) still counts.
    const dp = target.decimalPlaces();
    return dp >= 1 && v.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).eq(target);
  }
  return false;
}

interface RowMatch {
  /** Numeric cells in the row. */
  numeric: number;
  /** Numeric cells equal to an exact sum or average of a scope. */
  sumAvg: number;
  /** Numeric cells equal to an exact sum of a scope. */
  sums: number;
  /** Numeric cells equal to any tested aggregate. */
  explained: number;
}

/** Which of the row's numeric cells equal an aggregate of a scope: float pre-filter, exact confirmation. */
function rowMatches(cols: ColumnData[], r: number, scopes: ScopeStats[], aggs: ScopeAgg[], minRows: number): RowMatch {
  const m: RowMatch = { numeric: 0, sumAvg: 0, sums: 0, explained: 0 };
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c]!;
    if (col.kind[r] === EMPTY) continue;
    const v = col.num[r]!;
    if (Number.isNaN(v)) continue;
    m.numeric++;
    const target = decOf(col, r)!;
    let hitSumAvg = false;
    let hitSum = false;
    let hitAny = false;
    for (const scope of scopes) {
      for (const agg of scope.hits(c, v, aggs, minRows)) {
        const isSumAvg = agg === 'sum' || agg === 'average';
        if (hitSum || (hitAny && !isSumAvg) || (hitSumAvg && agg !== 'sum')) continue;
        const exact = exactAgg(col, scope.rows, agg);
        if (exact === null || !sameValue(exact, target, agg)) continue;
        hitAny = true;
        if (isSumAvg) hitSumAvg = true;
        if (agg === 'sum') hitSum = true;
      }
    }
    if (hitSumAvg) m.sumAvg++;
    if (hitSum) m.sums++;
    if (hitAny) m.explained++;
  }
  return m;
}

/**
 * Kinds of every sheet row from 0 to `last`. A row is a summary row when its
 * numbers equal aggregates of the data rows above it AND something else says
 * so (never a word list alone):
 *  (a) the exact sum of its group (or of all rows above) on 2+ columns, or a
 *      sum or average on 1 column when it looks structurally different (an
 *      empty cell where the data is always filled, bold among plain rows, or a
 *      total label);
 *  (b) it shares a label with a summary row found earlier (or has a total
 *      label) and every number in it is an aggregate (catches one-row groups);
 *  (c) it follows a summary row directly, looks different from the data, and
 *      every number in it is an aggregate of that group or of all rows (a
 *      second summary row per group, e.g. counts under sums).
 * The scan repeats until nothing changes, so rows found late stop polluting the
 * running totals. Summary rows before the last data row, and trailing ones with
 * a group summary's label, are group summaries; other trailing ones are
 * summaries at the end.
 */
export function classifyRows(sheet: RawSheet, det: TableDetection, cols: ColumnData[], last: number): OutputRowKind[] {
  const kinds: OutputRowKind[] = new Array(Math.max(0, last + 1));
  const isBlank = (r: number): boolean => cols.every((col) => col.kind[r] === EMPTY);
  const start = Math.max(0, det.dataStart);
  for (let r = 0; r < start && r <= last; r++) kinds[r] = r === det.headerRow ? 'header' : isBlank(r) ? 'blank' : 'title';
  for (let r = start; r <= last; r++) kinds[r] = isBlank(r) ? 'blank' : 'data';
  if (last - start + 1 < 3) return kinds;

  const C = cols.length;
  const summary = new Uint8Array(last + 1);
  const bold = new Uint8Array(last + 1);
  for (let r = start; r <= last; r++) if (rowBold(sheet, r)) bold[r] = 1;
  const ALL_AGGS: ScopeAgg[] = ['sum', 'average', 'count', 'min', 'max', 'first', 'last'];

  /** Structurally different from the rows of `scope`. */
  const structural = (r: number, scope: ScopeStats): boolean => {
    const n = scope.rows.length;
    if (n >= 2) {
      for (let c = 0; c < C; c++) if (cols[c]!.kind[r] === EMPTY && scope.ne[c]! >= 0.9 * n) return true;
      if (bold[r] && scope.bold < n / 2) return true;
    }
    const label = labelOf(cols, r);
    return label !== null && isFooterLabel(label.text);
  };

  for (let iter = 0; iter < 4; iter++) {
    const sigs = new Set<string>();
    for (let r = start; r <= last; r++) if (summary[r]) for (const s of signatures(cols, r)) sigs.add(s);
    let changed = false;
    let seg = new ScopeStats(cols);
    const all = new ScopeStats(cols);
    let prevSeg: ScopeStats | null = null;
    let afterSummary = false;
    const closeSegment = (): void => {
      if (seg.rows.length > 0) prevSeg = seg;
      seg = new ScopeStats(cols);
    };
    for (let r = start; r <= last; r++) {
      if (kinds[r] === 'blank') {
        closeSegment();
        afterSummary = false;
        continue;
      }
      if (summary[r]) {
        closeSegment();
        afterSummary = true;
        continue;
      }
      let isSummary = false;
      // (a) sums/averages
      let floatHits = 0;
      for (let c = 0; c < C; c++) {
        const col = cols[c]!;
        if (col.kind[r] === EMPTY) continue;
        const v = col.num[r]!;
        if (Number.isNaN(v)) continue;
        if (seg.hits(c, v, ['sum', 'average'], 2).length > 0 || all.hits(c, v, ['sum', 'average'], 2).length > 0) floatHits++;
      }
      if (floatHits > 0) {
        const s = structural(r, seg.rows.length >= 2 ? seg : all);
        if (floatHits >= 2 || s) {
          // DECISION: averages fall inside the data's range, so they coincide with
          // ordinary values; without a structural sign it takes two exact sums.
          // An average alone must also close its block (blank row, summary row or end next).
          const m = rowMatches(cols, r, [seg, all], ['sum', 'average'], 2);
          const boundary = r === last || kinds[r + 1] === 'blank' || summary[r + 1] === 1;
          isSummary = m.sums >= 2 || (s && (m.sums >= 1 || (m.sumAvg >= 1 && boundary)));
        }
      }
      // (b) a known label, (c) right after a summary row
      const prev = afterSummary ? (prevSeg as ScopeStats | null) : null;
      if (!isSummary) {
        const label = labelOf(cols, r);
        const labeled = signatures(cols, r).some((s) => sigs.has(s)) || (label !== null && isFooterLabel(label.text));
        if (labeled || (prev !== null && structural(r, prev))) {
          const m = rowMatches(cols, r, prev !== null ? [seg, prev, all] : [seg, all], ALL_AGGS, 1);
          isSummary = m.numeric > 0 && m.explained === m.numeric && (m.sumAvg >= 1 || prev !== null);
        }
      }
      if (isSummary) {
        summary[r] = 1;
        changed = true;
        closeSegment();
        afterSummary = true;
        continue;
      }
      afterSummary = false;
      seg.add(r, bold[r] === 1);
      all.add(r, bold[r] === 1);
    }
    if (!changed) break;
  }

  // ---- group vs end ----
  let lastData = -1;
  for (let r = start; r <= last; r++) if (kinds[r] === 'data' && !summary[r]) lastData = r;
  const groupSigs = new Set<string>();
  // Summary rows per group (the longest run between data rows, blank rows ignored).
  let perGroup = 0;
  let run = 0;
  for (let r = start; r < lastData; r++) {
    if (summary[r]) {
      kinds[r] = 'summaryGroup';
      for (const s of signatures(cols, r)) groupSigs.add(s);
      perGroup = Math.max(perGroup, ++run);
    } else if (kinds[r] === 'data') run = 0;
  }
  // DECISION: after the last data row, the first `perGroup` summary rows with a
  // group summary's label belong to the last group; the rest (e.g. a grand total
  // whose label starts like the subtotals') are summaries at the end.
  let taken = 0;
  let ended = false;
  for (let r = Math.max(start, lastData + 1); r <= last; r++) {
    if (!summary[r]) continue;
    if (!ended && taken < perGroup && signatures(cols, r).some((s) => groupSigs.has(s))) {
      kinds[r] = 'summaryGroup';
      taken++;
    } else {
      ended = true;
      kinds[r] = 'summaryEnd';
    }
  }
  return kinds;
}

// ---------- identical files ----------

/** The two sheets hold exactly the same cell values (SPEC 6.3). */
export function identicalSheets(a: RawSheet, b: RawSheet): boolean {
  const lastA = lastNonEmptyRow(a);
  const lastB = lastNonEmptyRow(b);
  if (lastA !== lastB) return false;
  for (let r = 0; r <= lastA; r++) {
    const ra = a.rows[r] ?? [];
    const rb = b.rows[r] ?? [];
    const n = Math.max(ra.length, rb.length);
    for (let c = 0; c < n; c++) {
      const ca = ra[c];
      const cb = rb[c];
      if (isEmptyRaw(ca) && isEmptyRaw(cb)) continue;
      if (isEmptyRaw(ca) !== isEmptyRaw(cb)) return false;
      if (rawText(ca) !== rawText(cb)) return false;
    }
  }
  return true;
}
