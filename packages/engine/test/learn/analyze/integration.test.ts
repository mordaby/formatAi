import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../../../src/io/read';
import { writeXlsx } from '../../../src/io/writeXlsx';
import type { OutCell, OutRow, OutputSheet } from '../../../src/types';
import { ymdToSerial } from '../../../src/values/dates';
import { padLeft } from '../../../src/values/text';
import { analyzeOk, best, rng, xlsx, type V } from './helpers';

function sheetOf(name: string, direction: 'rtl' | 'ltr', headers: string[], rows: OutRow[], merges: OutputSheet['merges'] = []): OutputSheet {
  return {
    name,
    direction,
    language: direction === 'rtl' ? 'he' : 'en',
    columns: headers.map((h) => ({ header: h, width: 14 })),
    rows,
    merges,
  };
}

const c = (v: string | number | null, extra: Partial<OutCell> = {}): OutCell => ({ v, ...extra });

describe('end to end through the xlsx writer and reader', () => {
  it('a Hebrew RTL report: merged bold title with the month, bold header, subtotals, grand total', async () => {
    const headers = ['סוכן', 'מספר', 'תאריך', 'סכום'];
    const data: [string, number, number, number][] = [];
    const r = rng(5);
    for (const agent of ['אבי', 'דנה', 'יוסי']) {
      for (let i = 0; i < 3; i++) {
        data.push([agent, 1000 + data.length * 11, ymdToSerial({ y: 2024, m: 9, d: 2 + data.length }), Math.round(r() * 5000) / 100]);
      }
    }
    const inRows: OutRow[] = [
      { kind: 'header', cells: headers.map((h) => c(h)) },
      ...data.map((d): OutRow => ({ kind: 'data', cells: [c(d[0]), c(d[1]), c(d[2], { isDate: true, z: 'dd/mm/yyyy' }), c(d[3])] })),
    ];
    const outRows: OutRow[] = [
      { kind: 'title', bold: true, cells: [c('דוח עמלות ספטמבר 2024', { bold: true }), c(null), c(null), c(null)] },
      { kind: 'blank', cells: [c(null), c(null), c(null), c(null)] },
      { kind: 'header', bold: true, cells: ['סוכן', 'מספר', 'תאריך', 'סכום'].map((h) => c(h, { bold: true })) },
    ];
    let total = 0;
    for (const agent of ['אבי', 'דנה', 'יוסי']) {
      let sub = 0;
      for (const d of data.filter((x) => x[0] === agent)) {
        outRows.push({ kind: 'data', cells: [c(d[0]), c(padLeft(String(d[1]), 6, '0')), c(d[2], { isDate: true, z: 'dd/mm/yyyy' }), c(d[3], { z: '#,##0.00' })] });
        sub = Math.round((sub + d[3]) * 100) / 100;
      }
      total = Math.round((total + sub) * 100) / 100;
      outRows.push({ kind: 'subtotal', bold: true, cells: [c('סה"כ לסוכן', { bold: true }), c(null), c(null), c(sub, { bold: true, z: '#,##0.00' })] });
      outRows.push({ kind: 'blank', cells: [c(null), c(null), c(null), c(null)] });
    }
    outRows.push({ kind: 'grandTotal', bold: true, cells: [c('סה"כ', { bold: true }), c(null), c(null), c(total, { bold: true, z: '#,##0.00' })] });

    const inBytes = await writeXlsx(sheetOf('נתונים', 'rtl', headers, inRows));
    const outBytes = await writeXlsx(sheetOf('דוח', 'rtl', headers, outRows, [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }]));
    const a = analyzeOk(await readWorkbook(inBytes, 'in.xlsx'), await readWorkbook(outBytes, 'out.xlsx'));

    expect(a.output.headerRow).toBe(2);
    expect(a.output.dataRows).toHaveLength(9);
    expect(a.layout).toMatchObject({ direction: 'rtl', language: 'he', sheetName: 'דוח', headerBold: true, file: { type: 'xlsx' } });
    expect(a.layout.titleRows[0]).toMatchObject({
      text: 'דוח עמלות ספטמבר 2024',
      bold: true,
      containsDate: { in: 2, agg: 'min', format: 'MMMM YYYY' },
    });
    expect(a.layout.titleRows[1]).toEqual({ row: 1, blank: true });
    expect(a.layout.groupBy).toMatchObject({
      out: 0,
      blankRowsAfter: 1,
      summaryRows: [{ label: 'סה"כ לסוכן', labelOut: 0, bold: true, cells: [{ out: 3, agg: 'sum' }] }],
    });
    expect(a.layout.summaryRows).toMatchObject([{ label: 'סה"כ', labelOut: 0, cells: [{ out: 3, agg: 'sum' }] }]);
    expect(a.layout.columnFormats[3]).toBe('#,##0.00');
    expect(best(a, 1)).toMatchObject({ rel: 'padLeft', in: [1], length: 6 });
    expect(best(a, 2)).toMatchObject({ rel: 'copy', in: [2] });
    expect(best(a, 3)).toMatchObject({ rel: 'copy', in: [3] });
  });
});

describe('no false summary rows in flat data', () => {
  it('rows equal to a running average, with an optional empty cell, stay data rows', () => {
    const input: V[][] = [['Ref', 'Qty', 'Note']];
    const r = rng(17);
    for (let i = 0; i < 3000; i++) input.push([`R${i}`, 1 + Math.floor(r() * 9), r() < 0.08 ? null : `n${i}`]);
    const a = analyzeOk(xlsx(input), xlsx(input.map((x) => [...x])));
    expect(a.output.rowKinds.filter((k) => k !== 'data' && k !== 'header')).toEqual([]);
    expect(a.output.dataRows).toHaveLength(3000);
    expect(a.identical).toBe(true);
  });
});
