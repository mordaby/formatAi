import type { InputTable, RawCell, RawWorkbook, RunError, TableDetection } from '../types';
import { detectTable } from './detectTable';
import { normalizeCellText } from './text';

export type SheetSelector =
  | { pick: 'first' }
  | { pick: 'name'; name: string }
  | { pick: 'index'; index: number };

/**
 * Locally-declared input shape for extractTable. Structurally compatible with
 * the zod `input` rules schema (SPEC 8.1) -- see packages/shared for that
 * schema's validation; this type only describes what extractTable reads.
 */
export interface ExtractTableInput {
  sheet?: SheetSelector;
  headerRow?: 'auto' | number;
  stopAt?: { when: 'firstCellMatches'; values: string[] };
}

export type ExtractTableResult =
  | { ok: true; table: InputTable; detection: TableDetection }
  | { ok: false; error: RunError; detection?: TableDetection };

function cellToHeaderText(cell: RawCell | null): string {
  if (!cell || cell.v === null) return '';
  if (typeof cell.v === 'string') return cell.v;
  if (typeof cell.v === 'number') return String(cell.v);
  // DECISION: booleans are stringified as TRUE/FALSE, matching Excel's display text.
  return cell.v ? 'TRUE' : 'FALSE';
}

function firstNonEmptyCellText(row: (RawCell | null)[]): string | undefined {
  for (const cell of row) {
    if (!cell || cell.v === null) continue;
    if (typeof cell.v === 'string' && cell.v.trim() === '') continue;
    return typeof cell.v === 'string' ? cell.v : String(cell.v);
  }
  return undefined;
}

/**
 * Picks a sheet, finds/uses the header row, and reads data rows up to
 * `stopAt` (or the footer detected by detectTable). SPEC 8.2 step 1.
 */
export function extractTable(wb: RawWorkbook, input: ExtractTableInput): ExtractTableResult {
  const selector = input.sheet ?? { pick: 'first' };

  let sheet;
  if (selector.pick === 'first') {
    sheet = wb.sheets[0];
  } else if (selector.pick === 'name') {
    sheet = wb.sheets.find((s) => s.name === selector.name);
  } else {
    sheet = wb.sheets[selector.index];
  }

  if (!sheet) {
    const params: Record<string, string | number> = {};
    if (selector.pick === 'name') params.name = selector.name;
    if (selector.pick === 'index') params.index = selector.index;
    return { ok: false, error: { code: 'sheetNotFound', params } };
  }

  const headerRowOpt = input.headerRow === undefined || input.headerRow === 'auto' ? undefined : input.headerRow;
  const detection = detectTable(sheet, { headerRow: headerRowOpt, mode: 'input' });

  if (!detection.ok) {
    const issueCode = detection.issues.find((i) => i.severity === 'reject')?.code;
    return {
      ok: false,
      error: { code: 'noTable', params: issueCode ? { issue: issueCode } : undefined },
      detection,
    };
  }

  const headerRow = sheet.rows[detection.headerRow] ?? [];
  const headers = headerRow.map((cell) => cellToHeaderText(cell));

  let dataEnd = detection.dataEnd;
  if (input.stopAt && input.stopAt.when === 'firstCellMatches') {
    const stopValues = input.stopAt.values.map(normalizeCellText);
    for (let r = detection.dataStart; r <= detection.dataEnd; r++) {
      const row = sheet.rows[r] ?? [];
      const firstText = firstNonEmptyCellText(row);
      if (firstText === undefined) continue;
      const normed = normalizeCellText(firstText);
      if (stopValues.some((v) => normed === v || normed.startsWith(v))) {
        dataEnd = r - 1;
        break;
      }
    }
  }

  const rows: (RawCell | null)[][] = [];
  const rowNumbers: number[] = [];
  for (let r = detection.dataStart; r <= dataEnd; r++) {
    rows.push(sheet.rows[r] ?? []);
    rowNumbers.push(r + 1); // 1-based Excel row number
  }

  const table: InputTable = {
    sheetName: sheet.name,
    direction: detection.direction,
    headers,
    rows,
    rowNumbers,
    date1904: wb.date1904,
  };

  return { ok: true, table, detection };
}
