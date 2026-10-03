// Which input columns a rules file USES, which of them a new file lacks, and the "same name, different meaning" check
// (SPEC 8.15, 21 v11 items 4-7). Synthetic, domain-neutral rules; headers, ids and counts only.
import type { Expr, LearnResult } from '@formatai/shared';
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { inputColumnsUsed, missingInputColumns, unlikeColumns } from '../../src/registry';
import type { Flag } from '../../src/types';
import { col as c, rules, type RulesInit } from '../pipeline/helpers';

const ref = (id: string): Expr => ({ col: id });

/** Four columns; only `a` and `b` reach the output. */
const base = (over: Partial<RulesInit> = {}): LearnResult => rules({ columns: [c('a'), c('b'), c('c'), c('d')], out: ['a', 'b'], ...over });

describe('inputColumnsUsed', () => {
  it('is what an output column reads, and nothing else', () => {
    expect(inputColumnsUsed(base())).toEqual(['a', 'b']);
  });

  it('follows computed columns, however deep, and ignores a computed column nothing reads', () => {
    const r = base({
      out: [{ header: 'Total', from: 'total' }],
      transform: {
        computed: [
          { id: 'sum', type: 'decimal', expr: { op: 'add', args: [ref('a'), ref('b')] } },
          { id: 'total', type: 'decimal', expr: { op: 'mul', args: [ref('sum'), { const: 2 }] } },
          { id: 'unread', type: 'decimal', expr: ref('d') },
        ],
      },
    });
    expect(inputColumnsUsed(r)).toEqual(['a', 'b']);
  });

  it('counts the keys and order columns of an across-row function', () => {
    const r = base({
      out: [{ header: 'Running', from: 'running' }],
      transform: {
        computed: [{ id: 'running', type: 'decimal', expr: { op: 'window', fn: 'runningSum', arg: ref('a'), by: ['b'], order: [{ column: 'c', dir: 'asc' }] } }],
      },
    });
    expect(inputColumnsUsed(r)).toEqual(['a', 'b', 'c']);
  });

  it('counts what decides which rows there are: filters, duplicate keys, expand, sort, group, title rows', () => {
    expect(inputColumnsUsed(base({ rowFilters: [{ column: 'c', op: 'notEmpty' }] }))).toEqual(['a', 'b', 'c']);
    expect(inputColumnsUsed(base({ rowFilters: [{ expr: { op: 'gt', args: [ref('d'), { const: 0 }] } }] }))).toEqual(['a', 'b', 'd']);
    expect(inputColumnsUsed(base({ transform: { dedupe: { keys: ['c'], keep: 'first', action: 'remove' } } }))).toEqual(['a', 'b', 'c']);
    expect(inputColumnsUsed(base({ transform: { sort: [{ column: 'd', dir: 'asc' }] } }))).toEqual(['a', 'b', 'd']);
    expect(inputColumnsUsed(base({ transform: { group: { by: 'c', showDetailRows: true } } }))).toEqual(['a', 'b', 'c']);
    expect(inputColumnsUsed(base({ output: { titleRows: [{ parts: [{ agg: 'max', column: 'd', format: 'yyyy' }] }] } }))).toEqual(['a', 'b', 'd']);
  });

  it('dedupe on "all" counts every declared column, and expand counts the columns it spreads or splits', () => {
    expect(inputColumnsUsed(base({ transform: { dedupe: { keys: 'all', keep: 'first', action: 'remove' } } }))).toEqual(['a', 'b', 'c', 'd']);
    const spread = base({
      out: [{ header: 'Month', from: 'month' }, { header: 'Amount', from: 'amount' }],
      expand: { mode: 'columnsToRows', columns: ['c', 'd'], labelId: 'month', valueId: 'amount', valueType: 'decimal', skipEmpty: true },
    });
    expect(inputColumnsUsed(spread)).toEqual(['c', 'd']);
    const split = base({
      out: [{ header: 'Part', from: 'part' }],
      expand: { mode: 'splitCell', column: 'b', separator: ';', trim: true, partId: 'part', skipEmpty: true },
    });
    expect(inputColumnsUsed(split)).toEqual(['b']);
  });

  it('counts a check on an input column, but not a check on an output header', () => {
    expect(inputColumnsUsed(base({ validations: [{ column: 'd', rule: 'required', severity: 'flag' }] }))).toEqual(['a', 'b', 'd']);
    expect(inputColumnsUsed(base({ validations: [{ on: 'output', column: 'a', rule: 'unique', severity: 'flag' }] }))).toEqual(['a', 'b']);
  });

  it('a value map alone is not a use', () => {
    expect(inputColumnsUsed(base({ transform: { valueMaps: [{ column: 'd', map: { x: 'y' }, onMissing: 'keep' }] } }))).toEqual(['a', 'b']);
  });
});

describe('missingInputColumns', () => {
  const r = rules({
    columns: [c('Code'), { ...c('Qty'), required: true }, c('Price'), c('Notes')],
    out: ['Code', 'Qty', 'Price'],
  });

  it('lists a missing required column and a missing column that is used though optional, never an unused one', () => {
    expect(missingInputColumns(r, ['Code', 'Notes'])).toEqual([
      { id: 'Qty', header: 'Qty', required: true },
      { id: 'Price', header: 'Price', required: false },
    ]);
    // Notes is declared but nothing reads it: its absence changes nothing.
    expect(missingInputColumns(r, ['Code', 'Qty', 'Price'])).toEqual([]);
  });

  it('finds columns the way a run does: by alias and by normalized header', () => {
    const aliased = rules({ columns: [c('Code'), { ...c('Qty'), aliases: ['Quantity'] }, c('Price')], out: ['Code', 'Qty', 'Price'] });
    expect(missingInputColumns(aliased, ['code ', 'Quantity', 'PRICE'])).toEqual([]);
  });
});

describe('unlikeColumns', () => {
  const r = rules({ columns: [c('n', 'integer'), c('d', 'date'), c('unused', 'integer')], out: ['n', 'd'] });
  const flag = (rowNumber: number, column: string, messageKey = 'flag.parseFailed.integer', rule = 'type'): Flag => ({ rowNumber, column, rule, value: 'x', messageKey });
  const rowsOf = (column: string, n: number, messageKey?: string): Flag[] => Array.from({ length: n }, (_, i) => flag(i + 2, column, messageKey));

  it('says nothing below the share, and names the column at or above it', () => {
    expect(limits.matching.parseFailShare).toBe(0.9);
    expect(unlikeColumns(r, rowsOf('n', 89), 100)).toEqual([]);
    expect(unlikeColumns(r, rowsOf('n', 90), 100)).toEqual([{ id: 'n', header: 'n', type: 'integer', rows: 90 }]);
    expect(unlikeColumns(r, rowsOf('d', 100, 'flag.parseFailed.date'), 100)).toEqual([{ id: 'd', header: 'd', type: 'date', rows: 100 }]);
  });

  it('counts a row once however many flags it has, and uses the share it is given', () => {
    const twice = [...rowsOf('n', 5), ...rowsOf('n', 5)];
    expect(unlikeColumns(r, twice, 10)).toEqual([]);
    expect(unlikeColumns(r, twice, 10, 0.5)).toEqual([{ id: 'n', header: 'n', type: 'integer', rows: 5 }]);
  });

  it('looks only at parse failures of a USED input column', () => {
    expect(unlikeColumns(r, rowsOf('unused', 10), 10)).toEqual([]);
    expect(unlikeColumns(r, rowsOf('n', 10, 'flag.duplicateOf'), 10)).toEqual([]);
    expect(unlikeColumns(r, [flag(2, 'n', 'flag.parseFailed.integer', 'range')], 1)).toEqual([]);
    expect(unlikeColumns(r, rowsOf('computed', 10), 10)).toEqual([]);
  });

  it('an empty run has no share to look at', () => {
    expect(unlikeColumns(r, [], 0)).toEqual([]);
    expect(unlikeColumns(r, rowsOf('n', 3), 0)).toEqual([]);
  });
});
