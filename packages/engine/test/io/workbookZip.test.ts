import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readZip, writeZip } from '../../src/io/zip';
import { writeXlsxWorkbook } from '../../src/io/writeXlsx';
import type { OutputSheet } from '../../src/types';

function sheet(name: string, cell: string): OutputSheet {
  return {
    name,
    direction: 'ltr',
    language: 'en',
    columns: [{ header: 'A', width: 10 }],
    rows: [
      { kind: 'header', cells: [{ v: 'A' }], bold: true },
      { kind: 'data', cells: [{ v: cell }] },
    ],
    merges: [],
  };
}

describe('writeXlsxWorkbook', () => {
  it('writes every sheet in order, and gives a repeated name a suffix', async () => {
    const bytes = await writeXlsxWorkbook([sheet('Files', 'one'), sheet('Flags', 'two'), sheet('files', 'three')]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Files', 'Flags', 'files (2)']);
    expect(wb.worksheets.map((w) => w.getRow(2).getCell(1).value)).toEqual(['one', 'two', 'three']);
  });

  it('is deterministic', async () => {
    const a = await writeXlsxWorkbook([sheet('Files', 'x'), sheet('Flags', 'y')]);
    const b = await writeXlsxWorkbook([sheet('Files', 'x'), sheet('Flags', 'y')]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('writeZip / readZip', () => {
  it('round-trips files in folders, in order, byte for byte', async () => {
    const enc = new TextEncoder();
    const zip = await writeZip([
      { path: 'Format A/one (converted).csv', bytes: enc.encode('a,b\n1,2\n') },
      { path: 'summary.xlsx', bytes: new Uint8Array([1, 2, 3]).buffer },
    ]);
    const back = await readZip(zip);
    expect(back.map((e) => e.path)).toEqual(['Format A/one (converted).csv', 'summary.xlsx']);
    expect(new TextDecoder().decode(back[0]!.bytes as Uint8Array)).toBe('a,b\n1,2\n');
    expect(Array.from(back[1]!.bytes as Uint8Array)).toEqual([1, 2, 3]);
    const again = await writeZip([
      { path: 'Format A/one (converted).csv', bytes: enc.encode('a,b\n1,2\n') },
      { path: 'summary.xlsx', bytes: new Uint8Array([1, 2, 3]).buffer },
    ]);
    expect(Buffer.from(again).equals(Buffer.from(zip))).toBe(true);
  });
});
