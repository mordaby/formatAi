import type { Expand } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/pipeline';
import { col, dataRows, rules, runOk, table, values } from './helpers';

describe('expand: columnsToRows', () => {
  const columns = [
    col('agent', 'idLike'),
    col('jan', 'decimal', { header: 'ינואר' }),
    col('feb', 'decimal', { header: 'פברואר' }),
    col('mar', 'decimal', { header: 'מרץ' }),
  ];
  const t = table(
    ['agent', 'ינואר ', 'פברואר', 'מרץ'],
    [
      ['A', 100, '200', null], // 2
      ['B', null, null, null], // 3: all months empty
      ['C', 'oops', 5, 7], // 4: a bad value
    ],
  );
  const ex = (over: Partial<Extract<Expand, { mode: 'columnsToRows' }>> = {}): Expand => ({
    mode: 'columnsToRows',
    columns: ['jan', 'feb', 'mar'],
    labelId: 'month',
    valueId: 'amount',
    valueType: 'decimal',
    skipEmpty: true,
    ...over,
  });

  it('one row per non-empty listed column; labels default to the rules headers', () => {
    const res = runOk(rules({ columns, expand: ex(), out: ['agent', 'month', 'amount'] }), t);
    expect(values(res.sheet)).toEqual([
      ['A', 'ינואר', 100],
      ['A', 'פברואר', 200],
      ['C', 'ינואר', 'oops'],
      ['C', 'פברואר', 5],
      ['C', 'מרץ', 7],
    ]);
    expect(dataRows(res.sheet).map((r) => r.sourceRow)).toEqual([2, 2, 4, 4, 4]);
    // The parse failure is flagged once (on the input row), and the moved value cell is highlighted.
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.messageKey])).toEqual([[4, 'jan', 'flag.parseFailed.number']]);
    expect(dataRows(res.sheet)[2]!.cells[2]!.flagged).toBe(true);
    expect(dataRows(res.sheet)[3]!.cells[2]!.flagged).toBeUndefined();
    expect(res.summary.rowsOut).toBe(5);
  });

  it('skipEmpty false keeps empty cells; explicit labels override', () => {
    const res = runOk(
      rules({ columns, expand: ex({ skipEmpty: false, labels: { jan: '01', mar: '03' } }), out: ['agent', 'month', 'amount'] }),
      table(['agent', 'ינואר', 'פברואר', 'מרץ'], [['B', null, 1, null]]),
    );
    expect(values(res.sheet)).toEqual([
      ['B', '01', null],
      ['B', 'פברואר', 1],
      ['B', '03', null],
    ]);
  });

  it('the listed columns are gone after expand', () => {
    const r = rules({ columns, expand: ex(), out: ['agent', 'jan'] });
    const res = runRules(r, t);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalidRules');
  });

  it('valueType coerces the moved values', () => {
    const cols = [col('k'), col('x', 'text'), col('y', 'text')];
    const res = runOk(
      rules({ columns: cols, expand: { mode: 'columnsToRows', columns: ['x', 'y'], labelId: 'l', valueId: 'v', valueType: 'decimal', skipEmpty: true }, out: ['k', 'l', 'v'] }),
      table(['k', 'x', 'y'], [['r', '1,500', 'n/a']]),
    );
    expect(values(res.sheet)).toEqual([
      ['r', 'x', 1500],
      ['r', 'y', 'n/a'],
    ]);
    expect(res.flags.map((f) => [f.column, f.messageKey])).toEqual([['v', 'flag.parseFailed.number']]);
  });
});

describe('expand: splitCell', () => {
  const columns = [col('policy', 'idLike'), col('products', 'text'), col('amount', 'decimal')];
  const t = table(
    ['policy', 'products', 'amount'],
    [
      ['P1', 'חיים; בריאות', 300], // 2: 2 parts
      ['P2', 'רכב', 90], // 3: 1 part
      ['P3', 'א;ב;;ג; ', 100], // 4: empty parts
      ['P4', null, 50], // 5: empty cell
    ],
  );
  const split = (skipEmpty: boolean, trim = true): Expand => ({
    mode: 'splitCell',
    column: 'products',
    separator: ';',
    trim,
    partId: 'product',
    indexId: 'idx',
    countId: 'n',
    skipEmpty,
  });

  it('families of uneven size, index/count, and a computed column after expand (amount ÷ count)', () => {
    const r = rules({
      columns,
      expand: split(true),
      transform: {
        computed: [
          {
            id: 'share',
            type: 'decimal',
            expr: { op: 'round', digits: 2, arg: { op: 'div', args: [{ col: 'amount' }, { col: 'n' }] } },
          },
        ],
      },
      out: ['policy', 'product', 'idx', 'n', 'share', 'products'],
    });
    const res = runOk(r, t);
    expect(values(res.sheet)).toEqual([
      ['P1', 'חיים', 1, 2, 150, 'חיים; בריאות'],
      ['P1', 'בריאות', 2, 2, 150, 'חיים; בריאות'],
      ['P2', 'רכב', 1, 1, 90, 'רכב'],
      ['P3', 'א', 1, 3, 33.33, 'א;ב;;ג; '],
      ['P3', 'ב', 2, 3, 33.33, 'א;ב;;ג; '],
      ['P3', 'ג', 3, 3, 33.33, 'א;ב;;ג; '],
    ]);
    expect(dataRows(res.sheet).map((x) => x.sourceRow)).toEqual([2, 2, 3, 4, 4, 4]);
    expect(res.sheet.columns.map((c) => c.numeric === true)).toEqual([false, false, true, true, true, false]);
  });

  it('skipEmpty false keeps empty parts and gives an empty cell one row', () => {
    const res = runOk(rules({ columns, expand: split(false), out: ['policy', 'product', 'idx', 'n'] }), t);
    expect(values(res.sheet).filter((r) => r[0] === 'P3' || r[0] === 'P4')).toEqual([
      ['P3', 'א', 1, 5],
      ['P3', 'ב', 2, 5],
      ['P3', null, 3, 5],
      ['P3', 'ג', 4, 5],
      ['P3', null, 5, 5],
      ['P4', null, 1, 1],
    ]);
  });

  it('without trim, parts keep their spaces', () => {
    const res = runOk(rules({ columns, expand: split(true, false), out: ['product'] }), table(['policy', 'products', 'amount'], [['P', 'a; b', 1]]));
    expect(values(res.sheet)).toEqual([['a'], [' b']]);
  });
});

describe('expand: fixedFanOut', () => {
  it('each row becomes N rows in order; set exprs are evaluated on the source row', () => {
    const r = rules({
      columns: [col('acct', 'idLike'), col('amount', 'decimal')],
      expand: {
        mode: 'fixedFanOut',
        rows: [
          { set: { side: { const: 'חובה' } } },
          { set: { side: { const: 'זכות' }, amount: { op: 'neg', arg: { col: 'amount' } }, orig: { col: 'amount' } } },
        ],
      },
      out: ['acct', 'side', 'amount', 'orig'],
    });
    const res = runOk(r, table(['acct', 'amount'], [['100', 250], ['200', '1,000.50']]));
    expect(values(res.sheet)).toEqual([
      ['100', 'חובה', 250, null],
      ['100', 'זכות', -250, 250],
      ['200', 'חובה', 1000.5, null],
      ['200', 'זכות', -1000.5, 1000.5],
    ]);
    expect(dataRows(res.sheet).map((x) => x.sourceRow)).toEqual([2, 2, 3, 3]);
    // amount keeps its declared (numeric) type; the new id's type is inferred from its values.
    expect(res.sheet.columns.map((c) => c.numeric === true)).toEqual([false, false, true, true]);
  });

  it('families stay together through a stable sort, and flags from set exprs land on the new row', () => {
    const r = rules({
      columns: [col('k'), col('a', 'decimal'), col('b', 'decimal')],
      expand: {
        mode: 'fixedFanOut',
        rows: [{ set: { part: { const: 1 } } }, { set: { part: { const: 2 }, q: { op: 'div', args: [{ col: 'a' }, { col: 'b' }] } } }],
      },
      transform: { sort: [{ column: 'k', dir: 'asc' }] },
      out: ['k', 'part', 'q'],
    });
    const res = runOk(r, table(['k', 'a', 'b'], [['z', 1, 0], ['a', 6, 3]]));
    expect(values(res.sheet)).toEqual([
      ['a', 1, null],
      ['a', 2, 2],
      ['z', 1, null],
      ['z', 2, null],
    ]);
    expect(res.flags).toEqual([{ rowNumber: 2, column: 'q', rule: 'expr', value: null, messageKey: 'flag.expr.divByZero' }]);
    expect(dataRows(res.sheet)[3]!.cells[2]!.flagged).toBe(true);
    expect(dataRows(res.sheet)[2]!.cells[2]!.flagged).toBeUndefined();
  });
});
