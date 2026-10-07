import { limits } from '@formatai/shared';
import type { RawCell, RawSheet, TableDetection, TableIssue, TableIssueCode, RawWorkbook } from '../types';
import { colLetter, hasHebrew, isFooterLabel, normalizeCellText } from './text';

export interface DetectTableOptions {
  /** 0-based row index. Overrides automatic header detection. */
  headerRow?: number;
  mode?: 'input' | 'output';
  /**
   * SPEC 8.13 / M1: treat the sheet as a headerless table (output.file
   * `header: false`, or a fixed-column load file). headerRow is reported as
   * -1, dataStart is the first non-empty row, and none of the header-based
   * rejections (noHeaderRow, mergedHeader, splitHeader) apply. M1's pair
   * analysis aligns headerless output columns by position instead of by name.
   */
  noHeader?: boolean;
}

type Cell = RawCell | null;
type CellType = 'empty' | 'text' | 'number' | 'boolean' | 'date';

// The thresholds are config (`limits.analysis.table`, SPEC 6.1).
const TABLE = limits.analysis.table;

function cellType(cell: Cell): CellType {
  if (!cell || cell.v === null) return 'empty';
  if (typeof cell.v === 'string' && cell.v.trim() === '') return 'empty';
  if (cell.isDate) return 'date';
  if (typeof cell.v === 'number') return 'number';
  if (typeof cell.v === 'boolean') return 'boolean';
  return 'text';
}

function cellAt(rows: Cell[][], r: number, c: number): Cell {
  return rows[r]?.[c] ?? null;
}

function isRowEmpty(row: Cell[] | undefined): boolean {
  if (!row || row.length === 0) return true;
  return row.every((c) => cellType(c) === 'empty');
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function lastNonEmptyRow(rows: Cell[][]): number {
  for (let r = rows.length - 1; r >= 0; r--) {
    if (!isRowEmpty(rows[r])) return r;
  }
  return -1;
}

/** Mostly non-empty text, with distinct values (SPEC 6.1). */
function looksLikeHeaderRow(row: Cell[] | undefined, colCount: number): boolean {
  if (!row) return false;
  const cells = row.slice(0, colCount);
  const nonEmpty = cells.filter((c) => cellType(c) !== 'empty');
  const minNonEmpty = Math.max(2, Math.ceil(colCount * TABLE.headerMinNonEmptyShare));
  if (nonEmpty.length < minNonEmpty) return false;

  const textCount = nonEmpty.filter((c) => cellType(c) === 'text').length;
  if (textCount / nonEmpty.length < TABLE.headerMinTextShare) return false;

  const texts = nonEmpty.map((c) => normalizeCellText(String(c!.v)).toLowerCase());
  return new Set(texts).size === texts.length;
}

/** `count` consecutive non-blank rows whose columns are each consistently typed. */
function isDataLikeBlock(rows: Cell[][], start: number, count: number, colCount: number): boolean {
  const block: Cell[][] = [];
  for (let i = 0; i < count; i++) {
    const row = rows[start + i];
    if (isRowEmpty(row)) return false;
    block.push(row!);
  }

  let consideredCols = 0;
  let consistentCols = 0;
  for (let c = 0; c < colCount; c++) {
    const types = new Set<CellType>();
    for (const row of block) {
      const t = cellType(row[c] ?? null);
      if (t !== 'empty') types.add(t);
    }
    if (types.size === 0) continue;
    consideredCols++;
    if (types.size === 1) consistentCols++;
  }
  if (consideredCols === 0) return false;
  return consistentCols / consideredCols >= TABLE.dataBlockConsistentShare;
}

type HeaderSearchResult = { kind: 'ok'; row: number } | { kind: 'split'; row: number } | { kind: 'none' };

function findHeaderInput(rows: Cell[][], colCount: number): HeaderSearchResult {
  const limit = Math.min(TABLE.headerScanRows, rows.length);
  // DECISION: a header normally needs >=3 (`headerDataRows`) consistently-typed rows after it, but we
  // also remember the first candidate that only has >=2 (`minDataRows`), so that a header is still
  // found and the "fewer than 2 data rows" rejection can fire later (after footer
  // rows are trimmed off) instead of a less specific "no header row" rejection.
  let fallback: number | null = null;

  for (let r = 0; r < limit; r++) {
    if (!looksLikeHeaderRow(rows[r], colCount)) continue;

    // DECISION: check the single-header reading first. `looksLikeHeaderRow`
    // only requires "mostly text, all distinct" (SPEC 6.1), which plenty of
    // ordinary first data rows satisfy too (e.g. a row of unique text ids/names
    // with just one numeric column) -- especially for CSV, where every cell is
    // a string and so trivially reads as "text". Checking the 3-row data block
    // right after `r` first, before asking whether row r+1 *also* looks
    // header-ish, means a normal single-row header is never misclassified as
    // "split" just because its first data row happens to look header-like too.
    // A genuine two-row (grouped/merged) header still falls through to the
    // split check below, because a block starting on its own second header
    // row is never internally consistent (the header row's column doesn't
    // match the data rows' types).
    if (isDataLikeBlock(rows, r + 1, TABLE.headerDataRows, colCount)) {
      return { kind: 'ok', row: r };
    }

    const secondLineAlsoHeaderish = looksLikeHeaderRow(rows[r + 1], colCount);
    if (secondLineAlsoHeaderish && isDataLikeBlock(rows, r + 2, TABLE.minDataRows, colCount)) {
      return { kind: 'split', row: r };
    }

    if (fallback === null && isDataLikeBlock(rows, r + 1, TABLE.minDataRows, colCount)) {
      fallback = r;
    }
  }

  if (fallback !== null) return { kind: 'ok', row: fallback };
  return { kind: 'none' };
}

function findHeaderOutput(rows: Cell[][], colCount: number): number {
  const limit = Math.min(TABLE.headerScanRows, rows.length);
  for (let r = 0; r < limit; r++) {
    if (looksLikeHeaderRow(rows[r], colCount)) return r;
  }
  // DECISION (found by the engine stress test, eval/STRESS.md): an output of ONE column has a header too - its first non-empty
  // cell, when that is text. `looksLikeHeaderRow` asks for two cells, so a one-column example ("Customer No" over 50 numbers) was
  // read with no header, its header a data row matching no input row. Output mode only: an input's header search is unchanged.
  if (colCount === 1) {
    const first = rows.findIndex((row) => !isRowEmpty(row));
    if (first >= 0 && first < limit && cellType(cellAt(rows, first, 0)) === 'text') return first;
  }
  return -1;
}

function detectDirection(sheet: RawSheet, headerRow: number): 'rtl' | 'ltr' {
  if (typeof sheet.rightToLeft === 'boolean') return sheet.rightToLeft ? 'rtl' : 'ltr';
  const header = headerRow >= 0 ? (sheet.rows[headerRow] ?? []) : [];
  const texts = header.filter((c) => cellType(c) === 'text').map((c) => String(c!.v));
  if (texts.length === 0) return 'ltr';
  const hebrewCount = texts.filter(hasHebrew).length;
  return hebrewCount / texts.length > 0.5 ? 'rtl' : 'ltr';
}

function findHeaderMerge(sheet: RawSheet, headerRow: number): TableIssue | null {
  for (const m of sheet.merges) {
    if (m.s.r <= headerRow && headerRow <= m.e.r && m.s.c !== m.e.c) {
      return {
        code: 'mergedHeader',
        severity: 'reject',
        params: { row: headerRow + 1, fromCol: colLetter(m.s.c), toCol: colLetter(m.e.c) },
      };
    }
  }
  return null;
}

/** Two tables stacked vertically, separated by one or more blank rows. */
function hasVerticalMultipleTables(rows: Cell[][], dataStart: number, lastRow: number, colCount: number): boolean {
  let i = dataStart;
  while (i <= lastRow) {
    if (isRowEmpty(rows[i])) {
      let j = i;
      while (j <= lastRow && isRowEmpty(rows[j])) j++;
      if (j <= lastRow && looksLikeHeaderRow(rows[j], colCount) && isDataLikeBlock(rows, j + 1, 1, colCount)) {
        return true;
      }
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

/** Two tables side by side, separated by a wholly empty column. */
function hasHorizontalMultipleTables(
  rows: Cell[][],
  headerRow: number,
  dataStart: number,
  dataEnd: number,
  colCount: number
): boolean {
  const header = rows[headerRow] ?? [];
  const nonEmptyCols: number[] = [];
  for (let c = 0; c < colCount; c++) if (cellType(header[c] ?? null) !== 'empty') nonEmptyCols.push(c);
  if (nonEmptyCols.length < 2) return false;

  const first = nonEmptyCols[0]!;
  const last = nonEmptyCols[nonEmptyCols.length - 1]!;
  for (let c = first + 1; c < last; c++) {
    if (cellType(header[c] ?? null) !== 'empty') continue;
    let colEmpty = true;
    for (let r = headerRow; r <= dataEnd; r++) {
      if (cellType(cellAt(rows, r, c)) !== 'empty') {
        colEmpty = false;
        break;
      }
    }
    if (colEmpty && dataEnd >= dataStart) return true;
  }
  return false;
}

function firstNonEmptyText(row: Cell[]): string | undefined {
  for (const cell of row) {
    if (cellType(cell) !== 'empty') return String(cell!.v);
  }
  return undefined;
}

function isSumsRow(rows: Cell[][], dataStart: number, candidateRow: number, colCount: number): boolean {
  const row = rows[candidateRow] ?? [];
  let numericCellCount = 0;
  let matchCount = 0;
  for (let c = 0; c < colCount; c++) {
    const cell = row[c] ?? null;
    if (cellType(cell) !== 'number') continue;
    numericCellCount++;
    let sum = 0;
    for (let r = dataStart; r < candidateRow; r++) {
      const rc = cellAt(rows, r, c);
      if (cellType(rc) === 'number') sum += rc!.v as number;
    }
    if (Math.abs(sum - (cell!.v as number)) < 1e-6) matchCount++;
  }
  return numericCellCount > 0 && matchCount === numericCellCount;
}

function trimFooterRows(
  rows: Cell[][],
  dataStart: number,
  lastRow: number,
  colCount: number
): { dataEnd: number; footerRows: number[] } {
  const footerRows: number[] = [];
  let end = lastRow;
  while (end >= dataStart) {
    const row = rows[end] ?? [];
    if (isRowEmpty(row)) {
      end--;
      continue;
    }
    const firstText = firstNonEmptyText(row);
    const isLabelFooter = firstText !== undefined && isFooterLabel(firstText);
    const isSums = !isLabelFooter && isSumsRow(rows, dataStart, end, colCount);
    if (isLabelFooter || isSums) {
      footerRows.unshift(end);
      end--;
      continue;
    }
    break;
  }
  return { dataEnd: end, footerRows };
}

function hiddenIssue(): TableIssue {
  return { code: 'hiddenRowsOrCols', severity: 'notice' };
}

function reject(
  code: TableIssueCode,
  headerRow: number,
  dataStart: number,
  dataEnd: number,
  titleRows: number[],
  footerRows: number[],
  direction: 'rtl' | 'ltr',
  issues: TableIssue[]
): TableDetection {
  return { ok: false, headerRow, dataStart, dataEnd, titleRows, footerRows, direction, issues };
}

export function detectTable(sheet: RawSheet, opts?: DetectTableOptions): TableDetection {
  const mode = opts?.mode ?? 'input';
  const rows: Cell[][] = sheet.rows;
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const hiddenNotice = sheet.hiddenRows.length > 0 || sheet.hiddenCols.length > 0;

  const sheetHasContent = rows.some((row) => !isRowEmpty(row));
  if (!sheetHasContent) {
    const code: TableIssueCode = sheet.hasDrawings ? 'onlyDrawings' : 'emptySheet';
    return reject(code, -1, -1, -1, [], [], detectDirection(sheet, -1), [{ code, severity: 'reject' }]);
  }

  if (opts?.noHeader) {
    const dataStart = rows.findIndex((row) => !isRowEmpty(row));
    const dataEnd = lastNonEmptyRow(rows);
    const direction = detectDirection(sheet, dataStart);
    const issues: TableIssue[] = [];
    if (hiddenNotice) issues.push(hiddenIssue());
    return { ok: true, headerRow: -1, dataStart, dataEnd, titleRows: [], footerRows: [], direction, issues };
  }

  let headerRow: number;
  let isSplit = false;

  if (opts?.headerRow !== undefined) {
    headerRow = opts.headerRow;
  } else if (mode === 'output') {
    headerRow = findHeaderOutput(rows, colCount);
    if (headerRow === -1) {
      return reject('noHeaderRow', -1, -1, -1, [], [], detectDirection(sheet, -1), [
        { code: 'noHeaderRow', severity: 'reject' },
      ]);
    }
  } else {
    const found = findHeaderInput(rows, colCount);
    if (found.kind === 'none') {
      return reject('noHeaderRow', -1, -1, -1, [], [], detectDirection(sheet, -1), [
        { code: 'noHeaderRow', severity: 'reject' },
      ]);
    }
    headerRow = found.row;
    isSplit = found.kind === 'split';
  }

  const direction = detectDirection(sheet, headerRow);
  const titleRows = headerRow > 0 ? range(0, headerRow - 1) : [];
  const lastRow = lastNonEmptyRow(rows);
  const dataStart = headerRow + 1;

  if (mode === 'output') {
    const dataEnd = Math.max(dataStart - 1, lastRow);
    const issues: TableIssue[] = [];
    if (hiddenNotice) issues.push(hiddenIssue());
    return { ok: true, headerRow, dataStart, dataEnd, titleRows, footerRows: [], direction, issues };
  }

  // ---- input mode ----
  if (isSplit) {
    return reject('splitHeader', headerRow, dataStart + 1, Math.max(dataStart, lastRow), titleRows, [], direction, [
      { code: 'splitHeader', severity: 'reject' },
    ]);
  }

  const mergeIssue = findHeaderMerge(sheet, headerRow);
  if (mergeIssue) {
    return reject(mergeIssue.code, headerRow, dataStart, Math.max(dataStart - 1, lastRow), titleRows, [], direction, [
      mergeIssue,
    ]);
  }

  if (dataStart > lastRow) {
    return reject('tooFewDataRows', headerRow, dataStart, dataStart - 1, titleRows, [], direction, [
      { code: 'tooFewDataRows', severity: 'reject' },
    ]);
  }

  if (hasHorizontalMultipleTables(rows, headerRow, dataStart, lastRow, colCount)) {
    return reject('multipleTables', headerRow, dataStart, lastRow, titleRows, [], direction, [
      { code: 'multipleTables', severity: 'reject' },
    ]);
  }

  if (hasVerticalMultipleTables(rows, dataStart, lastRow, colCount)) {
    return reject('multipleTables', headerRow, dataStart, lastRow, titleRows, [], direction, [
      { code: 'multipleTables', severity: 'reject' },
    ]);
  }

  const { dataEnd, footerRows } = trimFooterRows(rows, dataStart, lastRow, colCount);
  const dataRowCount = Math.max(0, dataEnd - dataStart + 1);

  const issues: TableIssue[] = [];
  if (hiddenNotice) issues.push(hiddenIssue());

  if (dataRowCount < TABLE.minDataRows) {
    issues.push({ code: 'tooFewDataRows', severity: 'reject' });
    return { ok: false, headerRow, dataStart, dataEnd, titleRows, footerRows, direction, issues };
  }

  return { ok: true, headerRow, dataStart, dataEnd, titleRows, footerRows, direction, issues };
}

/** 0-based indices of sheets that contain at least one non-empty cell (or a drawing). SPEC 6.1. */
export function nonEmptySheets(wb: RawWorkbook): number[] {
  const out: number[] = [];
  wb.sheets.forEach((sheet, idx) => {
    const hasContent = sheet.rows.some((row) => row.some((c) => cellType(c) !== 'empty'));
    if (hasContent || sheet.hasDrawings) out.push(idx);
  });
  return out;
}
