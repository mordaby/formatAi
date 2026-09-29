// Builds the input fixture files for the M0 golden tests (SPEC 18/19).
//
// Run once (or whenever a case's input needs to change) with:
//   pnpm --filter @formatai/api exec tsx ../../packages/engine/test/golden/build-inputs.ts
//
// The generated files are committed alongside each case's rules.json and
// expected.json (golden.test.ts reads them from disk; it never regenerates
// them). Every value here is chosen by hand to match the arithmetic worked
// out in each case's expected.json -- nothing here is derived by running the
// engine.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, 'cases');

function casePath(name: string, file: string): string {
  return path.join(casesDir, name, file);
}

async function writeXlsxFile(name: string, file: string, build: (wb: ExcelJS.Workbook) => void): Promise<void> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const buf = await wb.xlsx.writeBuffer();
  fs.writeFileSync(casePath(name, file), Buffer.from(buf as unknown as ArrayBufferLike));
}

function writeUtf8Csv(name: string, file: string, lines: string[]): void {
  const text = lines.map((l) => `${l}\r\n`).join('');
  fs.writeFileSync(casePath(name, file), Buffer.from(text, 'utf-8'));
}

/**
 * Encodes `text` as Windows-1255 bytes. Supports plain ASCII (identical to its
 * code point) plus the Hebrew alphabet block U+05D0-U+05EA, which Windows-1255
 * maps linearly onto bytes 0xE0-0xFA (confirmed against the existing
 * `readWorkbook` fixture in test/io/read.test.ts: "שלום" -> [0xf9,0xec,0xe5,0xed]).
 */
function encodeWindows1255(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp >= 0x05d0 && cp <= 0x05ea) {
      bytes.push(0xe0 + (cp - 0x05d0));
    } else {
      throw new Error(`encodeWindows1255: unsupported character U+${cp.toString(16)}`);
    }
  }
  return new Uint8Array(bytes);
}

function writeWindows1255Csv(name: string, file: string, lines: string[]): void {
  const text = lines.map((l) => `${l}\r\n`).join('');
  fs.writeFileSync(casePath(name, file), Buffer.from(encodeWindows1255(text)));
}

function dateCell(ws: ExcelJS.Worksheet, row: number, col: number, serial: number, fmt = 'dd/mm/yyyy'): void {
  const cell = ws.getRow(row).getCell(col);
  cell.value = serial;
  cell.numFmt = fmt;
}

// ---------------------------------------------------------------------------
// Case 1: he-commissions-report
// ---------------------------------------------------------------------------
async function buildHeCommissionsReport(): Promise<void> {
  await writeXlsxFile('he-commissions-report', 'input.xlsx', (wb) => {
    const ws = wb.addWorksheet('דוח', { views: [{ rightToLeft: true }] });

    ws.getRow(1).getCell(1).value = 'דוח עמלות - חברה לדוגמה בע"מ';
    ws.getRow(2).getCell(1).value = 'לשימוש פנימי בלבד';

    const header = ws.getRow(3);
    ['מספר סוכן', "מס' פוליסה", 'ת.ז. מבוטח', 'מוצר', 'סטטוס', 'פרמיה', 'תאריך תחילה', 'הערות'].forEach(
      (h, i) => (header.getCell(i + 1).value = h),
    );

    type R = [number | string, number | string, number | string | null, string, string, number, number, string | null];
    const rows: R[] = [
      [12, 1234567, 123456782, 'חיים', 'פעיל', 1000, 45519, 'x'], // row 4
      [7, 555, 123456789, 'בריאות', 'פעיל', 250.5, 45537, null], // row 5: bad checksum
      [12, 1234567, 123456782, 'רכב', 'פעיל', 100, 45536, null], // row 6: duplicate policy, unmapped product
      [7, 999, 123456782, 'חיים', 'מבוטל', 5000, 45538, null], // row 7: filtered out
      [12, 42, null, 'בריאות', ' פעיל', -50, 45493, null], // row 8: negative premium
      [3, '310000010', 123456782, 'חיים', 'פעיל', 359.5, 45545, null], // row 9: rounding half-case
      [3, '320000020', 123456782, 'בריאות', 'פעיל', 500, 45509, null], // row 10
    ];
    rows.forEach((r, i) => {
      const excelRow = 4 + i;
      const row = ws.getRow(excelRow);
      row.getCell(1).value = r[0];
      row.getCell(2).value = r[1];
      if (r[2] !== null) row.getCell(3).value = r[2];
      row.getCell(4).value = r[3];
      row.getCell(5).value = r[4];
      row.getCell(6).value = r[5];
      dateCell(ws, excelRow, 7, r[6]);
      if (r[7] !== null) row.getCell(8).value = r[7];
    });

    // Footer row: trimmed off by detectTable before the rules ever see it.
    ws.getRow(11).getCell(1).value = 'סה"כ';
    ws.getRow(11).getCell(6).value = 2160;
  });
}

// ---------------------------------------------------------------------------
// Case 2: en-rename-reorder (CSV, plain UTF-8, no BOM)
// ---------------------------------------------------------------------------
function buildEnRenameReorder(): void {
  writeUtf8Csv('en-rename-reorder', 'input.csv', [
    'Policy No,Client Name,Amount,Effective Date,Region',
    '00123,Dana Cohen,"1,234.56",05/03/2024,North',
    '00456,Yossi Levi,₪500.00,12/07/2024,South',
    '00789,Noa Bar,(200.00),25/12/2024,North',
    '01011,Omer Katz,999.99,01/01/2024,East',
    '01212,Maya Gil,"10,000",15/06/2024,South',
    '01313,Eli Peretz,"2,750.00",30/04/2024,East',
    '01414,Shira Adar,-75.25,19/09/2024,North',
    '01515,Tomer Ben,0.00,10/10/2024,South',
  ]);
}

// ---------------------------------------------------------------------------
// Case 3: dedupe-columns-to-rows
// ---------------------------------------------------------------------------
async function buildDedupeColumnsToRows(): Promise<void> {
  await writeXlsxFile('dedupe-columns-to-rows', 'input.xlsx', (wb) => {
    const ws = wb.addWorksheet('Data');
    const header = ws.getRow(1);
    ['ID', 'Name', 'Jan', 'Feb', 'Mar'].forEach((h, i) => (header.getCell(i + 1).value = h));

    type R = [number, string, number | null, number | null, number | null];
    const rows: R[] = [
      [1, 'Alice', 100, 200, 300], // row 2
      [2, 'Bob', 150, null, 250], // row 3
      [1, 'Alice', 100, 200, 300], // row 4: exact duplicate of row 2 (kept: keep "last")
      [3, 'Carol', null, 400, null], // row 5
      [4, 'Dave', 500, 500, 500], // row 6
      [2, 'Bob', 150, null, 250], // row 7: exact duplicate of row 3 (kept)
      [5, 'Erin', 0, 0, 0], // row 8: zeros are not empty
      [6, 'Frank', 700, null, null], // row 9
    ];
    rows.forEach((r, i) => {
      const row = ws.getRow(2 + i);
      row.getCell(1).value = r[0];
      row.getCell(2).value = r[1];
      if (r[2] !== null) row.getCell(3).value = r[2];
      if (r[3] !== null) row.getCell(4).value = r[3];
      if (r[4] !== null) row.getCell(5).value = r[4];
    });
  });
}

// ---------------------------------------------------------------------------
// Case 4: split-cell-csv-out
// ---------------------------------------------------------------------------
async function buildSplitCellCsvOut(): Promise<void> {
  await writeXlsxFile('split-cell-csv-out', 'input.xlsx', (wb) => {
    const ws = wb.addWorksheet('Data');
    const header = ws.getRow(1);
    ['סוכן', 'פוליסה', 'מוצרים', 'סכום', 'הערות'].forEach((h, i) => (header.getCell(i + 1).value = h));

    type R = [string, string, string, number, string | null];
    const rows: R[] = [
      ['A1', 'P100', 'חיים; בריאות', 300, 'רגיל, בסדר'], // row 2
      ['A2', 'P200', 'חיים', -100, '-הערה מיוחדת'], // row 3
      ['A3', 'P300', 'חיים; בריאות; רכב', 310, '=נוסחה'], // row 4
      ['A4', 'P400', 'בריאות', 99.99, null], // row 5
      ['A5', 'P500', 'חיים; רכב', 0, '0 בסדר'], // row 6
      ['A6', 'P600', 'בריאות; חיים; רכב; דירה', 500, 'חלק "מיוחד"'], // row 7
    ];
    rows.forEach((r, i) => {
      const row = ws.getRow(2 + i);
      row.getCell(1).value = r[0];
      row.getCell(2).value = r[1];
      row.getCell(3).value = r[2];
      row.getCell(4).value = r[3];
      if (r[4] !== null) row.getCell(5).value = r[4];
    });
  });
}

// ---------------------------------------------------------------------------
// Case 5: fixed-fan-out-debit-credit
// ---------------------------------------------------------------------------
async function buildFixedFanOutDebitCredit(): Promise<void> {
  await writeXlsxFile('fixed-fan-out-debit-credit', 'input.xlsx', (wb) => {
    const ws = wb.addWorksheet('יומן', { views: [{ rightToLeft: true }] });
    const header = ws.getRow(1);
    ['סוכן', 'פוליסה', 'סכום', 'תאריך'].forEach((h, i) => (header.getCell(i + 1).value = h));

    type R = [string, number, number, number];
    const rows: R[] = [
      ['עוסק א', 1001, 1000, 45413], // row 2
      ['עוסק ב', 1002, 250.75, 45414], // row 3
      ['עוסק א', 1003, -300, 45415], // row 4
      ['עוסק ג', 1004, 0, 45416], // row 5
      ['עוסק ב', 1005, 87.5, 45417], // row 6
    ];
    rows.forEach((r, i) => {
      const excelRow = 2 + i;
      const row = ws.getRow(excelRow);
      row.getCell(1).value = r[0];
      row.getCell(2).value = r[1];
      row.getCell(3).value = r[2];
      dateCell(ws, excelRow, 4, r[3]);
    });
  });
}

// ---------------------------------------------------------------------------
// Case 6: summary-by-agent
// ---------------------------------------------------------------------------
async function buildSummaryByAgent(): Promise<void> {
  await writeXlsxFile('summary-by-agent', 'input.xlsx', (wb) => {
    const ws = wb.addWorksheet('Data');
    const header = ws.getRow(1);
    ['Agent', 'Client', 'Amount', 'Date'].forEach((h, i) => (header.getCell(i + 1).value = h));

    type R = [string, string, number, number];
    const rows: R[] = [
      ['Agent A', 'C1', 100, 45301], // row 2: 2024-01-10
      ['Agent B', 'C2', 200, 45306], // row 3: 2024-01-15
      ['Agent A', 'C3', 150, 45323], // row 4: 2024-02-01
      ['Agent A', 'C4', 50, 45296], // row 5: 2024-01-05
      ['Agent C', 'C5', 300, 45352], // row 6: 2024-03-01
      ['Agent B', 'C6', 75, 45342], // row 7: 2024-02-20
      ['Agent A', 'C7', 200, 45366], // row 8: 2024-03-15
      ['Agent C', 'C8', 120, 45316], // row 9: 2024-01-25
      ['Agent B', 'C9', 90, 45361], // row 10: 2024-03-10
      ['Agent C', 'C10', 60, 45336], // row 11: 2024-02-14
    ];
    rows.forEach((r, i) => {
      const excelRow = 2 + i;
      const row = ws.getRow(excelRow);
      row.getCell(1).value = r[0];
      row.getCell(2).value = r[1];
      row.getCell(3).value = r[2];
      dateCell(ws, excelRow, 4, r[3], 'yyyy-mm-dd');
    });
  });
}

// ---------------------------------------------------------------------------
// Case 7: win1255-csv-rename (Windows-1255 encoded CSV input)
// ---------------------------------------------------------------------------
function buildWin1255CsvRename(): void {
  writeWindows1255Csv('win1255-csv-rename', 'input.csv', [
    'שם,סכום',
    'דנה,100',
    'יוסי,250.5',
    'רותם,75',
    'אבי,0',
    'מיכל,-30',
  ]);
}

async function main(): Promise<void> {
  await buildHeCommissionsReport();
  buildEnRenameReorder();
  await buildDedupeColumnsToRows();
  await buildSplitCellCsvOut();
  await buildFixedFanOutDebitCredit();
  await buildSummaryByAgent();
  buildWin1255CsvRename();
  console.log('Golden test inputs written.');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
