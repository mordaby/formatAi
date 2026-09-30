import ExcelJS from 'exceljs';
import type { Fill } from 'exceljs';
import JSZip from 'jszip';
import type { OutCell, OutputSheet } from '../types';

const MAX_SHEET_NAME_LENGTH = 31;
const INVALID_SHEET_NAME_CHARS = /[[\]:*?/\\]/g;

// DECISION: fix every date the workbook could embed so two writes of the same
// OutputSheet produce byte-identical files (SPEC 2.1 determinism).
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1));

// DECISION: one reserved fill color for flagged cells (a light amber highlight).
function flagFill(): Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
}

function sanitizeSheetName(name: string): string {
  let n = name.replace(INVALID_SHEET_NAME_CHARS, ' ').trim();
  if (!n) n = 'Sheet1';
  if (n.length > MAX_SHEET_NAME_LENGTH) n = n.slice(0, MAX_SHEET_NAME_LENGTH);
  return n;
}

function applyCellValue(cell: ExcelJS.Cell, v: OutCell['v']): void {
  if (v === null) {
    cell.value = null;
    return;
  }
  // Numbers, booleans and strings are all written as literal values, never as
  // formulas -- even a string that happens to start with "=" (SPEC 15/16.2).
  cell.value = v;
}

function addSheet(workbook: ExcelJS.Workbook, sheet: OutputSheet): void {
  const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name), {
    views: [{ rightToLeft: sheet.direction === 'rtl' }],
  });

  worksheet.columns = sheet.columns.map((col) => ({ width: col.width }));

  sheet.rows.forEach((row, rIdx) => {
    const excelRow = worksheet.getRow(rIdx + 1);
    row.cells.forEach((cell, cIdx) => {
      const excelCell = excelRow.getCell(cIdx + 1);
      applyCellValue(excelCell, cell.v);

      const fmt = row.kind === 'data' ? (cell.z ?? sheet.columns[cIdx]?.format) : cell.z;
      if (fmt) excelCell.numFmt = fmt;

      const bold = cell.bold ?? row.bold ?? false;
      if (bold) excelCell.font = { bold: true };

      if (cell.flagged) excelCell.fill = flagFill();
    });
  });

  sheet.merges.forEach((m) => {
    worksheet.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
  });
}

/** Writes an OutputSheet to a deterministic .xlsx file using ExcelJS. */
export async function writeXlsx(sheet: OutputSheet): Promise<Uint8Array> {
  return writeXlsxWorkbook([sheet]);
}

/**
 * Writes several OutputSheets as the sheets of one deterministic .xlsx file, in order (e.g. the batch's summary
 * workbook: one sheet of files, one of flags). Two sheets can't share a name in Excel, so a repeated name gets " (2)".
 */
export async function writeXlsxWorkbook(sheets: readonly OutputSheet[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'formatAI';
  workbook.created = FIXED_DATE;
  workbook.modified = FIXED_DATE;
  workbook.lastPrinted = FIXED_DATE;

  const used = new Set<string>();
  for (const sheet of sheets) {
    const base = sanitizeSheetName(sheet.name);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    addSheet(workbook, { ...sheet, name });
  }

  // NOTE (see final report): ExcelJS's own StreamBuf implementation calls
  // `Buffer.from(...)` unconditionally while assembling the zip, regardless of
  // the requested output type, so `writeBuffer()` only works where a Node
  // `Buffer` global exists. We can't route around that from here (it's inside
  // ExcelJS itself); a browser Web Worker needs a `Buffer` polyfill supplied
  // by the app's bundler for this call to work at all.
  const written = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(written as unknown as ArrayBufferLike);

  return repackDeterministic(bytes);
}

/**
 * ExcelJS/JSZip stamp each zip entry with the current time unless told
 * otherwise, so the same OutputSheet would produce different bytes on every
 * run. Re-pack with a fixed date and a stable (sorted) entry order so the
 * output is byte-for-byte reproducible.
 */
async function repackDeterministic(bytes: Uint8Array): Promise<Uint8Array> {
  const src = await JSZip.loadAsync(bytes);
  const dst = new JSZip();

  const names = Object.keys(src.files).sort();
  for (const name of names) {
    const entry = src.files[name]!;
    if (entry.dir) {
      dst.file(name, null, { dir: true, date: FIXED_DATE });
      continue;
    }
    const content = await entry.async('uint8array');
    dst.file(name, content, { date: FIXED_DATE });
  }

  const out = await dst.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
  return out;
}
