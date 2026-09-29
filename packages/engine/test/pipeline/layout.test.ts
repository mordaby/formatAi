// Value maps (7), sort (8), group (9), output layout (10).
import { describe, expect, it } from 'vitest';
import { formatNumberText } from '../../src/pipeline/v1/layout';
import Decimal from 'decimal.js';
import { ymdToSerial } from '../../src/values/dates';
import { body, col, dataRows, dateCell, rules, runOk, table, values } from './helpers';

const serial = (y: number, m: number, d: number) => ymdToSerial({ y, m, d });

describe('valueMaps', () => {
  const columns = [col('product', 'text'), col('k')];
  const t = table(['product', 'k'], [['חיים', 1], [' בריאות ', 2], ['רכב', 3], [null, 4]]);

  it('onMissing "flag" keeps the value and flags it; lookup is after normalizeText', () => {
    const res = runOk(
      rules({ columns, transform: { valueMaps: [{ column: 'product', map: { חיים: 'LIFE', בריאות: 'HEALTH' }, onMissing: 'flag' }] } }),
      t,
    );
    expect(values(res.sheet).map((x) => x[0])).toEqual(['LIFE', 'HEALTH', 'רכב', null]);
    expect(res.flags).toEqual([
      { rowNumber: 4, column: 'product', rule: 'valueMap', value: 'רכב', messageKey: 'flag.valueMapMissing' },
    ]);
    expect(dataRows(res.sheet)[2]!.cells[0]!.flagged).toBe(true);
  });

  it('onMissing "keep" keeps the value silently', () => {
    const res = runOk(
      rules({ columns, transform: { valueMaps: [{ column: 'product', map: { חיים: 'LIFE' }, onMissing: 'keep' }] } }),
      t,
    );
    expect(values(res.sheet).map((x) => x[0])).toEqual(['LIFE', ' בריאות ', 'רכב', null]);
    expect(res.flags).toEqual([]);
  });

  it('maps numbers by their text', () => {
    const res = runOk(
      rules({ columns: [col('code', 'decimal')], transform: { valueMaps: [{ column: 'code', map: { '1': 'one', '2.5': 'two and a half' }, onMissing: 'keep' }] } }),
      table(['code'], [[1], ['2.50'], [3]]),
    );
    expect(values(res.sheet)).toEqual([['one'], ['two and a half'], [3]]);
  });
});

describe('sort', () => {
  it('is stable, typed, with empties last in both directions', () => {
    const columns = [col('name'), col('n', 'decimal'), col('d', 'date')];
    const t = table(
      ['name', 'n', 'd'],
      [
        ['b', 10, dateCell(serial(2024, 2, 1))], // 2
        ['a', 9, null], // 3
        [null, 100, dateCell(serial(2023, 12, 31))], // 4
        ['B', 10, dateCell(serial(2024, 1, 1))], // 5
        ['a', null, dateCell(serial(2024, 2, 1))], // 6
      ],
    );
    const order = (sort: { column: string; dir: 'asc' | 'desc' }[]) =>
      dataRows(runOk(rules({ columns, transform: { sort } }), t).sheet).map((r) => r.sourceRow);

    // numeric, not textual: 9 < 10 < 100; ties (rows 2 and 5) keep input order
    expect(order([{ column: 'n', dir: 'asc' }])).toEqual([3, 2, 5, 4, 6]);
    expect(order([{ column: 'n', dir: 'desc' }])).toEqual([4, 2, 5, 3, 6]);
    // text by code point after normalizeText ('B' < 'a' < 'b'), empties last
    expect(order([{ column: 'name', dir: 'asc' }])).toEqual([5, 3, 6, 2, 4]);
    expect(order([{ column: 'name', dir: 'desc' }])).toEqual([2, 3, 6, 5, 4]);
    // by date
    expect(order([{ column: 'd', dir: 'asc' }])).toEqual([4, 5, 2, 6, 3]);
    // several keys
    expect(order([{ column: 'd', dir: 'desc' }, { column: 'name', dir: 'asc' }])).toEqual([6, 2, 5, 4, 3]);
  });

  it('idLike text sorts as text', () => {
    const res = runOk(
      rules({ columns: [col('id', 'idLike', { padLeft: 3 })], transform: { sort: [{ column: 'id', dir: 'asc' }] } }),
      table(['id'], [[12], [3], ['100']]),
    );
    expect(values(res.sheet)).toEqual([['003'], ['012'], ['100']]);
  });
});

describe('group', () => {
  const columns = [col('customer', 'idLike'), col('item', 'idLike'), col('amount', 'decimal'), col('note', 'text')];
  const t = table(
    ['customer', 'item', 'amount', 'note'],
    [
      [2, 'p1', 100, 'x'], // 2
      [1, 'p2', 50.5, 'y'], // 3
      [2, 'p3', 25, null], // 4
      [1, 'p4', 'oops', 'z'], // 5
      [3, 'p5', 10, 'w'], // 6
    ],
  );
  const out = [
    { header: 'לקוח', from: 'customer' },
    { header: 'פריט', from: 'item' },
    { header: 'סכום', from: 'amount', format: '#,##0.00' },
  ];

  it('detail rows, subtotals, blank rows and a grand total', () => {
    const r = rules({
      columns,
      transform: {
        sort: [{ column: 'customer', dir: 'asc' }],
        group: { by: 'customer', showDetailRows: true, subtotal: { labelColumn: 'item', label: 'סה"כ ללקוח', sum: ['amount'] }, blankRowsAfter: 1 },
      },
      output: { grandTotal: { labelColumn: 'item', label: 'סה"כ', sum: ['amount'] } },
      out,
    });
    const res = runOk(r, t);
    expect(body(res.sheet)).toEqual([
      ['data', '1', 'p2', 50.5],
      ['data', '1', 'p4', 'oops'],
      ['subtotal', null, 'סה"כ ללקוח', 50.5],
      ['blank', null, null, null],
      ['data', '2', 'p1', 100],
      ['data', '2', 'p3', 25],
      ['subtotal', null, 'סה"כ ללקוח', 125],
      ['blank', null, null, null],
      ['data', '3', 'p5', 10],
      ['subtotal', null, 'סה"כ ללקוח', 10],
      ['blank', null, null, null],
      ['grandTotal', null, 'סה"כ', 185.5],
    ]);
    const sub = res.sheet.rows.find((x) => x.kind === 'subtotal')!;
    expect(sub.cells[2]).toEqual({ v: 50.5, z: '#,##0.00' });
    expect(res.summary.rowsOut).toBe(5);
  });

  it('without a grand total, no trailing blank rows are written', () => {
    const r = rules({
      columns,
      transform: { sort: [{ column: 'customer', dir: 'asc' }], group: { by: 'customer', showDetailRows: true, blankRowsAfter: 2 } },
      out,
    });
    const kinds = body(runOk(r, t).sheet).map((x) => x[0]);
    expect(kinds).toEqual(['data', 'data', 'blank', 'blank', 'data', 'data', 'blank', 'blank', 'data']);
  });

  it('non-contiguous keys are gathered by first appearance', () => {
    const r = rules({
      columns,
      transform: { group: { by: 'customer', showDetailRows: true, subtotal: { labelColumn: 'customer', label: 'Total', sum: ['amount'] } } },
      out,
    });
    expect(body(runOk(r, t).sheet)).toEqual([
      ['data', '2', 'p1', 100],
      ['data', '2', 'p3', 25],
      ['subtotal', 'Total', null, 125],
      ['data', '1', 'p2', 50.5],
      ['data', '1', 'p4', 'oops'],
      ['subtotal', 'Total', null, 50.5],
      ['data', '3', 'p5', 10],
      ['subtotal', 'Total', null, 10],
    ]);
  });

  it('summary output: one row per group with sum/count/min/max/first', () => {
    const r = rules({
      columns,
      transform: { sort: [{ column: 'customer', dir: 'desc' }], group: { by: 'customer', showDetailRows: false } },
      output: { grandTotal: { labelColumn: 'customer', label: 'Total', sum: ['amount', 'item'] } },
      out: [
        { header: 'customer', from: 'customer', agg: 'first' },
        { header: 'sum', from: 'amount', agg: 'sum', format: '0.00' },
        { header: 'count', from: 'item', agg: 'count' },
        { header: 'rows', from: 'note', agg: 'count' },
        { header: 'min', from: 'item', agg: 'min' },
        { header: 'max', from: 'amount', agg: 'max' },
        { header: 'note', from: 'note' },
      ],
    });
    const res = runOk(r, t);
    expect(body(res.sheet)).toEqual([
      ['data', '3', 10, 1, 1, 'p5', 10, 'w'],
      ['data', '2', 125, 2, 1, 'p1', 100, 'x'],
      ['data', '1', 50.5, 2, 2, 'p2', 'oops', 'y'],
      ['grandTotal', 'Total', 185.5, 5, null, null, null, null],
    ]);
    expect(dataRows(res.sheet).map((x) => x.sourceRow)).toEqual([6, 2, 3]);
    expect(res.sheet.columns.map((c) => c.numeric === true)).toEqual([false, true, true, true, false, true, false]);
    // the group containing the unparsed amount is highlighted in the aggregated cell
    expect(dataRows(res.sheet)[2]!.cells[1]!.flagged).toBe(true);
    expect(res.summary.rowsOut).toBe(3);
  });
});

describe('output layout', () => {
  const columns = [col('d', 'date'), col('amount', 'decimal'), col('id', 'idLike', { padLeft: 9 })];
  const t = table(
    ['d', 'amount', 'id'],
    [
      [dateCell(serial(2024, 8, 20)), 1234.5, 40217763],
      [dateCell(serial(2024, 9, 3)), -7, 1],
      [dateCell(serial(2024, 7, 31)), 0, 2],
    ],
  );

  it('title rows (text, blank, parts with MMMM YYYY in he), merged; header; cell encoding', () => {
    const r = rules({
      columns,
      output: {
        sheetName: 'דוח עמלות',
        direction: 'rtl',
        language: 'he',
        titleRows: [
          { parts: [{ text: 'דוח עמלות ' }, { agg: 'max', column: 'd', format: 'MMMM YYYY' }], bold: true },
          { text: 'מ-' },
          { blank: true },
          { parts: [{ agg: 'min', column: 'd', format: 'DD/MM/YYYY' }, { text: ' – ' }, { agg: 'max', column: 'amount', format: '#,##0.00' }] },
        ],
        headerStyle: { bold: true },
      },
      out: [
        { header: 'תאריך', from: 'd', format: 'DD/MM/YYYY', width: 12 },
        { header: 'סכום', from: 'amount', format: '#,##0.00' },
        { header: 'ת.ז.', from: 'id', format: '@' },
        { header: 'ריק', from: null },
      ],
    });
    const res = runOk(r, t);
    const s = res.sheet;
    expect(s.name).toBe('דוח עמלות');
    expect(s.direction).toBe('rtl');
    expect(s.language).toBe('he');
    expect(s.rows.slice(0, 5).map((x) => [x.kind, x.cells[0]!.v, x.bold === true])).toEqual([
      ['title', 'דוח עמלות ספטמבר 2024', true],
      ['title', 'מ-', false],
      ['blank', null, false],
      ['title', '31/07/2024 – 1,234.50', false],
      ['header', 'תאריך', true],
    ]);
    expect(s.rows[0]!.cells).toHaveLength(4);
    expect(s.rows[0]!.cells[0]!.bold).toBe(true);
    expect(s.merges).toEqual([
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
      { s: { r: 3, c: 0 }, e: { r: 3, c: 3 } },
    ]);
    expect(s.rows[4]!.cells.map((c) => c.v)).toEqual(['תאריך', 'סכום', 'ת.ז.', 'ריק']);
    expect(s.columns).toEqual([
      { header: 'תאריך', width: 12, format: 'dd/mm/yyyy' },
      { header: 'סכום', format: '#,##0.00', numeric: true },
      { header: 'ת.ז.', format: '@' },
      { header: 'ריק' },
    ]);
    expect(s.rows[5]).toEqual({
      kind: 'data',
      sourceRow: 2,
      cells: [
        { v: serial(2024, 8, 20), isDate: true, z: 'dd/mm/yyyy', text: '20/08/2024' },
        { v: 1234.5, z: '#,##0.00' },
        { v: '040217763', z: '@' },
        { v: null },
      ],
    });
  });

  it('title month in English, Hebrew month-name formats get the [$-40D] prefix', () => {
    const mk = (language: 'he' | 'en') =>
      rules({
        columns,
        output: { language, direction: language === 'he' ? 'rtl' : 'ltr', titleRows: [{ parts: [{ text: 'Report ' }, { agg: 'max', column: 'd', format: 'MMMM YYYY' }] }] },
        out: [{ header: 'month', from: 'd', format: 'MMMM YYYY' }],
      });
    const en = runOk(mk('en'), t).sheet;
    expect(en.rows[0]!.cells[0]!.v).toBe('Report September 2024');
    expect(en.direction).toBe('ltr');
    expect(dataRows(en)[0]!.cells[0]).toEqual({ v: serial(2024, 8, 20), isDate: true, z: 'mmmm yyyy', text: 'August 2024' });
    const he = runOk(mk('he'), t).sheet;
    expect(he.rows[0]!.cells[0]!.v).toBe('Report ספטמבר 2024');
    expect(dataRows(he)[0]!.cells[0]).toEqual({ v: serial(2024, 8, 20), isDate: true, z: '[$-40D]mmmm yyyy', text: 'אוגוסט 2024' });
  });

  it('a title aggregate over no rows is empty; dates without a date format use DD/MM/YYYY', () => {
    const r = rules({
      columns,
      rowFilters: [{ column: 'amount', op: 'gt', value: 1e9 }],
      output: { titleRows: [{ parts: [{ text: 'Report ' }, { agg: 'max', column: 'd', format: 'MMMM YYYY' }] }] },
      out: [{ header: 'd', from: 'd' }],
    });
    const res = runOk(r, t);
    expect(res.sheet.rows[0]!.cells[0]!.v).toBe('Report ');
    expect(res.sheet.columns[0]!.format).toBe('dd/mm/yyyy');
  });

  it('formatNumberText', () => {
    expect(formatNumberText(new Decimal('1234567.125'), '#,##0.00')).toBe('1,234,567.13');
    expect(formatNumberText(new Decimal('-1234.5'), '#,##0')).toBe('-1,235');
    expect(formatNumberText(new Decimal('0.175'), '0.0%')).toBe('17.5%');
    expect(formatNumberText(new Decimal('12.5'), 'General')).toBe('12.5');
  });

  describe('output.file (SPEC 8.13)', () => {
    it('is absent from OutputSheet when the rules declare none (xlsx by default)', () => {
      const res = runOk(rules({ columns: [col('x')] }), table(['x'], [['a']]));
      expect(res.sheet.file).toBeUndefined();
      expect(Object.hasOwn(res.sheet, 'file')).toBe(false);
    });

    it('is copied onto OutputSheet.file exactly as declared', () => {
      const res = runOk(
        rules({ columns: [col('x')], output: { file: { type: 'csv', delimiter: ';', header: false, encoding: 'windows1255', quote: 'all' } } }),
        table(['x'], [['a']]),
      );
      expect(res.sheet.file).toEqual({ type: 'csv', delimiter: ';', header: false, encoding: 'windows1255', quote: 'all' });
    });

    it('a bare { type: "txt" } is copied as-is (writeOutput/writeDelimited own the defaults)', () => {
      const res = runOk(rules({ columns: [col('x')], output: { file: { type: 'txt' } } }), table(['x'], [['a']]));
      expect(res.sheet.file).toEqual({ type: 'txt' });
    });
  });
});
