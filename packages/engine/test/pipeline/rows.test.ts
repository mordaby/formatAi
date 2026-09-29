// Row-level steps: filters (3), dedupe (4).
import type { Dedupe, RowFilter } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { col, dataRows, dateCell, rules, runOk, table, values } from './helpers';
import { ymdToSerial } from '../../src/values/dates';

describe('row filters', () => {
  const columns = [
    col('status', 'text'),
    col('amount', 'decimal'),
    col('customer', 'idLike', { padLeft: 5 }),
    col('d', 'date', { inputFormats: ['DD/MM/YYYY'] }),
  ];
  const t = table(
    ['status', 'amount', 'customer', 'd'],
    [
      ['פעיל', '1,000', 12, '01/01/2024'], // 2
      ['מבוטל', 50, '00012', '15/02/2024'], // 3
      [' פעיל ', 9.5, 7, dateCell(ymdToSerial({ y: 2024, m: 3, d: 1 }))], // 4
      [null, null, 300, null], // 5
      ['ממתין', '200', 12, '10/10/2023'], // 6
    ],
  );
  const kept = (filters: RowFilter[]) => {
    const res = runOk(rules({ columns, rowFilters: filters }), t);
    return { rows: dataRows(res.sheet).map((r) => r.sourceRow), filtered: res.summary.rowsFiltered };
  };

  it('eq / ne on text use normalizeText; ne keeps empty values', () => {
    expect(kept([{ column: 'status', op: 'eq', value: 'פעיל' }]).rows).toEqual([2, 4]);
    expect(kept([{ column: 'status', op: 'ne', value: 'מבוטל' }])).toEqual({ rows: [2, 4, 5, 6], filtered: 1 });
  });

  it('numeric comparisons are numeric, not textual', () => {
    expect(kept([{ column: 'amount', op: 'gt', value: 100 }]).rows).toEqual([2, 6]);
    expect(kept([{ column: 'amount', op: 'lte', value: '50' }]).rows).toEqual([3, 4]);
    expect(kept([{ column: 'amount', op: 'eq', value: 1000 }]).rows).toEqual([2]);
    expect(kept([{ column: 'amount', op: 'gte', value: 9.5 }]).rows).toEqual([2, 3, 4, 6]);
  });

  it('date comparisons are by date (ISO or the column format)', () => {
    expect(kept([{ column: 'd', op: 'gte', value: '2024-02-01' }]).rows).toEqual([3, 4]);
    expect(kept([{ column: 'd', op: 'lt', value: '01/01/2024' }]).rows).toEqual([6]);
  });

  it('idLike constants are padded like the column', () => {
    expect(kept([{ column: 'customer', op: 'eq', value: 12 }]).rows).toEqual([2, 3, 6]);
    expect(kept([{ column: 'customer', op: 'oneOf', value: ['7', 300] }]).rows).toEqual([4, 5]);
  });

  it('oneOf / notOneOf', () => {
    expect(kept([{ column: 'status', op: 'oneOf', value: ['פעיל', 'ממתין'] }]).rows).toEqual([2, 4, 6]);
    expect(kept([{ column: 'status', op: 'notOneOf', value: ['פעיל', 'ממתין'] }]).rows).toEqual([3, 5]);
    expect(kept([{ column: 'status', op: 'oneOf', value: ['ממתין', null] }]).rows).toEqual([5, 6]);
    expect(kept([{ column: 'amount', op: 'oneOf', value: [50, '200'] }]).rows).toEqual([3, 6]);
  });

  it('isEmpty / notEmpty, and filters are ANDed', () => {
    expect(kept([{ column: 'status', op: 'isEmpty' }]).rows).toEqual([5]);
    expect(kept([{ column: 'amount', op: 'notEmpty' }]).rows).toEqual([2, 3, 4, 6]);
    expect(
      kept([
        { column: 'amount', op: 'notEmpty' },
        { column: 'status', op: 'ne', value: 'מבוטל' },
        { column: 'amount', op: 'lt', value: 500 },
      ]),
    ).toEqual({ rows: [4, 6], filtered: 3 });
  });

  it('filtered rows raise no flags', () => {
    const res = runOk(
      rules({ columns: [col('s'), col('n', 'decimal')], rowFilters: [{ column: 's', op: 'eq', value: 'keep' }] }),
      table(['s', 'n'], [['drop', 'oops'], ['keep', 1]]),
    );
    expect(res.flags).toEqual([]);
  });

  it('{ expr } filters: any condition, over the whole row, ANDed with the other filters', () => {
    // amount > 100 and status = active (row 4's leading/trailing spaces still
    // normalize to a match, but its amount is too small).
    expect(
      kept([{ expr: { op: 'and', args: [{ op: 'gt', args: [{ col: 'amount' }, { const: 100 }] }, { op: 'eq', args: [{ col: 'status' }, { const: 'פעיל' }] }] } }]),
    ).toEqual({ rows: [2], filtered: 4 });

    // an { expr } filter composes with a simple filter (ANDed): status is
    // active or pending, and amount >= 100.
    expect(
      kept([
        {
          expr: {
            op: 'or',
            args: [
              { op: 'eq', args: [{ col: 'status' }, { const: 'פעיל' }] },
              { op: 'eq', args: [{ col: 'status' }, { const: 'ממתין' }] },
            ],
          },
        },
        { column: 'amount', op: 'gte', value: 100 },
      ]),
    ).toEqual({ rows: [2, 6], filtered: 3 });
  });
});

describe('dedupe', () => {
  // Rows 2..7. Rows 2, 4, 7 share item 1 (7 with a different amount); rows 3 and 6 are identical.
  const columns = [col('item', 'idLike', { padLeft: 4 }), col('name', 'text'), col('amount', 'decimal')];
  const t = table(
    ['item', 'name', 'amount'],
    [
      [1, 'דנה', 100], // 2
      ['0002', "ג'ון", 50], // 3
      ['0001', ' דנה ', '100'], // 4: same as 2 after normalization
      [3, 'x', 1], // 5
      [2, 'ג׳ון', '50.00'], // 6: same as 3 after normalization (geresh, padding)
      [1, 'דנה', 999], // 7
    ],
  );
  const run = (dedupe: Dedupe) => runOk(rules({ columns, transform: { dedupe } }), t);

  it('remove + keep first, on key columns', () => {
    const res = run({ keys: ['item'], keep: 'first', action: 'remove' });
    expect(dataRows(res.sheet).map((r) => r.sourceRow)).toEqual([2, 3, 5]);
    expect(res.summary.duplicatesRemoved).toEqual([
      { rowNumber: 4, duplicateOf: 2 },
      { rowNumber: 6, duplicateOf: 3 },
      { rowNumber: 7, duplicateOf: 2 },
    ]);
    expect(res.summary.rowsOut).toBe(3);
  });

  it('remove + keep last, on key columns', () => {
    const res = run({ keys: ['item'], keep: 'last', action: 'remove' });
    expect(dataRows(res.sheet).map((r) => r.sourceRow)).toEqual([5, 6, 7]);
    expect(res.summary.duplicatesRemoved).toEqual([
      { rowNumber: 2, duplicateOf: 7 },
      { rowNumber: 3, duplicateOf: 6 },
      { rowNumber: 4, duplicateOf: 7 },
    ]);
  });

  it('remove on "all" compares every column after normalization', () => {
    const first = run({ keys: 'all', keep: 'first', action: 'remove' });
    expect(dataRows(first.sheet).map((r) => r.sourceRow)).toEqual([2, 3, 5, 7]);
    expect(first.summary.duplicatesRemoved).toEqual([
      { rowNumber: 4, duplicateOf: 2 },
      { rowNumber: 6, duplicateOf: 3 },
    ]);
    const last = run({ keys: 'all', keep: 'last', action: 'remove' });
    expect(dataRows(last.sheet).map((r) => r.sourceRow)).toEqual([4, 5, 6, 7]);
    expect(last.summary.duplicatesRemoved).toEqual([
      { rowNumber: 2, duplicateOf: 4 },
      { rowNumber: 3, duplicateOf: 6 },
    ]);
  });

  it('flag + keep first keeps every row and flags each extra copy', () => {
    const res = run({ keys: ['item'], keep: 'first', action: 'flag' });
    expect(dataRows(res.sheet).map((r) => r.sourceRow)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(res.summary.duplicatesFlagged).toBe(3);
    expect(res.summary.duplicatesRemoved).toEqual([]);
    expect(res.flags).toEqual([
      { rowNumber: 4, column: 'item', rule: 'dedupe', value: '0001', messageKey: 'flag.duplicateOf', params: { duplicateOf: 2 } },
      { rowNumber: 6, column: 'item', rule: 'dedupe', value: '0002', messageKey: 'flag.duplicateOf', params: { duplicateOf: 3 } },
      { rowNumber: 7, column: 'item', rule: 'dedupe', value: '0001', messageKey: 'flag.duplicateOf', params: { duplicateOf: 2 } },
    ]);
    const flaggedCells = dataRows(res.sheet).map((r) => r.cells.map((c) => c.flagged === true));
    expect(flaggedCells[2]).toEqual([true, false, false]);
    expect(flaggedCells[0]).toEqual([false, false, false]);
  });

  it('flag + keep last flags the earlier copies', () => {
    const res = run({ keys: ['item'], keep: 'last', action: 'flag' });
    expect(res.flags.map((f) => [f.rowNumber, f.params?.duplicateOf])).toEqual([
      [2, 7],
      [3, 6],
      [4, 7],
    ]);
  });

  it('flag on "all" highlights the whole row', () => {
    const res = run({ keys: 'all', keep: 'first', action: 'flag' });
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.params?.duplicateOf])).toEqual([
      [4, 'item', 2],
      [6, 'item', 3],
    ]);
    expect(dataRows(res.sheet)[2]!.cells.every((c) => c.flagged === true)).toBe(true);
  });

  it('rows with all-empty keys are never duplicates', () => {
    const res = runOk(
      rules({ columns: [col('k'), col('v')], transform: { dedupe: { keys: ['k'], keep: 'first', action: 'remove' } } }),
      table(['k', 'v'], [[null, 'a'], [null, 'b'], ['x', 'c'], ['x', 'd']]),
    );
    expect(values(res.sheet)).toEqual([[null, 'a'], [null, 'b'], ['x', 'c']]);
  });

  it('runs after filters', () => {
    const res = runOk(
      rules({
        columns: [col('k'), col('s')],
        rowFilters: [{ column: 's', op: 'ne', value: 'cancelled' }],
        transform: { dedupe: { keys: ['k'], keep: 'first', action: 'remove' } },
      }),
      table(['k', 's'], [['a', 'cancelled'], ['a', 'ok']]),
    );
    expect(dataRows(res.sheet).map((r) => r.sourceRow)).toEqual([3]);
    expect(res.summary.duplicatesRemoved).toEqual([]);
    expect(res.summary.rowsFiltered).toBe(1);
  });
});
