import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../../src/io/read';
import { writeXlsx } from '../../src/io/writeXlsx';
import type { OutputSheet } from '../../src/types';

function makeSheet(overrides: Partial<OutputSheet> = {}): OutputSheet {
  return {
    name: 'דוח',
    direction: 'rtl',
    language: 'he',
    columns: [
      { header: 'שם', width: 20 },
      { header: 'סכום', width: 12, format: '#,##0.00', numeric: true },
      { header: 'תאריך', width: 12, format: 'dd/mm/yyyy' },
    ],
    rows: [
      {
        kind: 'header',
        cells: [{ v: 'שם' }, { v: 'סכום' }, { v: 'תאריך' }],
        bold: true,
      },
      {
        kind: 'data',
        sourceRow: 2,
        cells: [{ v: 'דנה' }, { v: 100.5 }, { v: 43831, isDate: true, z: 'dd/mm/yyyy' }],
      },
      {
        kind: 'data',
        sourceRow: 3,
        cells: [
          { v: 'יוסי' },
          { v: 200, flagged: true },
          { v: 43832, isDate: true, z: 'dd/mm/yyyy' },
        ],
      },
    ],
    merges: [],
    ...overrides,
  };
}

async function readBack(bytes: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

describe('writeXlsx', () => {
  it('sets the RTL sheet view, widths and per-column number formats', async () => {
    const bytes = await writeXlsx(makeSheet());
    const wb = await readBack(bytes);
    const ws = wb.worksheets[0]!;

    expect(ws.views?.[0]?.rightToLeft).toBe(true);
    expect(ws.getColumn(1).width).toBe(20);
    expect(ws.getColumn(2).width).toBe(12);

    // Data row: numeric column format falls back to the column's format.
    expect(ws.getRow(2).getCell(2).numFmt).toBe('#,##0.00');
    expect(ws.getRow(2).getCell(3).numFmt).toBe('dd/mm/yyyy');

    // Dates must be stored as plain Excel serials, not native dates: read the
    // bytes back with our own SheetJS-based reader (cellDates:false) to check
    // the raw stored value rather than ExcelJS's on-read Date reinterpretation.
    const raw = await readWorkbook(bytes, 'out.xlsx');
    const dateRawCell = raw.sheets[0]!.rows[1]![2];
    expect(dateRawCell?.v).toBe(43831);
    expect(dateRawCell?.isDate).toBe(true);
  });

  it('writes an LTR sheet view when direction is ltr', async () => {
    const bytes = await writeXlsx(makeSheet({ direction: 'ltr' }));
    const wb = await readBack(bytes);
    expect(wb.worksheets[0]!.views?.[0]?.rightToLeft).toBe(false);
  });

  it('marks the header row bold and flagged cells with a fill', async () => {
    const bytes = await writeXlsx(makeSheet());
    const wb = await readBack(bytes);
    const ws = wb.worksheets[0]!;

    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true);
    const flaggedCell = ws.getRow(3).getCell(2);
    expect(flaggedCell.fill).toMatchObject({ type: 'pattern', pattern: 'solid' });
    const nonFlaggedCell = ws.getRow(2).getCell(2);
    // Any styled cell gets a fill entry in the style table; an un-flagged cell's
    // is the default "no fill" pattern, never 'solid'.
    expect((nonFlaggedCell.fill as ExcelJS.FillPattern | undefined)?.pattern).not.toBe('solid');
  });

  it('writes text values as literal strings, never as formulas', async () => {
    const sheet = makeSheet({
      rows: [
        { kind: 'header', cells: [{ v: 'note' }] },
        { kind: 'data', sourceRow: 2, cells: [{ v: '=SUM(A1:A2)' }] },
      ],
      columns: [{ header: 'note' }],
    });
    const bytes = await writeXlsx(sheet);
    const wb = await readBack(bytes);
    const cell = wb.worksheets[0]!.getRow(2).getCell(1);
    expect(cell.formula).toBeUndefined();
    expect(cell.value).toBe('=SUM(A1:A2)');
    expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
  });

  it('writes merged ranges', async () => {
    const sheet = makeSheet({
      rows: [
        { kind: 'title', cells: [{ v: 'כותרת' }, { v: null }, { v: null }] },
        { kind: 'header', cells: [{ v: 'שם' }, { v: 'סכום' }, { v: 'תאריך' }] },
        { kind: 'data', sourceRow: 2, cells: [{ v: 'דנה' }, { v: 1 }, { v: 43831 }] },
      ],
      merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
    });
    const bytes = await writeXlsx(sheet);
    const wb = await readBack(bytes);
    expect(wb.worksheets[0]!.model.merges).toContain('A1:C1');
  });

  it('sanitizes sheet names over 31 chars and with invalid characters', async () => {
    const sheet = makeSheet({ name: 'a/very:long*sheet[name]that?goes\\way over 31 characters' });
    const bytes = await writeXlsx(sheet);
    const wb = await readBack(bytes);
    const name = wb.worksheets[0]!.name;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });

  it('produces byte-identical output across repeated writes (determinism)', async () => {
    const sheet = makeSheet();
    const first = await writeXlsx(sheet);
    const second = await writeXlsx(makeSheet()); // fresh object graph, same content
    expect(first.length).toBe(second.length);
    expect(Array.from(first)).toEqual(Array.from(second));
  });
});
