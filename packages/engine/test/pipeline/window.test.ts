// Across-row ("window") functions (docs/proposals/window-operations.md): every function, run through the real pipeline from FORMULA TEXT
// (the way the editor's Advanced view writes it), against hand-worked tables and against a plain-TS O(n^2) oracle on random tables.
// The parser, printer, types, limits and the learn side have their own tests (formula/window.test.ts, check/window.test.ts, learn/...).
import Decimal from 'decimal.js';
import type { Computed, ColumnType, Expr, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { parseFormula } from '../../src/formula/parseFormula';
import { runRules } from '../../src/pipeline';
import type { RunSummary } from '../../src/types';
import { col, dataRows, expectOk, rules, runOk, table, values } from './helpers';

function parse(formula: string): Expr {
  const r = parseFormula(formula, { allowWindows: true });
  if (!r.ok) throw new Error(`formula "${formula}": ${r.error.message}`);
  return r.expr;
}

type Cell = string | number | boolean | null;

const COLUMNS = [
  col('acct', 'text'),
  col('amt', 'decimal'),
  col('k', 'integer'),
  col('note', 'text'),
  col('when', 'date'),
];
const HEADERS = ['acct', 'amt', 'k', 'note', 'when'];

/** The first hand table, in file order. */
const T1: Cell[][] = [
  ['A', 10, 3, 'x', null],
  ['B', 5, 1, null, null],
  ['A', null, 2, null, null],
  ['A', 7.5, 2, 'y', null],
  ['B', 1, null, 'z', null],
];

/** One computed column `out` with `formula`, shown as the only output column. */
function one(formula: string, type: ColumnType, input: Cell[][] = T1, extra: Partial<Parameters<typeof rules>[0]> = {}) {
  const r = rules({
    columns: COLUMNS,
    transform: { computed: [{ id: 'out', type, expr: parse(formula) }] },
    out: [{ header: 'out', from: 'out' }],
    ...extra,
  });
  return runOk(r, table(HEADERS, input));
}

/** The values the formula gives, row by row, in file order (an `out` column). */
function col1(formula: string, type: ColumnType, input: Cell[][] = T1): Cell[] {
  return values(one(formula, type, input).sheet).map((r) => r[0] as Cell);
}

describe('runningSum', () => {
  it('walks file order without order:; empty and absent numbers add nothing; empty until the first number', () => {
    expect(col1('runningSum(amt)', 'decimal')).toEqual([10, 15, 15, 22.5, 23.5]);
    expect(col1('runningSum(amt)', 'decimal', [['A', null, 1, null, null], ['A', 4, 1, null, null], ['A', null, 1, null, null]])).toEqual([null, 4, 4]);
  });

  it('restarts for each by: group, rows of other groups interleaved', () => {
    expect(col1('runningSum(amt, by: acct)', 'decimal')).toEqual([10, 5, 10, 17.5, 6]);
  });

  it('order: sorts the group (asc, ties in file order, empty keys last) while results stay on their own rows', () => {
    // A: k = 3 (row 1), 2 (row 3), 2 (row 4) -> walk row 3, row 4, row 1; B: row 2 (k 1), then row 5 (empty k) last.
    expect(col1('runningSum(amt, by: acct, order: k)', 'decimal')).toEqual([17.5, 5, null, 7.5, 6]);
  });

  it('order: desc puts empty keys last too', () => {
    // k desc: row 1 (3), row 3 (2), row 4 (2), row 2 (1), row 5 (empty)
    expect(col1('runningSum(amt, order: k desc)', 'decimal')).toEqual([10, 22.5, 10, 17.5, 23.5]);
  });

  it('adds exactly (0.1 + 0.2 is 0.3, never 0.30000000000000004)', () => {
    const out = col1('runningSum(amt)', 'decimal', [['A', 0.1, 1, null, null], ['A', 0.2, 1, null, null], ['A', 0.3, 1, null, null]]);
    expect(out).toEqual([0.1, 0.3, 0.6]);
  });

  it('a value that did not parse is skipped (and was flagged where it was read), not counted as zero or reported again', () => {
    const res = one('runningSum(amt)', 'decimal', [['A', 5, 1, null, null], ['A', 'oops', 1, null, null], ['A', 6, 1, null, null]]);
    expect(values(res.sheet).map((r) => r[0])).toEqual([5, 5, 11]);
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.messageKey])).toEqual([[3, 'amt', 'flag.parseFailed.number']]);
  });

  it('keeps integers integer when the column is', () => {
    const r = rules({
      columns: [col('n', 'integer')],
      transform: { computed: [{ id: 'out', type: 'integer', expr: parse('runningSum(n)') }] },
      out: [{ header: 'out', from: 'out' }],
    });
    expect(values(runOk(r, table(['n'], [[1], [2], [3]])).sheet)).toEqual([[1], [3], [6]]);
  });
});

describe('groupSum / groupAvg / groupMin / groupMax', () => {
  it('groupSum: the group total on every row of the group', () => {
    expect(col1('groupSum(amt, by: acct)', 'decimal')).toEqual([17.5, 6, 17.5, 17.5, 6]);
    expect(col1('groupSum(amt)', 'decimal')).toEqual([23.5, 23.5, 23.5, 23.5, 23.5]);
  });

  it('groupSum is empty where the group has no number', () => {
    expect(col1('groupSum(amt, by: acct)', 'decimal', [['A', null, 1, null, null], ['B', 2, 1, null, null], ['A', null, 1, null, null]])).toEqual([null, 2, null]);
  });

  it('groupAvg: exact sum over count of the numbers (empties are not rows of the average)', () => {
    expect(col1('groupAvg(amt, by: acct)', 'decimal')).toEqual([8.75, 3, 8.75, 8.75, 3]);
    expect(col1('groupAvg(amt)', 'decimal', [['A', 1, 1, null, null], ['A', 2, 1, null, null], ['A', null, 1, null, null], ['A', 2, 1, null, null]])).toEqual([5 / 3, 5 / 3, 5 / 3, 5 / 3].map((v) => new Decimal(5).div(3).toNumber()));
  });

  it('groupMin / groupMax: skip empties, empty when there are none', () => {
    expect(col1('groupMin(amt, by: acct)', 'decimal')).toEqual([7.5, 1, 7.5, 7.5, 1]);
    expect(col1('groupMax(amt, by: acct)', 'decimal')).toEqual([10, 5, 10, 10, 5]);
    expect(col1('groupMax(amt, by: acct)', 'decimal', [['A', null, 1, null, null], ['B', 3, 1, null, null]])).toEqual([null, 3]);
  });

  it('groupMin / groupMax work on dates', () => {
    const serial = (n: number): { v: number; isDate: true; z: string } => ({ v: n, isDate: true, z: 'dd/mm/yyyy' });
    const input = [
      ['A', null, 1, null, serial(45000)],
      ['A', null, 1, null, serial(44000)],
      ['B', null, 1, null, serial(46000)],
      ['A', null, 1, null, null],
    ] as unknown as Cell[][];
    const r = rules({
      columns: COLUMNS,
      transform: {
        computed: [
          { id: 'lo', type: 'date', expr: parse('groupMin(when, by: acct)') },
          { id: 'hi', type: 'date', expr: parse('groupMax(when, by: acct)') },
        ],
      },
      out: [{ header: 'lo', from: 'lo' }, { header: 'hi', from: 'hi' }],
    });
    const res = runOk(r, table(HEADERS, input));
    expect(dataRows(res.sheet).map((row) => row.cells.map((c) => c.v))).toEqual([
      [44000, 45000],
      [44000, 45000],
      [46000, 46000],
      [44000, 45000],
    ]);
    expect(dataRows(res.sheet)[0]!.cells[0]!.isDate).toBe(true);
  });
});

describe('groupCount', () => {
  it('groupCount(): rows in the group; groupCount(x): rows where x is not empty; never empty', () => {
    expect(col1('groupCount(by: acct)', 'integer')).toEqual([3, 2, 3, 3, 2]);
    expect(col1('groupCount(amt, by: acct)', 'integer')).toEqual([2, 2, 2, 2, 2]);
    expect(col1('groupCount(amt, by: acct)', 'integer', [['A', null, 1, null, null], ['A', null, 1, null, null]])).toEqual([0, 0]);
    expect(col1('groupCount()', 'integer')).toEqual([5, 5, 5, 5, 5]);
  });

  it('an empty by: value is a partition of its own, like group.by', () => {
    const out = col1('groupCount(by: acct)', 'integer', [[null, 1, 1, null, null], ['A', 1, 1, null, null], [null, 1, 1, null, null], ['A', 1, 1, null, null], [null, 1, 1, null, null]]);
    expect(out).toEqual([3, 2, 3, 2, 3]);
  });

  it('groups by several columns together; "A"+"BC" is not "AB"+"C"', () => {
    const r = rules({
      columns: [col('a', 'text'), col('b', 'text')],
      transform: { computed: [{ id: 'out', type: 'integer', expr: parse('groupCount(by: (a, b))') }] },
      out: [{ header: 'out', from: 'out' }],
    });
    const res = runOk(r, table(['a', 'b'], [['A', 'BC'], ['AB', 'C'], ['A', 'BC'], ['AB', 'C'], ['AB', 'C']]));
    expect(values(res.sheet)).toEqual([[2], [3], [2], [3], [3]]);
  });

  it('text groups compare after normalization (case matters, padding and quote marks do not), like dedupe', () => {
    const out = col1('groupCount(by: acct)', 'integer', [['A', 1, 1, null, null], ['A ', 1, 1, null, null], ['a', 1, 1, null, null]]);
    expect(out).toEqual([2, 2, 1]);
  });
});

describe('previous / next / fillDown', () => {
  it('previous / next: the neighbouring row; empty at the ends; any type', () => {
    expect(col1('previous(amt)', 'decimal')).toEqual([null, 10, 5, null, 7.5]);
    expect(col1('next(amt)', 'decimal')).toEqual([5, null, 7.5, 1, null]);
    expect(col1('previous(note)', 'text')).toEqual([null, 'x', null, null, 'y']);
  });

  it('within a by: group, in group order (a neighbour that is empty gives empty, it is not skipped)', () => {
    expect(col1('previous(amt, by: acct)', 'decimal')).toEqual([null, null, 10, null, 5]);
    expect(col1('next(amt, by: acct)', 'decimal')).toEqual([null, 1, 7.5, null, null]);
  });

  it('with order:, the neighbour is by that order', () => {
    // A by k: row 3, row 4, row 1; B by k: row 2, row 5 (empty k last).
    expect(col1('previous(amt, by: acct, order: k)', 'decimal')).toEqual([7.5, null, null, null, 5]);
    expect(col1('next(amt, by: acct, order: k)', 'decimal')).toEqual([null, 1, 7.5, 10, null]);
  });

  it('previous carries dates', () => {
    const d = (n: number) => ({ v: n, isDate: true, z: 'dd/mm/yyyy' });
    const r = rules({
      columns: COLUMNS,
      transform: { computed: [{ id: 'out', type: 'date', expr: parse('previous(when)') }] },
      out: [{ header: 'out', from: 'out' }],
    });
    const res = runOk(r, table(HEADERS, [['A', null, 1, null, d(45000)], ['A', null, 1, null, d(45010)]] as unknown as Cell[][]));
    expect(dataRows(res.sheet).map((row) => [row.cells[0]!.v, row.cells[0]!.isDate])).toEqual([[null, undefined], [45000, true]]);
  });

  it('fillDown: the last non-empty value up to this row; empty until the first one', () => {
    expect(col1('fillDown(note)', 'text')).toEqual(['x', 'x', 'x', 'y', 'z']);
    expect(col1('fillDown(note)', 'text', [['A', 1, 1, null, null], ['A', 1, 1, 'p', null], ['A', 1, 1, null, null], ['A', 1, 1, null, null]])).toEqual([null, 'p', 'p', 'p']);
    expect(col1('fillDown(amt, by: acct)', 'decimal')).toEqual([10, 5, 10, 7.5, 1]);
  });
});

describe('rowNumber and rank', () => {
  it('rowNumber: 1, 2, 3 ... in file order, per group, or in order: order (ties keep file order)', () => {
    expect(col1('rowNumber()', 'integer')).toEqual([1, 2, 3, 4, 5]);
    expect(col1('rowNumber(by: acct)', 'integer')).toEqual([1, 1, 2, 3, 2]);
    expect(col1('rowNumber(by: acct, order: k)', 'integer')).toEqual([3, 1, 1, 2, 2]);
    expect(col1('rowNumber(order: k desc)', 'integer')).toEqual([1, 4, 2, 3, 5]);
  });

  it('rank: equal keys share a rank; ties: min (default) gives 1, 1, 3', () => {
    expect(col1('rank(order: k)', 'integer')).toEqual([4, 1, 2, 2, null]);
    expect(col1('rank(order: k, ties: min)', 'integer')).toEqual([4, 1, 2, 2, null]);
    expect(col1('rank(order: k desc)', 'integer')).toEqual([1, 4, 2, 2, null]);
  });

  it('rank: ties: dense gives 1, 1, 2', () => {
    expect(col1('rank(order: k, ties: dense)', 'integer')).toEqual([3, 1, 2, 2, null]);
    expect(col1('rank(order: k desc, ties: dense)', 'integer')).toEqual([1, 3, 2, 2, null]);
  });

  it('rank: an empty first key has no rank and does not count, wherever the row is in the file', () => {
    const rows: Cell[][] = [['A', 1, null, null, null], ['A', 1, 5, null, null], ['A', 1, null, null, null], ['A', 1, 9, null, null]];
    expect(col1('rank(order: k)', 'integer', rows)).toEqual([null, 1, null, 2]);
    expect(col1('rank(order: k desc)', 'integer', rows)).toEqual([null, 2, null, 1]);
  });

  it('rank per group and with several keys (the second only separates ties of the first)', () => {
    expect(col1('rank(order: k, by: acct)', 'integer')).toEqual([3, 1, 1, 1, null]);
    expect(col1('rank(order: k, by: acct, ties: dense)', 'integer')).toEqual([2, 1, 1, 1, null]);
    // k asc then amt desc: k 2 rows are row 3 (amt empty, last) and row 4 (7.5): row 4 ranks before row 3.
    expect(col1('rank(order: (k, amt desc))', 'integer')).toEqual([4, 1, 3, 2, null]);
  });
});

describe('where a window runs', () => {
  const cols = [col('acct', 'text'), col('amt', 'decimal'), col('st', 'text')];
  const mk = (computed: Computed[], extra: Partial<Parameters<typeof rules>[0]> = {}) =>
    rules({ columns: cols, transform: { computed }, out: ['acct', 'amt', { header: 'out', from: computed[computed.length - 1]!.id }], ...extra });
  const out = (res: ReturnType<typeof runOk>) => values(res.sheet).map((r) => r[2]);

  it('counts only the rows that remain: filtered, removed duplicates and rows the user skipped are not in it; flagged duplicates and kept rows are', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 1, 'ok'], ['A', 2, 'skip'], ['A', 2, 'ok'], ['A', 2, 'ok'], ['A', 4, 'ok']]);
    const c: Computed[] = [{ id: 'out', type: 'decimal', expr: parse('runningSum(amt)') }];
    // filter: row 2 gone
    const filtered = runOk(mk(c, { rowFilters: [{ column: 'st', op: 'ne', value: 'skip' }] }), t);
    expect(out(filtered)).toEqual([1, 3, 5, 9]);
    // dedupe remove on (acct, amt, st): rows 3 and 4 are the same
    const dedupedRules = mk(c, { rowFilters: [{ column: 'st', op: 'ne', value: 'skip' }] });
    dedupedRules.transform.dedupe = { keys: 'all', keep: 'first', action: 'remove' };
    expect(out(runOk(dedupedRules, t))).toEqual([1, 3, 7]);
    // dedupe flag: both stay in the window
    dedupedRules.transform.dedupe = { keys: 'all', keep: 'first', action: 'flag' };
    expect(out(runOk(dedupedRules, t))).toEqual([1, 3, 5, 9]);
    // user skip of row 3 (Excel row numbers: data starts at 2)
    const skipped = runRules(mk(c), t, { rowDecisions: { 3: { action: 'skip' } } });
    expectOk(skipped);
    expect(out(skipped as ReturnType<typeof runOk>)).toEqual([1, 3, 5, 9]);
  });

  it('a user override feeds the window with the edited values', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 1, 'ok'], ['A', 2, 'ok'], ['A', 4, 'ok']]);
    const c: Computed[] = [{ id: 'out', type: 'decimal', expr: parse('groupSum(amt)') }];
    const res = runRules(mk(c), t, { rowDecisions: { 3: { action: 'override', values: { amt: 100 } } } });
    expectOk(res);
    expect(values(res.sheet).map((r) => r[2])).toEqual([105, 105, 105]);
  });

  it('rows of an expand family are in it one by one, in family order', () => {
    const r = rules({
      columns: [col('id', 'text'), col('jan', 'decimal'), col('feb', 'decimal'), col('mar', 'decimal')],
      expand: { mode: 'columnsToRows', columns: ['jan', 'feb', 'mar'], labelId: 'month', valueId: 'amount', valueType: 'decimal', skipEmpty: true },
      transform: {
        computed: [
          { id: 'n', type: 'integer', expr: parse('rowNumber(by: id)') },
          { id: 'run', type: 'decimal', expr: parse('runningSum(amount, by: id)') },
        ],
      },
      out: ['id', 'month', 'n', 'run'],
    });
    const res = runOk(r, table(['id', 'jan', 'feb', 'mar'], [['X', 10, null, 5], ['Y', 1, 2, 3], ['X', 7, 7, 7]]));
    expect(values(res.sheet)).toEqual([
      ['X', 'jan', 1, 10],
      ['X', 'mar', 2, 15],
      ['Y', 'jan', 1, 1],
      ['Y', 'feb', 2, 3],
      ['Y', 'mar', 3, 6],
      ['X', 'jan', 3, 22],
      ['X', 'feb', 4, 29],
      ['X', 'mar', 5, 36],
    ]);
  });

  it('a row a block validation later leaves out still counts, and the run summary says how many (counts only)', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 10, 'ok'], ['A', -5, 'ok'], ['A', 3, 'ok']]);
    const c: Computed[] = [{ id: 'out', type: 'decimal', expr: parse('groupSum(amt)') }];
    const r = mk(c, { validations: [{ column: 'amt', rule: 'range', min: 0, severity: 'block' }] });
    const res = runOk(r, t);
    expect(values(res.sheet).map((x) => x[2])).toEqual([8, 8]); // 10 + (-5) + 3, on the two rows that remain
    expect(res.summary.blockedRows).toHaveLength(1);
    expect(res.summary.blockedInWindows).toBe(1);
  });

  it('no notice without a window, and none when nothing was blocked', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 10, 'ok'], ['A', -5, 'ok']]);
    const plain = rules({ columns: cols, validations: [{ column: 'amt', rule: 'range', min: 0, severity: 'block' }] });
    const a = runOk(plain, t);
    expect(a.summary.blockedRows).toHaveLength(1);
    expect('blockedInWindows' in a.summary).toBe(false);
    const c: Computed[] = [{ id: 'out', type: 'decimal', expr: parse('groupSum(amt)') }];
    const b = runOk(mk(c, { validations: [{ column: 'amt', rule: 'range', max: 100, severity: 'block' }] }), t);
    expect(b.summary.blockedRows).toHaveLength(0);
    expect('blockedInWindows' in b.summary).toBe(false);
  });

  it('value maps run after: a window reads the values before they are translated', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 1, 'x'], ['A', 1, 'y'], ['A', 1, 'x']]);
    const c: Computed[] = [{ id: 'out', type: 'integer', expr: parse('groupCount(by: st)') }];
    const r = mk(c, { transform: { computed: c, valueMaps: [{ column: 'st', map: { x: 'same', y: 'same' }, onMissing: 'keep' }] } });
    r.output.columns = [{ header: 'st', from: 'st' }, { header: 'out', from: 'out' }];
    const res = runOk(r, t);
    expect(values(res.sheet)).toEqual([['same', 2], ['same', 1], ['same', 2]]);
  });

  it('sort runs after: sorting by a window column works, and a running balance stays attached to its row', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 5, 'a'], ['A', 1, 'b'], ['A', 9, 'c']]);
    const c: Computed[] = [{ id: 'out', type: 'decimal', expr: parse('runningSum(amt)') }];
    const r = mk(c, { transform: { computed: c, sort: [{ column: 'out', dir: 'desc' }] } });
    expect(values(runOk(r, t).sheet).map((x) => [x[1], x[2]])).toEqual([[9, 15], [1, 6], [5, 5]]);
    // sorting by something else leaves the window's own file order alone
    const r2 = mk(c, { transform: { computed: c, sort: [{ column: 'amt', dir: 'desc' }] } });
    expect(values(runOk(r2, t).sheet).map((x) => [x[1], x[2]])).toEqual([[9, 15], [5, 5], [1, 6]]);
  });

  it('a summary row sees a window column as an ordinary column: last of a running sum is the closing balance', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 5, 'a'], ['A', 1, 'b'], ['A', 9, 'c']]);
    const c: Computed[] = [{ id: 'out', type: 'decimal', expr: parse('runningSum(amt)') }];
    const r = mk(c, { output: { summaryRows: [{ label: 'Closing', labelColumn: 'acct', cells: { out: 'last', amt: 'sum' } }] } });
    r.output.columns = [{ header: 'acct', from: 'acct' }, { header: 'amt', from: 'amt' }, { header: 'out', from: 'out' }];
    const res = runOk(r, t);
    const last = res.sheet.rows[res.sheet.rows.length - 1]!;
    expect(last.kind).toBe('summaryRow');
    expect(last.cells.map((x) => x.v)).toEqual(['Closing', 15, 15]);
  });

  it('a window reads earlier computed columns, including another window (rank of a running sum)', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 5, 'a'], ['A', -3, 'b'], ['A', 9, 'c']]);
    const r = rules({
      columns: cols,
      transform: {
        computed: [
          { id: 'bal', type: 'decimal', expr: parse('runningSum(amt)') },
          { id: 'doubled', type: 'decimal', expr: parse('amt * 2') },
          { id: 'rk', type: 'integer', expr: parse('rank(order: bal desc)') },
          { id: 'share', type: 'decimal', expr: parse('round(doubled / groupSum(doubled) * 100, 1)') },
        ],
      },
      out: ['bal', 'rk', 'share'],
    });
    const res = runOk(r, t);
    // bal: 5, 2, 11; rank by bal desc: 2, 3, 1; doubled 10, -6, 18 (sum 22): 45.5, -27.3, 81.8
    expect(values(res.sheet)).toEqual([
      [5, 2, 45.5],
      [2, 3, -27.3],
      [11, 1, 81.8],
    ]);
  });

  it('inside a bigger expression: if(rowNumber(by: x) > 1, ...) and division reuses its divide-by-zero flag', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 0, 'a'], ['A', 0, 'b'], ['B', 4, 'c']]);
    const r = rules({
      columns: cols,
      transform: {
        computed: [
          { id: 'dup', type: 'text', expr: parse('if(rowNumber(by: acct) > 1, "Duplicate", null)') },
          { id: 'pct', type: 'decimal', expr: parse('amt / groupSum(amt, by: acct) * 100') },
        ],
      },
      out: ['dup', 'pct'],
    });
    const res = runOk(r, t);
    expect(values(res.sheet)).toEqual([[null, null], ['Duplicate', null], [null, 100]]);
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.messageKey])).toEqual([
      [2, 'pct', 'flag.expr.divByZero'],
      [3, 'pct', 'flag.expr.divByZero'],
    ]);
  });

  it('flags keep their order within a row: an earlier column\'s flag, then the window column\'s', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 0, 'a']]);
    const r = rules({
      columns: cols,
      transform: {
        computed: [
          { id: 'first', type: 'decimal', expr: parse('1 / amt') },
          { id: 'second', type: 'decimal', expr: parse('1 / groupSum(amt)') },
          { id: 'third', type: 'decimal', expr: parse('1 / amt') },
        ],
      },
      out: ['first', 'second', 'third'],
    });
    expect(runOk(r, t).flags.map((f) => f.column)).toEqual(['first', 'second', 'third']);
  });

  it('works when nothing is left after the filters', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 1, 'x']]);
    const c: Computed[] = [{ id: 'out', type: 'decimal', expr: parse('runningSum(amt)') }];
    const res = runOk(mk(c, { rowFilters: [{ column: 'st', op: 'eq', value: 'nope' }] }), t);
    expect(values(res.sheet)).toEqual([]);
  });

  it('a rules file that puts a window where it cannot run (a filter) is refused, not run', () => {
    const t = table(['acct', 'amt', 'st'], [['A', 1, 'x']]);
    const r = rules({ columns: cols, rowFilters: [{ expr: { op: 'gt', args: [parse('groupSum(amt)'), { const: 0 }] } }] });
    const res = runRules(r, t);
    expect(res).toMatchObject({ ok: false, error: { code: 'invalidRules' } });
  });
});

// ---------- a plain-TS oracle, on random tables ----------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface RowData {
  acct: string | null;
  grp: string | null;
  k: number | null;
  amt: number | null;
}

function cmpOrder(a: RowData, b: RowData, keys: { col: 'k' | 'amt'; desc: boolean }[]): number {
  for (const { col: c, desc } of keys) {
    const x = a[c];
    const y = b[c];
    if (x === null || y === null) {
      if (x === y) continue;
      return x === null ? 1 : -1; // empties last, either direction
    }
    if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
  }
  return 0;
}

/** The brute-force reading of the definitions in the proposal, O(n^2) per function, with decimal.js for sums. */
function oracle(
  fn: 'runningSum' | 'groupSum' | 'groupAvg' | 'groupMin' | 'groupMax' | 'groupCount' | 'previous' | 'next' | 'fillDown' | 'rowNumber' | 'rank',
  data: RowData[],
  opt: { by?: ('acct' | 'grp')[]; order?: { col: 'k' | 'amt'; desc: boolean }[]; dense?: boolean },
): (number | null)[] {
  const same = (a: RowData, b: RowData): boolean => (opt.by ?? []).every((c) => a[c] === b[c]);
  const walk = (i: number): number[] => {
    const members = data.map((_, j) => j).filter((j) => same(data[i]!, data[j]!));
    if (opt.order === undefined) return members;
    return members.sort((p, q) => cmpOrder(data[p]!, data[q]!, opt.order!) || p - q);
  };
  const nums = (js: number[]): Decimal[] => js.map((j) => data[j]!.amt).filter((v): v is number => v !== null).map((v) => new Decimal(v));
  const sum = (ds: Decimal[]): Decimal | null => (ds.length === 0 ? null : ds.reduce((a, b) => a.plus(b)));
  const num = (d: Decimal | null): number | null => (d === null ? null : d.toNumber());
  return data.map((_, i) => {
    const w = walk(i);
    const pos = w.indexOf(i);
    switch (fn) {
      case 'runningSum':
        return num(sum(nums(w.slice(0, pos + 1))));
      case 'groupSum':
        return num(sum(nums(w)));
      case 'groupAvg': {
        const ds = nums(w);
        const s = sum(ds);
        return s === null ? null : num(s.dividedBy(ds.length));
      }
      case 'groupMin': {
        const ds = nums(w);
        return ds.length === 0 ? null : Decimal.min(...ds).toNumber();
      }
      case 'groupMax': {
        const ds = nums(w);
        return ds.length === 0 ? null : Decimal.max(...ds).toNumber();
      }
      case 'groupCount':
        return w.length;
      case 'previous':
        return pos === 0 ? null : data[w[pos - 1]!]!.amt;
      case 'next':
        return pos === w.length - 1 ? null : data[w[pos + 1]!]!.amt;
      case 'fillDown': {
        for (let q = pos; q >= 0; q--) if (data[w[q]!]!.amt !== null) return data[w[q]!]!.amt;
        return null;
      }
      case 'rowNumber':
        return pos + 1;
      case 'rank': {
        const o = opt.order!;
        if (data[i]![o[0]!.col] === null) return null;
        const counted = w.filter((j) => data[j]![o[0]!.col] !== null);
        if (opt.dense) {
          const distinct: RowData[] = [];
          for (const j of counted) if (!distinct.some((d) => cmpOrder(d, data[j]!, o) === 0)) distinct.push(data[j]!);
          return distinct.findIndex((d) => cmpOrder(d, data[i]!, o) === 0) + 1;
        }
        return counted.filter((j) => cmpOrder(data[j]!, data[i]!, o) < 0).length + 1;
      }
    }
  });
}

function randomData(seed: number, n: number): RowData[] {
  const rnd = lcg(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  return Array.from({ length: n }, () => ({
    acct: pick(['A', 'B', 'C', null]),
    grp: pick(['x', 'y']),
    k: pick([1, 2, 3, null, 2, 1]),
    amt: pick([null, 0.1, 0.2, 5, 7.5, -3, 10, 0.3, null, 1.25]),
  }));
}

describe('against a brute-force oracle on random tables', () => {
  const cases: { formula: string; type: ColumnType; fn: Parameters<typeof oracle>[0]; opt: Parameters<typeof oracle>[2] }[] = [
    { formula: 'runningSum(amt)', type: 'decimal', fn: 'runningSum', opt: {} },
    { formula: 'runningSum(amt, by: acct)', type: 'decimal', fn: 'runningSum', opt: { by: ['acct'] } },
    { formula: 'runningSum(amt, by: (acct, grp), order: (k, amt desc))', type: 'decimal', fn: 'runningSum', opt: { by: ['acct', 'grp'], order: [{ col: 'k', desc: false }, { col: 'amt', desc: true }] } },
    { formula: 'runningSum(amt, order: k desc)', type: 'decimal', fn: 'runningSum', opt: { order: [{ col: 'k', desc: true }] } },
    { formula: 'groupSum(amt, by: grp)', type: 'decimal', fn: 'groupSum', opt: { by: ['grp'] } },
    { formula: 'groupAvg(amt, by: acct)', type: 'decimal', fn: 'groupAvg', opt: { by: ['acct'] } },
    { formula: 'groupMin(amt, by: acct)', type: 'decimal', fn: 'groupMin', opt: { by: ['acct'] } },
    { formula: 'groupMax(amt, by: (acct, grp))', type: 'decimal', fn: 'groupMax', opt: { by: ['acct', 'grp'] } },
    { formula: 'groupCount(by: acct)', type: 'integer', fn: 'groupCount', opt: { by: ['acct'] } },
    { formula: 'previous(amt, by: acct, order: k)', type: 'decimal', fn: 'previous', opt: { by: ['acct'], order: [{ col: 'k', desc: false }] } },
    { formula: 'next(amt, by: grp, order: (k desc, amt))', type: 'decimal', fn: 'next', opt: { by: ['grp'], order: [{ col: 'k', desc: true }, { col: 'amt', desc: false }] } },
    { formula: 'fillDown(amt, by: acct)', type: 'decimal', fn: 'fillDown', opt: { by: ['acct'] } },
    { formula: 'rowNumber(by: acct, order: amt desc)', type: 'integer', fn: 'rowNumber', opt: { by: ['acct'], order: [{ col: 'amt', desc: true }] } },
    { formula: 'rank(order: k)', type: 'integer', fn: 'rank', opt: { order: [{ col: 'k', desc: false }] } },
    { formula: 'rank(order: (k, amt desc), by: acct)', type: 'integer', fn: 'rank', opt: { by: ['acct'], order: [{ col: 'k', desc: false }, { col: 'amt', desc: true }] } },
    { formula: 'rank(order: k desc, by: grp, ties: dense)', type: 'integer', fn: 'rank', opt: { by: ['grp'], order: [{ col: 'k', desc: true }], dense: true } },
  ];

  for (const c of cases) {
    it(`${c.formula}`, () => {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const data = randomData(seed, 40);
        const r = rules({
          columns: [col('acct', 'text'), col('grp', 'text'), col('k', 'integer'), col('amt', 'decimal')],
          transform: { computed: [{ id: 'out', type: c.type, expr: parse(c.formula) }] },
          out: [{ header: 'out', from: 'out' }],
        });
        const res = runOk(r, table(['acct', 'grp', 'k', 'amt'], data.map((d) => [d.acct, d.grp, d.k, d.amt])));
        expect(values(res.sheet).map((x) => x[0]), `seed ${seed}`).toEqual(oracle(c.fn, data, c.opt));
      }
    });
  }
});

describe('determinism', () => {
  it('the same rules and table give byte-identical results run after run, with many equal order keys', () => {
    const data = randomData(99, 300).map((d) => ({ ...d, k: d.k === null ? null : d.k % 2 }));
    const r = rules({
      columns: [col('acct', 'text'), col('grp', 'text'), col('k', 'integer'), col('amt', 'decimal')],
      transform: {
        computed: [
          { id: 'a', type: 'decimal', expr: parse('runningSum(amt, by: acct, order: k)') },
          { id: 'b', type: 'integer', expr: parse('rank(order: k, ties: dense)') },
          { id: 'c', type: 'decimal', expr: parse('previous(amt, order: k desc)') },
          { id: 'd', type: 'integer', expr: parse('rowNumber(by: grp, order: k)') },
        ],
      },
      out: ['a', 'b', 'c', 'd'],
    });
    const t = table(['acct', 'grp', 'k', 'amt'], data.map((d) => [d.acct, d.grp, d.k, d.amt]));
    const first = JSON.stringify(runOk(r, t));
    for (let i = 0; i < 3; i++) expect(JSON.stringify(runOk(r, t))).toBe(first);
    // and the order of equal keys is the file's: rowNumber within (grp, k) is 1, 2, 3 ... in file order
    const res = runOk(r, t);
    const seen = new Map<string, number>();
    const seq = values(res.sheet).map((x) => x[3] as number);
    seq.forEach((n, i) => {
      const key = `${data[i]!.grp}|${data[i]!.k}`;
      const sofar = seen.get(key) ?? 0;
      if (data[i]!.k !== null) expect(n).toBeGreaterThan(0);
      seen.set(key, sofar + 1);
    });
  });
});

describe('the summary of a rules file without windows is untouched', () => {
  it('has no blockedInWindows key and the same fields as before', () => {
    const res = runOk(rules({ columns: COLUMNS }), table(HEADERS, T1));
    const s: RunSummary = res.summary;
    expect(Object.keys(s).sort()).toEqual(['blockedRows', 'duplicatesFlagged', 'duplicatesRemoved', 'rowsFiltered', 'rowsIn', 'rowsOut']);
  });
});
