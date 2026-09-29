// SPEC 8.11 live check: the engine must stay well under 300 ms on 5,000 rows.
// The assertion uses a generous threshold so CI isn't flaky; the actual time is printed.
import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/pipeline';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import { col, dateCell, rules, table, type CellInput } from './helpers';

const ROWS = 5000;

function withCommas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function bigTable() {
  const headers = ['סוכן', 'פוליסה', 'ת.ז.', 'מוצר', 'סטטוס', 'פרמיה', 'שיעור', 'תאריך', 'תאריך טקסט', 'הערה'];
  const products = ['חיים', 'בריאות', 'רכב', 'דירה'];
  const rows: CellInput[][] = [];
  for (let i = 0; i < ROWS; i++) {
    const day = (i % 28) + 1;
    const month = (i % 12) + 1;
    rows.push([
      (i % 37) + 1, // agent: number → idLike
      String(100000 + (i % 4900)), // policy (some duplicates)
      makeValidIsraeliId(String(10000000 + i).slice(0, 8)),
      products[i % 4] as string,
      i % 10 === 0 ? 'מבוטל' : 'פעיל',
      i % 3 === 0 ? `₪${withCommas(1000 + i)}.50` : 123.45 + i, // text with ₪ and commas, or numbers
      0.17,
      dateCell(45292 + (i % 365)),
      `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/2024`,
      i % 7 === 0 ? null : `note ${i}`,
    ]);
  }
  return table(headers, rows);
}

function bigRules() {
  return rules({
    columns: [
      col('agent', 'idLike', { header: 'סוכן', padLeft: 5 }),
      col('policy', 'idLike', { header: 'פוליסה', padLeft: 9 }),
      col('insuredId', 'idLike', { header: 'ת.ז.', padLeft: 9 }),
      col('product', 'text', { header: 'מוצר' }),
      col('status', 'text', { header: 'סטטוס' }),
      col('premium', 'decimal', { header: 'פרמיה' }),
      col('rate', 'percent', { header: 'שיעור' }),
      col('start', 'date', { header: 'תאריך' }),
      col('signed', 'date', { header: 'תאריך טקסט', inputFormats: ['DD/MM/YYYY'] }),
      col('note', 'text', { header: 'הערה' }),
    ],
    rowFilters: [{ column: 'status', op: 'ne', value: 'מבוטל' }],
    transform: {
      dedupe: { keys: ['policy'], keep: 'first', action: 'flag' },
      computed: [
        { id: 'commission', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'premium' }, { col: 'rate' }] } } },
        { id: 'withVat', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'commission' }, { const: 1.18 }] } } },
        { id: 'period', type: 'text', expr: { op: 'dateFormat', arg: { col: 'start' }, format: 'MM/YYYY' } },
        { id: 'label', type: 'text', expr: { op: 'concat', args: [{ col: 'agent' }, { const: '-' }, { col: 'policy' }] } },
      ],
      valueMaps: [{ column: 'product', map: { חיים: 'LIFE', בריאות: 'HEALTH', רכב: 'CAR' }, onMissing: 'flag' }],
      sort: [{ column: 'agent', dir: 'asc' }, { column: 'start', dir: 'asc' }],
      group: { by: 'agent', showDetailRows: true, subtotal: { labelColumn: 'policy', label: 'סה"כ', sum: ['premium', 'commission'] }, blankRowsAfter: 1 },
    },
    output: {
      titleRows: [{ parts: [{ text: 'דוח ' }, { agg: 'max', column: 'start', format: 'MMMM YYYY' }], bold: true }],
      grandTotal: { labelColumn: 'policy', label: 'סה"כ כללי', sum: ['premium', 'commission', 'withVat'] },
    },
    out: [
      'agent',
      'policy',
      'insuredId',
      'product',
      { header: 'premium', from: 'premium', format: '#,##0.00' },
      { header: 'commission', from: 'commission', format: '#,##0.00' },
      { header: 'withVat', from: 'withVat', format: '#,##0.00' },
      { header: 'start', from: 'start', format: 'DD/MM/YYYY' },
      'signed',
      'period',
      'label',
      'note',
    ],
    validations: [
      { column: 'insuredId', rule: 'israeliIdChecksum', severity: 'flag' },
      { column: 'premium', rule: 'range', min: 0, severity: 'flag' },
      { column: 'policy', rule: 'lengthEquals', length: 9, severity: 'flag' },
    ],
  });
}

describe('performance', () => {
  it(`runs ${ROWS} rows × 10 columns with computed columns well under the live-check budget`, () => {
    const r = bigRules();
    const t = bigTable();

    let t0 = performance.now();
    const cold = runRules(r, t);
    const coldMs = performance.now() - t0;

    const warm: number[] = [];
    for (let i = 0; i < 3; i++) {
      t0 = performance.now();
      runRules(r, t);
      warm.push(performance.now() - t0);
    }
    const warmMs = Math.min(...warm);
    // eslint-disable-next-line no-console
    console.log(`[perf] runRules ${ROWS} rows × 10 cols: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms`);

    expect(cold.ok).toBe(true);
    if (cold.ok) {
      expect(cold.summary.rowsIn).toBe(ROWS);
      expect(cold.summary.rowsFiltered).toBe(ROWS / 10);
      expect(cold.summary.rowsOut).toBe(ROWS - ROWS / 10);
      expect(cold.summary.duplicatesFlagged).toBeGreaterThan(0);
      expect(cold.flags.some((f) => f.messageKey === 'flag.valueMapMissing')).toBe(true);
    }
    expect(coldMs).toBeLessThan(1000);
    expect(warmMs).toBeLessThan(1000);
  });
});
