import { limits, type LearnResult, type Rules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { runRules, SUPPORTED_SCHEMA_VERSIONS } from '../../src/pipeline';
import { ymdToSerial } from '../../src/values/dates';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import specExample from '../../../shared/test/fixtures/rules-example.json';
import { body, col, dateCell, rules, runOk, table, values } from './helpers';

const serial = (y: number, m: number, d: number) => ymdToSerial({ y, m, d });
const VALID_ID = makeValidIsraeliId('04021776');

// The SPEC 8.1 example rules, run on a small commission file with every trap in it.
const SPEC_RULES = specExample as unknown as Rules;
const specTable = () =>
  table(
    ['סוכן', 'מס׳ פוליסה', 'ת.ז. מבוטח', 'מוצר', 'סטטוס', 'פרמיה', 'תאריך תחילה', 'הערות'],
    [
      [12, 1234567, VALID_ID, 'חיים', 'פעיל', '1,000.00', '15/08/2024', 'x'], // 2
      [7, '555', '123456789', 'בריאות', 'פעיל', 250.5, dateCell(serial(2024, 9, 2)), null], // 3: bad checksum
      [12, '1234567', VALID_ID, 'רכב', 'פעיל', 100, '01/09/2024', null], // 4: duplicate policy, unmapped product
      [7, 999, VALID_ID, 'חיים', 'מבוטל', 5000, '03/09/2024', null], // 5: filtered out
      [12, 42, null, 'בריאות', ' פעיל', '(10)', 45500, null], // 6: negative premium, serial date
    ],
  );

describe('runRules: the SPEC 8.1 example end to end', () => {
  it('produces the expected sheet, flags and summary', () => {
    const res = runOk(SPEC_RULES, specTable(), { fileName: 'עמלות-09.xlsx' });
    const s = res.sheet;
    expect(s.name).toBe('דוח עמלות');
    expect(s.direction).toBe('rtl');
    expect(s.rows.slice(0, 3).map((r) => [r.kind, r.cells[0]!.v, r.bold === true])).toEqual([
      ['title', 'דוח עמלות ספטמבר 2024', true],
      ['blank', null, false],
      ['header', 'סוכן', true],
    ]);
    // idLike agents sort as text: "12" < "7"; within an agent by start date.
    expect(body(s)).toEqual([
      ['data', '12', '000000042', 'HEALTH', serial(2024, 7, 27), -10, -1.7],
      ['data', '12', '001234567', 'LIFE', serial(2024, 8, 15), 1000, 170],
      ['data', '12', '001234567', 'רכב', serial(2024, 9, 1), 100, 17],
      ['subtotal', null, 'סה"כ לסוכן', null, null, 1090, 185.3],
      ['blank', null, null, null, null, null, null],
      ['data', '7', '000000555', 'HEALTH', serial(2024, 9, 2), 250.5, 42.59],
      ['subtotal', null, 'סה"כ לסוכן', null, null, 250.5, 42.59],
      ['blank', null, null, null, null, null, null],
      ['grandTotal', null, 'סה"כ', null, null, 1340.5, 227.89],
    ]);
    expect(s.columns).toEqual([
      { header: 'סוכן', width: 10 },
      { header: 'פוליסה', width: 12 },
      { header: 'מוצר' },
      { header: 'תאריך תחילה', format: 'dd/mm/yyyy' },
      { header: 'פרמיה', format: '#,##0.00', numeric: true },
      { header: 'עמלה', format: '#,##0.00', numeric: true },
    ]);
    expect(s.merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }]);
    expect(res.flags).toEqual([
      { fileName: 'עמלות-09.xlsx', rowNumber: 3, column: 'insuredId', rule: 'israeliIdChecksum', value: '123456789', messageKey: 'flag.validation.israeliIdChecksum' },
      { fileName: 'עמלות-09.xlsx', rowNumber: 4, column: 'policy', rule: 'dedupe', value: '001234567', messageKey: 'flag.duplicateOf', params: { duplicateOf: 2 } },
      { fileName: 'עמלות-09.xlsx', rowNumber: 4, column: 'product', rule: 'valueMap', value: 'רכב', messageKey: 'flag.valueMapMissing' },
      { fileName: 'עמלות-09.xlsx', rowNumber: 6, column: 'premium', rule: 'range', value: -10, messageKey: 'flag.validation.range', params: { min: 0 } },
      // SPEC 8.1's third validation is an output one (`on: "output"`, column "עמלה"
      // = the commission output header): row 6's commission is also negative.
      { fileName: 'עמלות-09.xlsx', rowNumber: 6, column: 'עמלה', rule: 'range', value: -1.7, messageKey: 'flag.validation.range', params: { min: 0 } },
    ]);
    expect(res.summary).toEqual({
      rowsIn: 5,
      rowsOut: 4,
      rowsFiltered: 1,
      duplicatesRemoved: [],
      duplicatesFlagged: 1,
      blockedRows: [],
    });
    // flagged cells: row 4's policy (duplicate) and product (unmapped)
    const row4 = s.rows.find((r) => r.sourceRow === 4)!;
    expect(row4.cells.map((c) => c.flagged === true)).toEqual([false, true, true, false, false, false]);
  });

  it('is deterministic: two runs are deep-equal and serialize identically', () => {
    const a = runRules(SPEC_RULES, specTable(), { fileName: 'f.xlsx' });
    const b = runRules(structuredClone(SPEC_RULES), specTable(), { fileName: 'f.xlsx' });
    expect(b).toStrictEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('does not mutate the rules or the table', () => {
    const r = structuredClone(SPEC_RULES);
    const t = specTable();
    const before = JSON.stringify([r, t]);
    runRules(r, t);
    expect(JSON.stringify([r, t])).toBe(before);
  });
});

describe('runRules: rules validation and versions', () => {
  const ok = rules({ columns: [col('a')] });
  const t = table(['a'], [['x']]);
  const invalid = (r: unknown) => {
    const res = runRules(r as LearnResult, t);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error.code).toBe('invalidRules');
    return res.error.params;
  };

  it('accepts a LearnResult and a saved Rules (with name + meta)', () => {
    expect(runRules(ok, t).ok).toBe(true);
    expect(runRules({ ...ok, name: 'n', meta: { source: 'examplePair', status: 'draft' } } as Rules, t).ok).toBe(true);
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([1]);
  });

  it('rejects schema violations', () => {
    expect(invalid({ ...ok, output: { ...ok.output, columns: [] } })).toMatchObject({ reason: 'schema', path: 'output.columns' });
    expect(invalid({ ...ok, extra: 1 })).toMatchObject({ reason: 'schema' });
    expect(invalid({ ...ok, name: 'n' })).toMatchObject({ reason: 'schema' }); // name without meta
    expect(
      invalid({ ...ok, transform: { ...ok.transform, computed: [{ id: 'c', type: 'text', expr: { op: 'eval', arg: { const: '1' } } }] } }),
    ).toMatchObject({ reason: 'schema' });
    expect(invalid(null)).toMatchObject({ reason: 'unknownVersion' });
    expect(invalid({ ...ok, schemaVersion: 2 })).toMatchObject({ reason: 'unknownVersion' });
  });

  it('rejects checkRules problems: unknown references, excess depth, duplicate ids', () => {
    expect(
      invalid({ ...ok, transform: { ...ok.transform, computed: [{ id: 'c', type: 'text', expr: { col: 'nope' } }] } }),
    ).toMatchObject({ reason: 'reference', path: 'transform.computed[0].expr' });
    // SPEC 8.3 (v3): depth 8 per expression (config, limits.rules.maxExprDepth);
    // wrap one more time than the limit allows so this stays correct however
    // that config is tuned.
    let deep: unknown = { col: 'a' };
    for (let i = 0; i <= limits.rules.maxExprDepth; i++) deep = { op: 'trim', arg: deep };
    expect(invalid({ ...ok, transform: { ...ok.transform, computed: [{ id: 'c', type: 'text', expr: deep }] } })).toMatchObject({
      reason: 'depth',
    });
    expect(invalid({ ...ok, input: { ...ok.input, columns: [col('a'), col('a')] } })).toMatchObject({ reason: 'duplicateId' });
  });
});

describe('decimal arithmetic and rounding vs Excel', () => {
  it('xlsx doubles are read as Excel shows them, then rounded like Excel ROUND', () => {
    const r = rules({
      columns: [col('x', 'decimal')],
      transform: {
        computed: [
          { id: 'r2', type: 'decimal', expr: { op: 'round', digits: 2, arg: { col: 'x' } } },
          { id: 'r0', type: 'decimal', expr: { op: 'round', digits: 0, arg: { col: 'x' } } },
          { id: 'vat', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'x' }, { const: 1.17 }] } } },
        ],
      },
      out: ['x', 'r2', 'r0', 'vat'],
    });
    const res = runOk(r, table(['x'], [[2.675], [-1.005], [1234.5], [0.1 + 0.2], [1.015], ['8.345'], [-0.5]]));
    expect(values(res.sheet)).toEqual([
      [2.675, 2.68, 3, 3.13], // ROUND(2.675,2)=2.68; 2.675*1.17=3.12975
      [-1.005, -1.01, -1, -1.18], // -1.17585
      [1234.5, 1234.5, 1235, 1444.37], // 1444.365 → 1444.37
      [0.3, 0.3, 0, 0.35], // 0.351
      [1.015, 1.02, 1, 1.19], // 1.18755
      [8.345, 8.35, 8, 9.76], // 9.76365
      [-0.5, -0.5, -1, -0.59], // ROUND(-0.5,0) = -1; -0.585 → -0.59
    ]);
  });

  it('sums are exact (no float drift)', () => {
    const r = rules({
      columns: [col('x', 'decimal')],
      output: { summaryRows: [{ labelColumn: 'x', label: 'T', cells: { x: 'sum' } }] },
    });
    const rows = Array.from({ length: 10 }, () => [0.1]);
    const res = runOk(r, table(['x'], rows));
    // The label column is also summed: the sum takes the cell. 10 × 0.1 is exactly 1.
    expect(res.sheet.rows.at(-1)!.cells[0]!.v).toBe(1);
    const r2 = rules({
      columns: [col('x', 'decimal'), col('k')],
      output: { summaryRows: [{ labelColumn: 'k', label: 'T', cells: { x: 'sum' } }] },
    });
    const res2 = runOk(r2, table(['x', 'k'], rows.map((x) => [...x, 'k'])));
    expect(res2.sheet.rows.at(-1)!.cells.map((c) => c.v)).toEqual([1, 'T']);
  });
});
