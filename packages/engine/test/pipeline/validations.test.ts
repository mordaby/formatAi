import type { Validation } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { ymdToSerial } from '../../src/values/dates';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import { body, col, dataRows, dateCell, rules, runOk, table } from './helpers';

const VALID_ID = makeValidIsraeliId('04021776');
const serial = (y: number, m: number, d: number) => ymdToSerial({ y, m, d });

const columns = [
  col('id', 'idLike', { padLeft: 9 }),
  col('premium', 'decimal'),
  col('status', 'text'),
  col('policy', 'idLike'),
  col('d', 'date'),
];
const headers = ['id', 'premium', 'status', 'policy', 'd'];
const t = table(headers, [
  [VALID_ID, 100, 'פעיל', '12345678', dateCell(serial(2024, 5, 1))], // 2: clean
  ['123456789', -5, 'פעיל', '123', dateCell(serial(2024, 5, 2))], // 3: bad checksum, negative, short policy
  [null, 50, 'אחר', '87654321', dateCell(serial(2023, 1, 1))], // 4: missing id, bad status, date out of range
  [VALID_ID, 20, 'פעיל', '12345678', null], // 5: duplicate id and policy
]);

function run(validations: Validation[], extra: Parameters<typeof rules>[0] = { columns }) {
  return runOk(rules({ ...extra, columns, validations }), t);
}

describe('validations: severity flag', () => {
  it('each rule flags with its messageKey, params and suggestion', () => {
    const res = run([
      { column: 'id', rule: 'required', severity: 'flag' },
      { column: 'id', rule: 'israeliIdChecksum', severity: 'flag' },
      { column: 'premium', rule: 'range', min: 0, max: 1000, severity: 'flag' },
      { column: 'policy', rule: 'lengthEquals', length: 8, severity: 'flag' },
      { column: 'status', rule: 'oneOf', values: ['פעיל', 'מבוטל'], severity: 'flag' },
      { column: 'id', rule: 'unique', severity: 'flag' },
      { column: 'd', rule: 'dateRange', from: '2024-01-01', to: '2024-12-31', severity: 'flag' },
    ]);
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.rule, f.value, f.messageKey, f.params, f.suggestion])).toEqual([
      [3, 'id', 'israeliIdChecksum', '123456789', 'flag.validation.israeliIdChecksum', undefined, undefined],
      [3, 'premium', 'range', -5, 'flag.validation.range', { min: 0, max: 1000 }, undefined],
      [3, 'policy', 'lengthEquals', '123', 'flag.validation.lengthEquals', { length: 8 }, '00000123'],
      [4, 'id', 'required', null, 'flag.validation.required', undefined, undefined],
      [4, 'status', 'oneOf', 'אחר', 'flag.validation.oneOf', undefined, undefined],
      [4, 'd', 'dateRange', '01/01/2023', 'flag.validation.dateRange', { from: '2024-01-01', to: '2024-12-31' }, undefined],
      [5, 'id', 'unique', VALID_ID, 'flag.validation.unique', { firstRow: 2 }, undefined],
    ]);
    // Flagged rows are still written, with the failing cells highlighted.
    expect(dataRows(res.sheet)).toHaveLength(4);
    expect(dataRows(res.sheet)[1]!.cells.map((c) => c.flagged === true)).toEqual([true, true, false, true, false]);
    expect(res.summary.blockedRows).toEqual([]);
  });

  it('the type check is automatic', () => {
    const res = runOk(rules({ columns: [col('n', 'decimal')], validations: [] }), table(['n'], [['x']]));
    expect(res.flags.map((f) => [f.rule, f.messageKey])).toEqual([['type', 'flag.parseFailed.number']]);
  });
});

describe('validations: severity block', () => {
  it('blocked rows are left out, listed, and excluded from subtotals and the grand total', () => {
    const res = run(
      [
        { column: 'premium', rule: 'range', min: 0, severity: 'block' },
        { column: 'id', rule: 'required', severity: 'block' },
        { column: 'id', rule: 'israeliIdChecksum', severity: 'flag' },
      ],
      {
        columns,
        transform: { group: { by: 'status', showDetailRows: true, subtotal: { labelColumn: 'id', label: 'sub', sum: ['premium'] } } },
        output: { grandTotal: { labelColumn: 'id', label: 'total', sum: ['premium'] } },
        out: ['id', 'premium'],
      },
    );
    expect(res.summary.blockedRows).toEqual([
      { rowNumber: 3, rule: 'range', column: 'premium' },
      { rowNumber: 4, rule: 'required', column: 'id' },
    ]);
    expect(body(res.sheet)).toEqual([
      ['data', VALID_ID, 100],
      ['data', VALID_ID, 20],
      ['subtotal', 'sub', 120],
      ['grandTotal', 'total', 120],
    ]);
    // Row 3 failed the checksum too, but it is blocked: no flag for a row that isn't written.
    expect(res.flags).toEqual([]);
    expect(res.summary.rowsOut).toBe(2);
  });

  it('a blocked row drops its earlier flags; unique counts only rows still in', () => {
    const res = run([
      { column: 'status', rule: 'oneOf', values: ['פעיל'], severity: 'flag' },
      { column: 'id', rule: 'unique', severity: 'flag' }, // flags row 5 ...
      { column: 'd', rule: 'required', severity: 'block' }, // ... which is then blocked
      { column: 'policy', rule: 'unique', severity: 'block' },
    ]);
    expect(res.summary.blockedRows).toEqual([{ rowNumber: 5, rule: 'required', column: 'd' }]);
    expect(res.flags.map((f) => [f.rowNumber, f.rule])).toEqual([[4, 'oneOf']]);
  });

  it('unique ignores repeats within one expand family', () => {
    const res = runOk(
      rules({
        columns: [col('policy', 'idLike'), col('items', 'text')],
        expand: { mode: 'splitCell', column: 'items', separator: ',', trim: true, partId: 'item', skipEmpty: true },
        validations: [{ column: 'policy', rule: 'unique', severity: 'flag' }],
        out: ['policy', 'item'],
      }),
      table(['policy', 'items'], [['A', 'x,y'], ['B', 'z'], ['A', 'w']]),
    );
    expect(res.flags.map((f) => [f.rowNumber, f.params])).toEqual([[4, { firstRow: 2 }]]);
  });
});
