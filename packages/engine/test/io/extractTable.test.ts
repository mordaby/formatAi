import { describe, expect, it } from 'vitest';
import { extractTable } from '../../src/io/extractTable';
import type { RawCell, RawSheet, RawWorkbook } from '../../src/types';

function row(...vals: (string | number | boolean | null)[]): (RawCell | null)[] {
  return vals.map((v) => (v === null ? null : { v }));
}

function sheet(name: string, rows: (RawCell | null)[][], overrides: Partial<RawSheet> = {}): RawSheet {
  return { name, rows, merges: [], hiddenRows: [], hiddenCols: [], colWidths: [], ...overrides };
}

function wb(sheets: RawSheet[], overrides: Partial<RawWorkbook> = {}): RawWorkbook {
  return { fileType: 'xlsx', sheets, ...overrides };
}

describe('extractTable', () => {
  it('extracts headers, rows and 1-based row numbers from the first sheet by default', () => {
    // DECISION: 100/150/80 rather than 100/200/300 -- the latter would make
    // the last row's value equal the sum of the earlier ones, which
    // detectTable's (correct) sums-row-footer heuristic would then exclude.
    const book = wb([
      sheet('נתונים', [
        row('שם', 'סכום'),
        row('דנה', 100),
        row('יוסי', 150),
        row('נועה', 80),
      ]),
    ]);

    const result = extractTable(book, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.sheetName).toBe('נתונים');
    expect(result.table.headers).toEqual(['שם', 'סכום']);
    expect(result.table.rowNumbers).toEqual([2, 3, 4]);
    expect(result.table.rows).toHaveLength(3);
    expect(result.table.rows[0]).toEqual(row('דנה', 100));
  });

  it('picks a sheet by name', () => {
    const book = wb([
      sheet('Other', [row('x'), row(1), row(2), row(3)]),
      sheet('Target', [row('a', 'b'), row(1, 2), row(3, 4), row(5, 6)]),
    ]);
    const result = extractTable(book, { sheet: { pick: 'name', name: 'Target' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.sheetName).toBe('Target');
    expect(result.table.headers).toEqual(['a', 'b']);
  });

  it('picks a sheet by index', () => {
    const book = wb([
      sheet('First', [row('x'), row(1), row(2), row(3)]),
      sheet('Second', [row('a', 'b'), row(1, 2), row(3, 4), row(5, 6)]),
    ]);
    const result = extractTable(book, { sheet: { pick: 'index', index: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.sheetName).toBe('Second');
  });

  it('returns sheetNotFound when the named sheet does not exist', () => {
    const book = wb([sheet('Only', [row('a'), row(1), row(2), row(3)])]);
    const result = extractTable(book, { sheet: { pick: 'name', name: 'Missing' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ code: 'sheetNotFound', params: { name: 'Missing' } });
  });

  it('stringifies numeric and boolean header cells', () => {
    // The header row must still be "mostly text" to be detected at all, so
    // only one of its four cells is numeric/boolean.
    const book = wb([
      sheet('S', [
        row('שם', 'סכום', 'שנה', true),
        row('a', 1, 2024, false),
        row('b', 2, 2023, true),
        row('c', 3, 2022, false),
      ]),
    ]);
    const result = extractTable(book, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.headers).toEqual(['שם', 'סכום', 'שנה', 'TRUE']);
  });

  it('uses an explicit headerRow instead of auto-detection', () => {
    const book = wb([
      sheet('S', [row('note'), row('שם', 'סכום'), row('א', 10), row('ב', 15), row('ג', 8)]),
    ]);
    const result = extractTable(book, { headerRow: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.headers).toEqual(['שם', 'סכום']);
    expect(result.table.rowNumbers).toEqual([3, 4, 5]);
  });

  it('stops before the first row matching stopAt.values (quote/geresh normalized)', () => {
    const book = wb([
      sheet('S', [
        row('שם', 'סכום'),
        row('א', 1),
        row('ב', 2),
        row('ג', 3),
        row('סה״כ', 6), // gershayim variant of סה"כ
        row('extra after stop', 0),
      ]),
    ]);
    const result = extractTable(book, {
      stopAt: { when: 'firstCellMatches', values: ['סה"כ'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toHaveLength(3);
    expect(result.table.rowNumbers).toEqual([2, 3, 4]);
  });

  it('returns noTable when detectTable rejects the sheet', () => {
    const book = wb([sheet('S', [row(1), row(2)])]);
    const result = extractTable(book, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('noTable');
    expect(result.detection?.ok).toBe(false);
  });
});
