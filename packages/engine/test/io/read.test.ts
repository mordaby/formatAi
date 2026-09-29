import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { UnsupportedFileTypeError, detectCsvEncoding, detectDelimiter, readWorkbook } from '../../src/io/read';
import { writeDelimited } from '../../src/io/writeDelimited';
import type { OutputSheet } from '../../src/types';

async function buildXlsxFixture(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('נתונים', { views: [{ rightToLeft: true }] });

  ws.getColumn(1).width = 15;
  ws.getColumn(2).width = 22;
  ws.getColumn(2).hidden = true;

  // Row 1: title, merged across A1:D1, bold.
  ws.getRow(1).getCell(1).value = 'כותרת הדוח';
  ws.mergeCells('A1:D1');
  ws.getRow(1).getCell(1).font = { bold: true };

  // Row 2: header, bold.
  const header = ws.getRow(2);
  header.getCell(1).value = 'שם';
  header.getCell(2).value = 'סוד';
  header.getCell(3).value = 'סכום';
  header.getCell(4).value = 'תאריך';
  header.eachCell((cell) => {
    cell.font = { bold: true };
  });

  // Row 3: data (numeric + formula + date).
  const r3 = ws.getRow(3);
  r3.getCell(1).value = 'דנה';
  r3.getCell(2).value = 'x';
  r3.getCell(3).value = { formula: '10+20', result: 30 } as unknown as number;
  r3.getCell(4).value = 43831; // 2020-01-01
  r3.getCell(4).numFmt = 'dd/mm/yyyy';

  // Row 4: data, hidden row.
  const r4 = ws.getRow(4);
  r4.getCell(1).value = 'יוסי';
  r4.getCell(2).value = 'y';
  r4.getCell(3).value = 250.5;
  r4.getCell(3).numFmt = '#,##0.00';
  r4.getCell(4).value = 43832;
  r4.getCell(4).numFmt = 'dd/mm/yyyy';
  r4.hidden = true;

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as unknown as ArrayBufferLike);
}

describe('readWorkbook - xlsx', () => {
  it('reads values, formats, dates, bold, merges, RTL, hidden rows/cols and widths', async () => {
    const bytes = await buildXlsxFixture();
    const wb = await readWorkbook(bytes, 'report.xlsx');

    expect(wb.fileType).toBe('xlsx');
    expect(wb.sheets).toHaveLength(1);
    const sheet = wb.sheets[0]!;
    expect(sheet.name).toBe('נתונים');

    // RTL sheet-view flag (SPEC 6.1 direction).
    expect(sheet.rightToLeft).toBe(true);

    // Merge A1:D1.
    expect(sheet.merges).toContainEqual({ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } });

    // Bold via ExcelJS overlay.
    expect(sheet.rows[0]![0]?.bold).toBe(true);
    expect(sheet.rows[1]![0]?.bold).toBe(true);
    expect(sheet.rows[2]![0]?.bold).toBeFalsy();

    // Formula cell: cached value only, no formula text leaks into `v`.
    expect(sheet.rows[2]![2]?.v).toBe(30);

    // Date cells: serial number + isDate, not a JS Date.
    const dateCell = sheet.rows[2]![3]!;
    expect(dateCell.v).toBe(43831);
    expect(dateCell.isDate).toBe(true);
    expect(typeof dateCell.v).toBe('number');

    // Number format preserved.
    expect(sheet.rows[3]![2]?.z).toBe('#,##0.00');

    // Hidden row/col.
    expect(sheet.hiddenRows).toContain(3); // 0-based row index 3 = Excel row 4
    expect(sheet.hiddenCols).toContain(1); // 0-based col index 1 = column B

    // Column widths in character units. Excel's stored width is a font-metric
    // approximation, so ExcelJS's write -> SheetJS's read round trip is close
    // but not pixel-exact; just check they're in the right ballpark and ordered.
    expect(sheet.colWidths[0]).toBeGreaterThan(10);
    expect(sheet.colWidths[0]).toBeLessThan(18);
    expect(sheet.colWidths[1]).toBeGreaterThan(sheet.colWidths[0]!);
  });

  it('throws a typed error for unsupported file extensions', async () => {
    await expect(readWorkbook(new Uint8Array([1, 2, 3]), 'report.pdf')).rejects.toBeInstanceOf(
      UnsupportedFileTypeError
    );
    await expect(readWorkbook(new Uint8Array([1, 2, 3]), 'no-extension')).rejects.toBeInstanceOf(
      UnsupportedFileTypeError
    );
  });
});

describe('readWorkbook - csv', () => {
  function toBytes(parts: number[]): Uint8Array {
    return new Uint8Array(parts);
  }

  it('reads plain UTF-8 csv, keeping every cell as a string with leading zeros', async () => {
    const text = 'id,name\n007,Dana\n042,Yossi\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'input.csv');

    expect(wb.fileType).toBe('csv');
    expect(wb.encoding).toBe('utf-8');
    expect(wb.sheets[0]!.name).toBe('input');
    expect(wb.sheets[0]!.rows).toEqual([
      [{ v: 'id' }, { v: 'name' }],
      [{ v: '007' }, { v: 'Dana' }],
      [{ v: '042' }, { v: 'Yossi' }],
    ]);
  });

  it('detects a UTF-8 BOM and strips it', async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\n1,2\n')]);
    const wb = await readWorkbook(withBom, 'input.csv');
    expect(wb.encoding).toBe('utf-8-bom');
    expect(wb.sheets[0]!.rows[0]).toEqual([{ v: 'a' }, { v: 'b' }]);
  });

  it('falls back to windows-1255 for non-UTF-8 bytes and decodes Hebrew correctly', async () => {
    // "שלום" in windows-1255.
    const heb1255 = toBytes([0xf9, 0xec, 0xe5, 0xed]);
    const bytes = new Uint8Array([...toBytes([0x61, 0x2c]), ...heb1255, 0x0a]); // "a," + heb + "\n"
    const detected = detectCsvEncoding(bytes);
    expect(detected).toBe('windows-1255');

    const wb = await readWorkbook(bytes, 'input.csv');
    expect(wb.encoding).toBe('windows-1255');
    expect(wb.sheets[0]!.rows[0]![1]?.v).toBe('שלום');
  });

  it('parses quoted fields with embedded newlines and commas', async () => {
    const text = 'a,b\n"line1\nline2","x,y"\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'input.csv');
    expect(wb.sheets[0]!.rows[1]).toEqual([{ v: 'line1\nline2' }, { v: 'x,y' }]);
  });

  it('detects a semicolon delimiter', async () => {
    const text = 'a;b\n1;2\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'input.csv');
    expect(wb.sheets[0]!.rows).toEqual([
      [{ v: 'a' }, { v: 'b' }],
      [{ v: '1' }, { v: '2' }],
    ]);
  });

  it('names the sheet after the file', async () => {
    const bytes = new TextEncoder().encode('a\n1\n');
    const wb = await readWorkbook(bytes, 'Ledger 2024.csv');
    expect(wb.sheets[0]!.name).toBe('Ledger 2024');
  });

  it('sets wb.delimiter on the returned workbook', async () => {
    const bytes = new TextEncoder().encode('a,b\n1,2\n');
    const wb = await readWorkbook(bytes, 'input.csv');
    expect(wb.delimiter).toBe(',');
  });
});

describe('readWorkbook - txt (delimited text)', () => {
  it('accepts .txt as delimited text, same path as .csv', async () => {
    const bytes = new TextEncoder().encode('id,name\n007,Dana\n');
    const wb = await readWorkbook(bytes, 'input.txt');
    expect(wb.fileType).toBe('txt');
    expect(wb.sheets[0]!.rows[0]).toEqual([{ v: 'id' }, { v: 'name' }]);
  });

  it('reads a tab-delimited .txt file', async () => {
    const text = 'id\tname\tamount\r\n007\tDana\t100\r\n042\tYossi\t200\r\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'load.txt');
    expect(wb.fileType).toBe('txt');
    expect(wb.delimiter).toBe('\t');
    expect(wb.sheets[0]!.rows).toEqual([
      [{ v: 'id' }, { v: 'name' }, { v: 'amount' }],
      [{ v: '007' }, { v: 'Dana' }, { v: '100' }],
      [{ v: '042' }, { v: 'Yossi' }, { v: '200' }],
    ]);
  });

  it('reads a pipe-delimited .txt file', async () => {
    const text = 'a|b|c\n1|2|3\n4|5|6\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'load.txt');
    expect(wb.delimiter).toBe('|');
    expect(wb.sheets[0]!.rows).toEqual([
      [{ v: 'a' }, { v: 'b' }, { v: 'c' }],
      [{ v: '1' }, { v: '2' }, { v: '3' }],
      [{ v: '4' }, { v: '5' }, { v: '6' }],
    ]);
  });

  it('csv with quoted fields containing the delimiter still parses correctly', async () => {
    const text = 'a,b\n"1,2",3\n"4,5",6\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'input.csv');
    expect(wb.delimiter).toBe(',');
    expect(wb.sheets[0]!.rows[1]).toEqual([{ v: '1,2' }, { v: '3' }]);
  });
});

describe('detectDelimiter', () => {
  it('is quote-aware: a quoted field containing a comma does not fool tab detection', () => {
    const text = '"a,b"\tc\td\n1\t2\t3\n4\t5\t6\n7\t8\t9\n';
    expect(detectDelimiter(text)).toBe('\t');
  });

  it('samples several lines rather than only the first', () => {
    // First line only has one field (no delimiter at all); the real delimiter
    // only shows up from the second line on.
    const text = 'header\n1;2;3\n4;5;6\n7;8;9\n';
    expect(detectDelimiter(text)).toBe(';');
  });

  it('defaults to comma when nothing else matches', () => {
    expect(detectDelimiter('justonefield\nanother\n')).toBe(',');
  });
});

describe('readWorkbook - Windows-1255 round trip', () => {
  it('writeDelimited(encoding: "windows1255") -> readWorkbook decodes the same text back', async () => {
    const sheet: OutputSheet = {
      name: 'S',
      direction: 'rtl',
      language: 'he',
      columns: [{ header: 'שם' }, { header: 'הערה' }],
      rows: [
        { kind: 'header', cells: [{ v: 'שם' }, { v: 'הערה' }] },
        { kind: 'data', cells: [{ v: 'שלום עולם' }, { v: 'טקסט "מצוטט", עם פסיק' }] },
      ],
      merges: [],
    };
    const bytes = writeDelimited(sheet, { type: 'csv', encoding: 'windows1255' });

    const wb = await readWorkbook(bytes, 'roundtrip.csv');
    expect(wb.encoding).toBe('windows-1255');
    expect(wb.sheets[0]!.rows[0]).toEqual([{ v: 'שם' }, { v: 'הערה' }]);
    expect(wb.sheets[0]!.rows[1]).toEqual([{ v: 'שלום עולם' }, { v: 'טקסט "מצוטט", עם פסיק' }]);
  });
});
