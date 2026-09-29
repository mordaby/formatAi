import { describe, expect, it } from 'vitest';
import { detectTable, nonEmptySheets } from '../../src/io/detectTable';
import type { CellRange, RawCell, RawSheet, RawWorkbook } from '../../src/types';

function row(...vals: (string | number | boolean | null)[]): (RawCell | null)[] {
  return vals.map((v) => (v === null ? null : { v }));
}

function dateCell(v: number): RawCell {
  return { v, isDate: true, z: 'dd/mm/yyyy' };
}

function sheet(rows: (RawCell | null)[][], overrides: Partial<RawSheet> = {}): RawSheet {
  return {
    name: 'Sheet1',
    rows,
    merges: [],
    hiddenRows: [],
    hiddenCols: [],
    colWidths: [],
    ...overrides,
  };
}

describe('detectTable - header/title/footer (input mode)', () => {
  it('finds the header row after title rows', () => {
    const s = sheet([
      row('דוח מכירות חודשי', null, null),
      row('שם', 'סכום', 'תאריך'),
      row('דנה', 100, dateCell(43831).v as number),
      row('יוסי', 200, dateCell(43832).v as number),
      row('נועה', 300, dateCell(43833).v as number),
    ]);

    const d = detectTable(s);
    expect(d.ok).toBe(true);
    expect(d.headerRow).toBe(1);
    expect(d.titleRows).toEqual([0]);
    expect(d.dataStart).toBe(2);
    expect(d.dataEnd).toBe(4);
    expect(d.footerRows).toEqual([]);
  });

  it('excludes a סה"כ footer row', () => {
    // DECISION: values are deliberately not an arithmetic progression, so no
    // prefix sum coincidentally matches another row's own value.
    const s = sheet([
      row('שם', 'סכום'),
      row('א', 10),
      row('ב', 15),
      row('ג', 8),
      row('סה"כ', 33),
    ]);

    const d = detectTable(s);
    expect(d.ok).toBe(true);
    expect(d.dataStart).toBe(1);
    expect(d.dataEnd).toBe(3);
    expect(d.footerRows).toEqual([4]);
  });

  it('excludes an unlabeled sums-row footer', () => {
    const s = sheet([
      row('שם', 'סכום'),
      row('א', 10),
      row('ב', 15),
      row('ג', 8),
      row('', 33), // no label, but 33 == 10+15+8
    ]);

    const d = detectTable(s);
    expect(d.ok).toBe(true);
    expect(d.dataEnd).toBe(3);
    expect(d.footerRows).toEqual([4]);
  });

  it('treats a "Total" footer the same as סה"כ', () => {
    const s = sheet([row('Name', 'Amount'), row('A', 10), row('B', 20), row('Total', 30)]);
    const d = detectTable(s);
    expect(d.ok).toBe(true);
    expect(d.footerRows).toEqual([3]);
  });
});

describe('detectTable - input mode rejections', () => {
  it('rejects noHeaderRow when nothing looks like a header', () => {
    const s = sheet([row(1), row(2), row(3), row(4)]);
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([{ code: 'noHeaderRow', severity: 'reject' }]);
  });

  it('rejects mergedHeader when a merge touches the header row', () => {
    const s = sheet(
      [row('שם', 'סכום', 'תאריך'), row('א', 1, 1), row('ב', 2, 2), row('ג', 3, 3)],
      { merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }] as CellRange[] }
    );
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([
      { code: 'mergedHeader', severity: 'reject', params: { row: 1, fromCol: 'A', toCol: 'B' } },
    ]);
  });

  it('rejects splitHeader for a two-row header', () => {
    const s = sheet([
      row('קבוצה א', 'קבוצה ב', 'קבוצה ג'),
      row('שם', 'סכום', 'תאריך'),
      row('א', 1, 1),
      row('ב', 2, 2),
    ]);
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues.map((i) => i.code)).toEqual(['splitHeader']);
  });

  it('rejects tooFewDataRows when fewer than 2 real data rows remain', () => {
    const s = sheet([row('שם', 'סכום'), row('א', 10), row('סה"כ', 10)]);
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([{ code: 'tooFewDataRows', severity: 'reject' }]);
  });

  it('rejects multipleTables for two stacked tables separated by a blank row', () => {
    const s = sheet([
      row('שם', 'סכום'),
      row('א', 1),
      row('ב', 2),
      row('ג', 3),
      row(null, null),
      row('שם2', 'סכום2'),
      row('ד', 4),
    ]);
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([{ code: 'multipleTables', severity: 'reject' }]);
  });

  it('rejects multipleTables for two side-by-side blocks separated by an empty column', () => {
    const s = sheet([
      row('שם', 'סכום', null, 'שם2', 'סכום2'),
      row('א', 1, null, 'ד', 4),
      row('ב', 2, null, 'ה', 5),
      row('ג', 3, null, 'ו', 6),
    ]);
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([{ code: 'multipleTables', severity: 'reject' }]);
  });

  it('rejects onlyDrawings for an empty sheet that has drawings/charts', () => {
    const s = sheet([], { hasDrawings: true });
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([{ code: 'onlyDrawings', severity: 'reject' }]);
  });

  it('rejects emptySheet for a sheet with no content and no drawings', () => {
    const s = sheet([row(null, null), row(null, null)]);
    const d = detectTable(s);
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([{ code: 'emptySheet', severity: 'reject' }]);
  });

  it('adds a hiddenRowsOrCols notice without blocking the table', () => {
    const s = sheet(
      [row('שם', 'סכום'), row('א', 1), row('ב', 2), row('ג', 3)],
      { hiddenRows: [2] }
    );
    const d = detectTable(s);
    expect(d.ok).toBe(true);
    expect(d.issues).toEqual([{ code: 'hiddenRowsOrCols', severity: 'notice' }]);
  });
});

describe('detectTable - direction', () => {
  it('uses the sheet rightToLeft flag when present (true)', () => {
    const s = sheet([row('Name', 'Amount'), row('A', 1), row('B', 2), row('C', 3)], {
      rightToLeft: true,
    });
    expect(detectTable(s).direction).toBe('rtl');
  });

  it('uses the sheet rightToLeft flag when present (false)', () => {
    const s = sheet([row('שם', 'סכום'), row('א', 1), row('ב', 2), row('ג', 3)], {
      rightToLeft: false,
    });
    expect(detectTable(s).direction).toBe('ltr');
  });

  it('infers rtl from a Hebrew-majority header when no flag is present', () => {
    const s = sheet([row('שם', 'סכום', 'תאריך'), row('א', 1, 1), row('ב', 2, 2), row('ג', 3, 3)]);
    expect(detectTable(s).direction).toBe('rtl');
  });

  it('infers ltr from an English-majority header when no flag is present', () => {
    const s = sheet([row('Name', 'Amount', 'Date'), row('A', 1, 1), row('B', 2, 2), row('C', 3, 3)]);
    expect(detectTable(s).direction).toBe('ltr');
  });
});

describe('detectTable - output mode', () => {
  it('is loose about blank/subtotal rows between data', () => {
    const s = sheet([
      row('שם', 'סכום'),
      row('א', 1),
      row('ב', 2),
      row(null, null),
      row('סה"כ קבוצה', 3),
      row('ג', 10),
      row('ד', 20),
    ]);
    const d = detectTable(s, { mode: 'output' });
    expect(d.ok).toBe(true);
    expect(d.headerRow).toBe(0);
    expect(d.dataStart).toBe(1);
    expect(d.dataEnd).toBe(6); // last non-empty row, nothing stripped/rejected
    expect(d.footerRows).toEqual([]);
  });

  it('still rejects when there is no header at all', () => {
    const s = sheet([row(1), row(2)]);
    const d = detectTable(s, { mode: 'output' });
    expect(d.ok).toBe(false);
    expect(d.issues).toEqual([{ code: 'noHeaderRow', severity: 'reject' }]);
  });
});

describe('detectTable - headerRow override', () => {
  it('uses the explicit header row instead of searching', () => {
    const s = sheet([
      row('note', null),
      row('שם', 'סכום'),
      row('א', 1),
      row('ב', 2),
      row('ג', 3),
    ]);
    const d = detectTable(s, { headerRow: 1 });
    expect(d.ok).toBe(true);
    expect(d.headerRow).toBe(1);
  });
});

describe('nonEmptySheets', () => {
  it('lists indices of sheets with content or drawings, skipping empty ones', () => {
    const wb: RawWorkbook = {
      fileType: 'xlsx',
      sheets: [
        sheet([row('a', 'b'), row(1, 2)]),
        sheet([row(null, null)]), // empty
        sheet([row(null, null)], { hasDrawings: true }), // chart-only sheet still counts
      ],
    };
    expect(nonEmptySheets(wb)).toEqual([0, 2]);
  });
});
