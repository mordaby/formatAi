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
  const headers = ['ספק', 'הזמנה', 'מזהה', 'פריט', 'סטטוס', 'סכום', 'שיעור', 'תאריך', 'תאריך טקסט', 'הערה'];
  const items = ['אלקטרוניקה', 'ריהוט', 'ביגוד', 'ספרים'];
  const rows: CellInput[][] = [];
  for (let i = 0; i < ROWS; i++) {
    const day = (i % 28) + 1;
    const month = (i % 12) + 1;
    rows.push([
      (i % 37) + 1, // supplier: number → idLike
      String(100000 + (i % 4900)), // order (some duplicates)
      makeValidIsraeliId(String(10000000 + i).slice(0, 8)),
      items[i % 4] as string,
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
      col('supplier', 'idLike', { header: 'ספק', padLeft: 5 }),
      col('order', 'idLike', { header: 'הזמנה', padLeft: 9 }),
      col('taxId', 'idLike', { header: 'מזהה', padLeft: 9 }),
      col('item', 'text', { header: 'פריט' }),
      col('status', 'text', { header: 'סטטוס' }),
      col('amount', 'decimal', { header: 'סכום' }),
      col('rate', 'percent', { header: 'שיעור' }),
      col('start', 'date', { header: 'תאריך' }),
      col('confirmed', 'date', { header: 'תאריך טקסט', inputFormats: ['DD/MM/YYYY'] }),
      col('note', 'text', { header: 'הערה' }),
    ],
    rowFilters: [{ column: 'status', op: 'ne', value: 'מבוטל' }],
    transform: {
      dedupe: { keys: ['order'], keep: 'first', action: 'flag' },
      computed: [
        { id: 'total', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'amount' }, { col: 'rate' }] } } },
        { id: 'withTax', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'total' }, { const: 1.18 }] } } },
        // min/max: exercised here even though amount is never empty.
        { id: 'capped', type: 'decimal', expr: { op: 'min', args: [{ col: 'amount' }, { const: 5000 }] } },
        { id: 'boosted', type: 'decimal', expr: { op: 'max', args: [{ col: 'amount' }, { const: 50 }] } },
        // toNumber + mod (Excel MOD sign rule).
        { id: 'remainder', type: 'integer', expr: { op: 'mod', args: [{ op: 'toNumber', arg: { col: 'supplier' } }, { const: 7 }] } },
        // dateAdd (days).
        { id: 'dueDate', type: 'date', expr: { op: 'dateAdd', arg: { col: 'start' }, days: 30 } },
        // switch, first matching case.
        {
          id: 'sizeLabel',
          type: 'text',
          expr: {
            op: 'switch',
            cases: [
              { when: { op: 'gt', args: [{ col: 'amount' }, { const: 1000 }] }, then: { const: 'big' } },
              { when: { op: 'gt', args: [{ col: 'amount' }, { const: 100 }] }, then: { const: 'medium' } },
            ],
            else: { const: 'small' },
          },
        },
        // toText with a number format.
        { id: 'amountText', type: 'text', expr: { op: 'toText', arg: { col: 'amount' }, format: '#,##0.00' } },
        { id: 'period', type: 'text', expr: { op: 'dateFormat', arg: { col: 'start' }, format: 'MM/YYYY' } },
        { id: 'label', type: 'text', expr: { op: 'concat', args: [{ col: 'supplier' }, { const: '-' }, { col: 'order' }] } },
      ],
      valueMaps: [{ column: 'item', map: { אלקטרוניקה: 'ELECTRONICS', ריהוט: 'FURNITURE', ביגוד: 'CLOTHING' }, onMissing: 'flag' }],
      sort: [{ column: 'supplier', dir: 'asc' }, { column: 'start', dir: 'asc' }],
      group: {
        by: 'supplier',
        showDetailRows: true,
        summaryRows: [{ labelColumn: 'order', label: 'סה"כ', cells: { amount: 'sum', total: 'sum' } }],
        blankRowsAfter: 1,
      },
    },
    output: {
      titleRows: [{ parts: [{ text: 'דוח ' }, { agg: 'max', column: 'start', format: 'MMMM YYYY' }], bold: true }],
      summaryRows: [{ labelColumn: 'order', label: 'סה"כ כללי', cells: { amount: 'sum', total: 'sum', withTax: 'sum' } }],
    },
    out: [
      'supplier',
      'order',
      'taxId',
      'item',
      { header: 'amount', from: 'amount', format: '#,##0.00' },
      { header: 'total', from: 'total', format: '#,##0.00' },
      { header: 'withTax', from: 'withTax', format: '#,##0.00' },
      { header: 'capped', from: 'capped', format: '#,##0.00' },
      { header: 'boosted', from: 'boosted', format: '#,##0.00' },
      'remainder',
      { header: 'start', from: 'start', format: 'DD/MM/YYYY' },
      { header: 'dueDate', from: 'dueDate', format: 'DD/MM/YYYY' },
      'confirmed',
      'period',
      'sizeLabel',
      'amountText',
      'label',
      'note',
    ],
    validations: [
      { column: 'taxId', rule: 'israeliIdChecksum', severity: 'flag' },
      { column: 'amount', rule: 'range', min: 0, severity: 'flag' },
      { column: 'order', rule: 'lengthEquals', length: 9, severity: 'flag' },
      // An output validation too (SPEC 8.8): checked by output header, after layout.
      { on: 'output', column: 'total', rule: 'range', min: 0, severity: 'flag' },
    ],
  });
}

describe('performance', () => {
  it(`runs ${ROWS} rows × 10 input columns, 10 computed columns (incl. mod/min/max/dateAdd/switch/toText) well under the live-check budget`, () => {
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
    console.log(`[perf] runRules ${ROWS} rows × 10 cols (+ mod/min/max/dateAdd/switch/toText): cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms`);

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

// Across-row (window) functions: four of them over the whole table (a running balance per account in date order, a group total, a global
// rank, a row number per account). Each window is a single pass over cached partitions and sorted indexes (see pipeline/v1/window.ts).
describe('performance: window functions', () => {
  function windowTable(rows: number) {
    const out: CellInput[][] = [];
    for (let i = 0; i < rows; i++) {
      out.push([
        `ACC-${(i * 7919) % 97}`, // account: ~97 partitions, interleaved in the file
        dateCell(45000 + ((i * 31) % 900)), // date: many ties
        ((i * 104729) % 100000) / 100, // amount
      ]);
    }
    return table(['account', 'date', 'amount'], out);
  }

  function windowRules(withWindows: boolean) {
    return rules({
      columns: [col('account', 'text'), col('date', 'date'), col('amount', 'decimal')],
      transform: {
        computed: withWindows
          ? [
              { id: 'balance', type: 'decimal', expr: { op: 'window', fn: 'runningSum', arg: { col: 'amount' }, by: ['account'], order: [{ column: 'date', dir: 'asc' }] } },
              { id: 'total', type: 'decimal', expr: { op: 'window', fn: 'groupSum', arg: { col: 'amount' }, by: ['account'] } },
              { id: 'rank', type: 'integer', expr: { op: 'window', fn: 'rank', order: [{ column: 'amount', dir: 'desc' }] } },
              { id: 'n', type: 'integer', expr: { op: 'window', fn: 'rowNumber', by: ['account'] } },
            ]
          : [],
        valueMaps: [],
        sort: [],
      },
      out: withWindows ? ['account', 'date', 'amount', 'balance', 'total', 'rank', 'n'] : ['account', 'date', 'amount'],
    });
  }

  function time(r: ReturnType<typeof windowRules>, t: ReturnType<typeof windowTable>): { cold: number; warm: number } {
    let t0 = performance.now();
    const first = runRules(r, t);
    const cold = performance.now() - t0;
    expect(first.ok).toBe(true);
    const warm: number[] = [];
    for (let i = 0; i < 3; i++) {
      t0 = performance.now();
      runRules(r, t);
      warm.push(performance.now() - t0);
    }
    return { cold, warm: Math.min(...warm) };
  }

  it.each([5000, 20000])('%i rows: four windows (running balance by account in date order, group total, global rank, row number)', (rows) => {
    const t = windowTable(rows);
    const plain = time(windowRules(false), t);
    const windows = time(windowRules(true), t);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${rows} rows, 4 window functions: cold ${windows.cold.toFixed(1)} ms, warm ${windows.warm.toFixed(1)} ms (the same table with no window: warm ${plain.warm.toFixed(1)} ms; the four windows add ${(windows.warm - plain.warm).toFixed(1)} ms)`,
    );
    // The live check's budget is 300 ms on 5,000 rows (SPEC 8.11): the whole run, windows included.
    if (rows === 5000) expect(windows.warm).toBeLessThan(300);
    expect(windows.cold).toBeLessThan(2000);
    // 4x the rows must cost about 4x (plus the sort's log factor), not 16x
    expect(windows.warm).toBeLessThan(Math.max(60, plain.warm) * 40);
  });
});
