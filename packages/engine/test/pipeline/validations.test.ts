import type { Validation } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { ymdToSerial } from '../../src/values/dates';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import { body, col, dataRows, dateCell, rules, runOk, table } from './helpers';

const VALID_ID = makeValidIsraeliId('04021776');
const serial = (y: number, m: number, d: number) => ymdToSerial({ y, m, d });

const columns = [
  col('id', 'idLike', { padLeft: 9 }),
  col('amount', 'decimal'),
  col('status', 'text'),
  col('order', 'idLike'),
  col('d', 'date'),
];
const headers = ['id', 'amount', 'status', 'order', 'd'];
const t = table(headers, [
  [VALID_ID, 100, 'פעיל', '12345678', dateCell(serial(2024, 5, 1))], // 2: clean
  ['123456789', -5, 'פעיל', '123', dateCell(serial(2024, 5, 2))], // 3: bad checksum, negative, short order
  [null, 50, 'אחר', '87654321', dateCell(serial(2023, 1, 1))], // 4: missing id, bad status, date out of range
  [VALID_ID, 20, 'פעיל', '12345678', null], // 5: duplicate id and order
]);

function run(validations: Validation[], extra: Parameters<typeof rules>[0] = { columns }) {
  return runOk(rules({ ...extra, columns, validations }), t);
}

describe('validations: severity flag', () => {
  it('each rule flags with its messageKey, params and suggestion', () => {
    const res = run([
      { column: 'id', rule: 'required', severity: 'flag' },
      { column: 'id', rule: 'israeliIdChecksum', severity: 'flag' },
      { column: 'amount', rule: 'range', min: 0, max: 1000, severity: 'flag' },
      { column: 'order', rule: 'lengthEquals', length: 8, severity: 'flag' },
      { column: 'status', rule: 'oneOf', values: ['פעיל', 'מבוטל'], severity: 'flag' },
      { column: 'id', rule: 'unique', severity: 'flag' },
      { column: 'd', rule: 'dateRange', from: '2024-01-01', to: '2024-12-31', severity: 'flag' },
    ]);
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.rule, f.value, f.messageKey, f.params, f.suggestion])).toEqual([
      [3, 'id', 'israeliIdChecksum', '123456789', 'flag.validation.israeliIdChecksum', undefined, undefined],
      [3, 'amount', 'range', -5, 'flag.validation.range', { min: 0, max: 1000 }, undefined],
      [3, 'order', 'lengthEquals', '123', 'flag.validation.lengthEquals', { length: 8 }, '00000123'],
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
        { column: 'amount', rule: 'range', min: 0, severity: 'block' },
        { column: 'id', rule: 'required', severity: 'block' },
        { column: 'id', rule: 'israeliIdChecksum', severity: 'flag' },
      ],
      {
        columns,
        transform: { group: { by: 'status', showDetailRows: true, subtotal: { labelColumn: 'id', label: 'sub', sum: ['amount'] } } },
        output: { grandTotal: { labelColumn: 'id', label: 'total', sum: ['amount'] } },
        out: ['id', 'amount'],
      },
    );
    expect(res.summary.blockedRows).toEqual([
      { rowNumber: 3, rule: 'range', column: 'amount' },
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
      { column: 'order', rule: 'unique', severity: 'block' },
    ]);
    expect(res.summary.blockedRows).toEqual([{ rowNumber: 5, rule: 'required', column: 'd' }]);
    expect(res.flags.map((f) => [f.rowNumber, f.rule])).toEqual([[4, 'oneOf']]);
  });

  it('unique ignores repeats within one expand family', () => {
    const res = runOk(
      rules({
        columns: [col('order', 'idLike'), col('items', 'text')],
        expand: { mode: 'splitCell', column: 'items', separator: ',', trim: true, partId: 'item', skipEmpty: true },
        validations: [{ column: 'order', rule: 'unique', severity: 'flag' }],
        out: ['order', 'item'],
      }),
      table(['order', 'items'], [['A', 'x,y'], ['B', 'z'], ['A', 'w']]),
    );
    expect(res.flags.map((f) => [f.rowNumber, f.params])).toEqual([[4, { firstRow: 2 }]]);
  });
});

describe('validations: on "output"', () => {
  // Output columns named differently from the input/computed ids they come
  // from, so a passing test genuinely proves `column` is resolved as an
  // output header (SPEC 8.8), not accidentally as an input id.
  const outCols = [
    { header: 'ID', from: 'id' },
    { header: 'Amount', from: 'amount' },
  ];

  it('severity flag: addresses the output header, but the flag still carries the input rowNumber', () => {
    const res = run([{ on: 'output', column: 'Amount', rule: 'range', min: 0, severity: 'flag' }], { columns, out: outCols });
    expect(res.flags).toEqual([
      { rowNumber: 3, column: 'Amount', rule: 'range', value: -5, messageKey: 'flag.validation.range', params: { min: 0 } },
    ]);
    // The flagged cell is the output column addressed by the check (index 1: Amount).
    expect(dataRows(res.sheet).map((r) => r.cells.map((c) => c.flagged === true))).toEqual([
      [false, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
  });

  it('an input validation (by id) and an output validation (by header) on the same underlying value coexist', () => {
    const res = run(
      [
        { column: 'amount', rule: 'range', min: 0, max: 1000, severity: 'flag' },
        { on: 'output', column: 'Amount', rule: 'range', min: 0, severity: 'flag' },
      ],
      { columns, out: outCols },
    );
    // Same row, same cell, two different flags: one keyed by the input id, one by the output header.
    expect(res.flags).toEqual([
      { rowNumber: 3, column: 'amount', rule: 'range', value: -5, messageKey: 'flag.validation.range', params: { min: 0, max: 1000 } },
      { rowNumber: 3, column: 'Amount', rule: 'range', value: -5, messageKey: 'flag.validation.range', params: { min: 0 } },
    ]);
  });

  it('severity block: the row is excluded from the output *and* from every subtotal and the grand total', () => {
    const res = run(
      [{ on: 'output', column: 'Amount', rule: 'range', min: 0, severity: 'block' }],
      {
        columns,
        transform: { group: { by: 'status', showDetailRows: true, subtotal: { labelColumn: 'id', label: 'sub', sum: ['amount'] } } },
        output: { grandTotal: { labelColumn: 'id', label: 'total', sum: ['amount'] } },
        out: outCols,
      },
    );
    // The blocked-row summary entry also names the output header, not the input id.
    expect(res.summary.blockedRows).toEqual([{ rowNumber: 3, rule: 'range', column: 'Amount' }]);
    expect(res.flags).toEqual([]);
    expect(res.summary.rowsOut).toBe(3);
    expect(body(res.sheet)).toEqual([
      ['data', VALID_ID, 100],
      ['data', VALID_ID, 20],
      ['subtotal', 'sub', 120],
      ['data', null, 50],
      ['subtotal', 'sub', 50],
      // 170 = 100 + 20 + 50: row 3's -5 never reaches this total.
      ['grandTotal', 'total', 170],
    ]);
  });
});
