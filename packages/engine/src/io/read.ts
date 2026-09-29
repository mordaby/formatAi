import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { CellRange, RawCell, RawSheet, RawWorkbook } from '../types';

export type ReadErrorCode = 'unsupportedFileType';

/** Thrown by readWorkbook for anything other than .xlsx/.xls/.csv. */
export class UnsupportedFileTypeError extends Error {
  readonly code: ReadErrorCode = 'unsupportedFileType';
  readonly fileName: string;
  readonly extension: string;

  constructor(fileName: string, extension: string) {
    super(`Unsupported file type "${extension || '(none)'}" for "${fileName}"`);
    this.name = 'UnsupportedFileTypeError';
    this.fileName = fileName;
    this.extension = extension;
  }
}

/**
 * Reads an xlsx/xls/csv file into the engine's neutral RawWorkbook shape.
 * Must run identically in a browser Web Worker and in Node: no Node-only APIs.
 */
export async function readWorkbook(
  data: Uint8Array | ArrayBuffer,
  fileName: string
): Promise<RawWorkbook> {
  const bytes = toUint8Array(data);
  const ext = getExtension(fileName);

  if (ext === 'csv') {
    return readCsvWorkbook(bytes, fileName);
  }
  if (ext === 'xlsx' || ext === 'xls') {
    return readExcelWorkbook(bytes, ext);
  }
  throw new UnsupportedFileTypeError(fileName, ext);
}

function toUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx === -1 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

/** "One sheet named after the file" (SPEC 6.1): strip any path and extension. */
function sheetNameFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const idx = base.lastIndexOf('.');
  const name = idx > 0 ? base.slice(0, idx) : base;
  return name || 'Sheet1';
}

// ---------- xlsx / xls ----------

async function readExcelWorkbook(bytes: Uint8Array, ext: 'xlsx' | 'xls'): Promise<RawWorkbook> {
  // DECISION: `type: 'array'` accepts a plain byte array/Uint8Array and needs no
  // Node Buffer, so this path works unchanged in a browser Web Worker.
  const wb = XLSX.read(bytes, {
    type: 'array',
    cellDates: false,
    cellNF: true,
    // DECISION: SheetJS only records row-hidden metadata into `!rows` when
    // cellStyles is on (column-hidden/width in `!cols` doesn't need it, but we
    // ask for both from the same source for consistency).
    cellStyles: true,
    cellHTML: false,
    sheetStubs: true,
  });

  const date1904 = wb.Workbook?.WBProps?.date1904;
  const bookRtl = wb.Workbook?.Views?.[0]?.RTL;

  const sheets = wb.SheetNames.map((name) => sheetJsToRawSheet(wb.Sheets[name]!, name, bookRtl));

  if (ext === 'xlsx') {
    // ExcelJS is used only for what SheetJS doesn't expose: the sheet-view RTL
    // flag, bold fonts, hidden rows/cols and drawing/image detection.
    await overlayWithExceljs(bytes, sheets);
  }

  return { fileType: ext, sheets, date1904 };
}

function sheetJsToRawSheet(ws: XLSX.WorkSheet, name: string, bookRtl?: boolean): RawSheet {
  const ref = ws['!ref'];
  const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };

  const rows: (RawCell | null)[][] = [];
  for (let r = 0; r <= range.e.r; r++) {
    const row: (RawCell | null)[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      row.push(cell ? sheetJsToRawCell(cell) : null);
    }
    rows.push(row);
  }

  const merges: CellRange[] = (ws['!merges'] ?? []).map((m) => ({
    s: { r: m.s.r, c: m.s.c },
    e: { r: m.e.r, c: m.e.c },
  }));

  const hiddenRows: number[] = [];
  (ws['!rows'] ?? []).forEach((ri, idx) => {
    if (ri?.hidden) hiddenRows.push(idx);
  });

  const hiddenCols: number[] = [];
  const colWidths: (number | undefined)[] = [];
  (ws['!cols'] ?? []).forEach((ci, idx) => {
    if (ci?.hidden) hiddenCols.push(idx);
    colWidths[idx] = ci?.wch;
  });

  return {
    name,
    rows,
    merges,
    rightToLeft: bookRtl,
    hiddenRows,
    hiddenCols,
    colWidths,
  };
}

function sheetJsToRawCell(cell: XLSX.CellObject): RawCell {
  let v: string | number | boolean | null;
  switch (cell.t) {
    case 'n':
      v = typeof cell.v === 'number' ? cell.v : Number(cell.v);
      break;
    case 's':
      v = cell.v == null ? '' : String(cell.v);
      break;
    case 'b':
      v = Boolean(cell.v);
      break;
    case 'd':
      // Shouldn't happen with cellDates:false, but keep a safe fallback.
      v = cell.v instanceof Date ? cell.v.toISOString() : String(cell.v ?? '');
      break;
    case 'e':
      // DECISION: formula-error cells are surfaced as their displayed text
      // (e.g. "#DIV/0!") rather than being dropped, so downstream steps can flag them.
      v = cell.w ?? (cell.v == null ? null : String(cell.v));
      break;
    case 'z':
    default:
      v = null;
      break;
  }

  const z = cell.z === undefined ? undefined : String(cell.z);
  const isDate = cell.t === 'n' && !!z && XLSX.SSF.is_date(z);

  const raw: RawCell = { v };
  if (z !== undefined) raw.z = z;
  if (isDate) raw.isDate = true;
  return raw;
}

async function overlayWithExceljs(bytes: Uint8Array, sheets: RawSheet[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  // DECISION: ExcelJS's own .d.ts declares a local `Buffer extends ArrayBuffer`
  // type for this parameter; a Uint8Array satisfies it at runtime (ExcelJS hands
  // it straight to JSZip.loadAsync, which accepts Uint8Array/ArrayBuffer), so we
  // cast rather than fight the declared type.
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  let hasAnyDrawingPart = false;
  try {
    const zip = await JSZip.loadAsync(bytes);
    hasAnyDrawingPart = Object.keys(zip.files).some(
      (name) => /^xl\/drawings\//i.test(name) && zip.files[name]?.dir !== true
    );
  } catch {
    hasAnyDrawingPart = false;
  }

  workbook.eachSheet((worksheet, sheetId) => {
    const raw = sheets[sheetId - 1];
    if (!raw) return;

    const view = worksheet.views?.[0];
    if (view && typeof view.rightToLeft === 'boolean') {
      raw.rightToLeft = view.rightToLeft;
    }

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const r = rowNumber - 1;
      const rawRow = raw.rows[r];
      if (!rawRow) return;
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const c = colNumber - 1;
        const existing = rawRow[c];
        if (cell.font?.bold && existing) {
          rawRow[c] = { ...existing, bold: true };
        }
      });
    });

    // ExcelJS reads embedded images per sheet; it doesn't parse charts at all,
    // so a chart-only sheet needs the raw zip check below (SPEC 6.1 "onlyDrawings").
    const images = typeof worksheet.getImages === 'function' ? worksheet.getImages() : [];
    raw.hasDrawings = images.length > 0 || hasAnyDrawingPart || raw.hasDrawings === true;
  });
}

// ---------- csv ----------

async function readCsvWorkbook(bytes: Uint8Array, fileName: string): Promise<RawWorkbook> {
  const encoding = detectCsvEncoding(bytes);
  const text = decodeCsvBytes(bytes, encoding);
  const delimiter = detectCsvDelimiter(text);
  const parsed = parseCsv(text, delimiter);

  const rows: (RawCell | null)[][] = parsed.map((fields) => fields.map((f): RawCell => ({ v: f })));

  const sheet: RawSheet = {
    name: sheetNameFromFileName(fileName),
    rows,
    merges: [],
    hiddenRows: [],
    hiddenCols: [],
    colWidths: [],
  };

  return { fileType: 'csv', sheets: [sheet], encoding };
}

/** Exported for tests; not part of the public io surface. */
export function detectCsvEncoding(bytes: Uint8Array): 'utf-8' | 'utf-8-bom' | 'windows-1255' {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8-bom';
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'windows-1255';
  }
}

function decodeCsvBytes(bytes: Uint8Array, encoding: 'utf-8' | 'utf-8-bom' | 'windows-1255'): string {
  if (encoding === 'utf-8-bom') return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (encoding === 'utf-8') return new TextDecoder('utf-8').decode(bytes);
  return new TextDecoder('windows-1255').decode(bytes);
}

// DECISION: delimiter is sniffed from the first line only, comparing raw comma
// vs semicolon counts (quoting is ignored for this heuristic). Good enough for
// the MVP's single-table files; ties default to comma.
function detectCsvDelimiter(text: string): ',' | ';' {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

/**
 * Small RFC-4180 parser. Every field is returned exactly as written (no trim,
 * no numeric/boolean coercion) so leading zeros and formatting survive.
 */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
