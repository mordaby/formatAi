// A file SheetJS reads but ExcelJS cannot load (ExcelJS is far stricter: a shared formula it can't place, some drawings)
// is read without ExcelJS's extras, never reported as damaged.
import * as XLSX from 'xlsx';
import { describe, expect, it, vi } from 'vitest';

vi.mock('exceljs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('exceljs')>();
  class Workbook {
    xlsx = {
      load: async (): Promise<never> => {
        throw new Error('Shared Formula master must exist above and or left of clone for cell "B3"');
      },
    };
    eachSheet(): void {}
  }
  return { ...mod, default: { ...mod.default, Workbook }, Workbook };
});

const { readWorkbook } = await import('../../src/io/read');

describe('readWorkbook: ExcelJS cannot load the file', () => {
  it('still reads every value with SheetJS', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Order', 'Amount'],
      ['A-1', 10],
      ['A-2', 20.5],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

    const read = await readWorkbook(bytes, 'orders november.xlsx');

    expect(read.fileType).toBe('xlsx');
    expect(read.sheets[0]!.name).toBe('Orders');
    expect(read.sheets[0]!.rows.map((r) => r.map((c) => c?.v ?? null))).toEqual([
      ['Order', 'Amount'],
      ['A-1', 10],
      ['A-2', 20.5],
    ]);
  });
});
