// The formula text of the across-row (window) functions: named arguments (`by:`, `order:`, `ties:`), the lexer's `:` token, where they
// are allowed, the errors and their offsets, the print/parse round trip, and the learn side's view of the names (promptOpsOnly).
import type { Computed, Expr, LearnResult } from '@formatai/shared';
import { WINDOW_FNS } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { WINDOW_SIGNATURES } from '../../src/check/signatures';
import { canonicalizeRules, formulaRulesFromWire, formulaRulesToWire, parseFormula, printFormula, tokenize } from '../../src/formula';
import { col, rules } from '../pipeline/helpers';

const ok = (text: string): Expr => {
  const r = parseFormula(text, { allowWindows: true });
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error.message} at ${r.error.offset}`);
  return r.expr;
};
const err = (text: string, ctx: Parameters<typeof parseFormula>[1] = { allowWindows: true }) => {
  const r = parseFormula(text, ctx);
  if (r.ok) throw new Error(`expected an error, parsed to ${JSON.stringify(r.expr)}`);
  return r.error;
};

describe('the lexer', () => {
  it('has a ":" token (an error before windows)', () => {
    expect(tokenize('by: a').map((t) => t.type)).toEqual(['ident', ':', 'ident', 'eof']);
  });
});

describe('window calls: what they parse to', () => {
  it('a column and named arguments', () => {
    expect(ok('runningSum(amount)')).toEqual({ op: 'window', fn: 'runningSum', arg: { col: 'amount' } });
    expect(ok('runningSum(amount, by: account, order: date)')).toEqual({
      op: 'window',
      fn: 'runningSum',
      arg: { col: 'amount' },
      by: ['account'],
      order: [{ column: 'date', dir: 'asc' }],
    });
  });

  it('several by: and order: keys, each order key with its own direction', () => {
    expect(ok('runningSum(amount, by: (account, branch), order: (date, txnId desc, seq asc))')).toEqual({
      op: 'window',
      fn: 'runningSum',
      arg: { col: 'amount' },
      by: ['account', 'branch'],
      order: [
        { column: 'date', dir: 'asc' },
        { column: 'txnId', dir: 'desc' },
        { column: 'seq', dir: 'asc' },
      ],
    });
  });

  it('a single key may be written in parentheses', () => {
    expect(ok('groupSum(a, by: (g))')).toEqual(ok('groupSum(a, by: g)'));
    expect(ok('previous(a, order: (k desc))')).toEqual(ok('previous(a, order: k desc)'));
  });

  it('named arguments in any order, spaces anywhere', () => {
    expect(ok('previous( a ,order : k desc , by : g )')).toEqual(ok('previous(a, by: g, order: k desc)'));
  });

  it('the functions with no column', () => {
    expect(ok('rowNumber()')).toEqual({ op: 'window', fn: 'rowNumber' });
    expect(ok('rowNumber(by: invoice)')).toEqual({ op: 'window', fn: 'rowNumber', by: ['invoice'] });
    expect(ok('groupCount(by: customer)')).toEqual({ op: 'window', fn: 'groupCount', by: ['customer'] });
    expect(ok('groupCount()')).toEqual({ op: 'window', fn: 'groupCount' });
    expect(ok('groupCount(x)')).toEqual({ op: 'window', fn: 'groupCount', arg: { col: 'x' } });
    expect(ok('rank(order: sales desc, ties: dense)')).toEqual({ op: 'window', fn: 'rank', order: [{ column: 'sales', dir: 'desc' }], ties: 'dense' });
    expect(ok('rank(order: sales)')).toEqual({ op: 'window', fn: 'rank', order: [{ column: 'sales', dir: 'asc' }] });
  });

  it('all eleven names parse', () => {
    const text: Record<string, string> = {
      runningSum: 'runningSum(x)',
      groupSum: 'groupSum(x)',
      groupAvg: 'groupAvg(x)',
      groupMin: 'groupMin(x)',
      groupMax: 'groupMax(x)',
      groupCount: 'groupCount()',
      previous: 'previous(x)',
      next: 'next(x)',
      fillDown: 'fillDown(x)',
      rowNumber: 'rowNumber()',
      rank: 'rank(order: x)',
    };
    expect(Object.keys(text).sort()).toEqual([...WINDOW_FNS].sort());
    for (const fn of WINDOW_FNS) expect(ok(text[fn] as string)).toMatchObject({ op: 'window', fn });
  });

  it('inside an expression, next to ordinary operators', () => {
    expect(ok('round(amount / groupSum(amount) * 100, 1)')).toEqual({
      op: 'round',
      digits: 1,
      arg: {
        op: 'mul',
        args: [{ op: 'div', args: [{ col: 'amount' }, { op: 'window', fn: 'groupSum', arg: { col: 'amount' } }] }, { const: 100 }],
      },
    });
    expect(ok('if(rowNumber(by: invoice) > 1, "Duplicate", null)')).toMatchObject({ op: 'if', cond: { op: 'gt', args: [{ op: 'window', fn: 'rowNumber', by: ['invoice'] }, { const: 1 }] } });
  });

  it('a column called like a keyword is still a column: desc, asc, by, order, ties, rank', () => {
    expect(ok('runningSum(by, by: order, order: desc)')).toEqual({
      op: 'window',
      fn: 'runningSum',
      arg: { col: 'by' },
      by: ['order'],
      order: [{ column: 'desc', dir: 'asc' }],
    });
    expect(ok('previous(rank, order: (asc, desc desc))')).toMatchObject({ order: [{ column: 'asc', dir: 'asc' }, { column: 'desc', dir: 'desc' }] });
    expect(ok('rank')).toEqual({ col: 'rank' }); // no parenthesis: a column
  });
});

describe('window calls: errors, with offsets', () => {
  it('an expression where the column goes: "make a computed column first"', () => {
    const e = err('runningSum(amount * 2)');
    expect(e.message).toMatch(/column id, not an expression/);
    expect(e.message).toMatch(/computed column/);
    expect(e.offset).toBe(11);
    expect(err('groupSum(round(amount, 2), by: g)').offset).toBe(9);
  });

  it('positional extras are rejected: runningSum(amount, account, date)', () => {
    const e = err('runningSum(amount, account, date)');
    expect(e.message).toMatch(/named arguments/);
    expect(e.message).toMatch(/by:/);
    expect(e.offset).toBe(19);
    expect(err('groupSum(a, g)').offset).toBe(12);
  });

  it('a positional after a named argument is rejected too', () => {
    expect(err('runningSum(by: g, amount)').offset).toBe(18);
  });

  it('a column where a function takes none: rowNumber(x), rank(x)', () => {
    expect(err('rowNumber(x)').message).toMatch(/takes no column/);
    const e = err('rank(sales)');
    expect(e.message).toMatch(/takes no column/);
    expect(e.message).toMatch(/order:/);
  });

  it('a missing column', () => {
    expect(err('runningSum()').message).toMatch(/needs a column/);
    expect(err('runningSum(by: g)').message).toMatch(/needs a column/);
    expect(err('previous(order: k)').message).toMatch(/needs a column/);
  });

  it('rank without order:', () => {
    expect(err('rank()').message).toMatch(/needs order:/);
    expect(err('rank(by: g)').message).toMatch(/needs order:/);
  });

  it('order: on a group function', () => {
    for (const f of ['groupSum(a, order: k)', 'groupAvg(a, order: k)', 'groupMin(a, order: k)', 'groupMax(a, order: k)', 'groupCount(order: k)']) {
      const e = err(f);
      expect(e.message, f).toMatch(/does not take order:/);
      expect(e.offset, f).toBe(f.indexOf('order'));
    }
  });

  it('ties: only on rank, and only min or dense', () => {
    expect(err('runningSum(a, ties: min)').message).toMatch(/does not take ties:/);
    expect(err('rank(order: k, ties: max)').message).toMatch(/must be min or dense/);
    expect(err('rank(order: k, ties: "min")').message).toMatch(/min" or "dense|"min" or "dense"/);
  });

  it('an unknown or repeated named argument', () => {
    const unknown = err('runningSum(a, group: g)');
    expect(unknown.message).toMatch(/unknown argument "group:"/);
    expect(unknown.offset).toBe(14);
    expect(err('runningSum(a, by: g, by: h)').message).toMatch(/by: twice/);
    expect(err('previous(a, order: k, order: j)').message).toMatch(/order: twice/);
    expect(err('rank(order: k, ties: min, ties: dense)').message).toMatch(/ties: twice/);
  });

  it('empty or malformed by: / order: values', () => {
    expect(err('groupSum(a, by: )').offset).toBe(16);
    expect(err('groupSum(a, by: ())').message).toMatch(/column id/);
    expect(err('groupSum(a, by: (g,))').message).toMatch(/column id/);
    expect(err('previous(a, order: )').offset).toBe(19);
    expect(err('previous(a, order: (k desc,))').message).toMatch(/column id/);
    expect(err('groupSum(a, by: "g")').message).toMatch(/column id/);
  });

  it('a window cannot be the argument of a window (the column is a bare id)', () => {
    expect(err('runningSum(groupSum(a))').message).toMatch(/column id, not an expression/);
  });

  it('a colon anywhere else is a parse error', () => {
    expect(err('a : b').message).toMatch(/unexpected token ":"/);
    expect(err('round(a: 1, 2)').message).toMatch(/expected|unexpected/);
  });

  it('too deeply nested still stops cleanly', () => {
    const deep = `${'('.repeat(40)}runningSum(a)${')'.repeat(40)}`;
    expect(err(deep).message).toMatch(/nested too deeply/);
  });
});

describe('where windows may be written', () => {
  it('not by default: a filter, a fan-out value and a function body read them as a parse error', () => {
    const e = err('runningSum(amount)', {});
    expect(e.message).toMatch(/works only in a computed column/);
    expect(e.offset).toBe(0);
    expect(err('amount > groupAvg(amount)', {}).offset).toBe(9);
    expect(err('rowNumber()', { params: ['x'] }).message).toMatch(/works only in a computed column/);
  });

  it('with allowWindows (a computed column) they do', () => {
    expect(parseFormula('runningSum(amount)', { allowWindows: true }).ok).toBe(true);
  });

  it('formulaRulesFromWire turns them on for computed columns only', () => {
    const wire = {
      input: { rowFilters: [{ expr: 'groupSum(amount) > 3' }] },
      transform: { computed: [{ id: 'c', type: 'decimal', expr: 'runningSum(amount, by: acct)' }] },
    };
    const { rules: out, problems } = formulaRulesFromWire(wire);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'formula', path: 'input.rowFilters[0].expr' });
    expect((out as { transform: { computed: Computed[] } }).transform.computed[0]!.expr).toMatchObject({ op: 'window', fn: 'runningSum', by: ['acct'] });
    const fan = formulaRulesFromWire({ transform: { computed: [], expand: { mode: 'fixedFanOut', rows: [{ set: { n: 'rowNumber()' } }] } } });
    expect(fan.problems).toHaveLength(1);
    expect(fan.problems[0]).toMatchObject({ path: 'transform.expand.rows[0].set.n' });
  });

  it('promptOpsOnly (the API reading an AI answer): the names are not built-ins, so they are unknown functions', () => {
    for (const text of ['runningSum(a)', 'groupCount()', 'rowNumber()', 'rank()', 'previous(a)']) {
      const r = parseFormula(text, { promptOpsOnly: true, allowWindows: true });
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(r.expr, text).toMatchObject({ op: 'call' });
    }
    // with named arguments there is no function call to fall back to: an error
    expect(parseFormula('runningSum(a, by: g)', { promptOpsOnly: true, allowWindows: true }).ok).toBe(false);
    const { problems } = formulaRulesFromWire({ transform: { computed: [{ id: 'c', type: 'decimal', expr: 'runningSum(a, by: g)' }] } }, { promptOpsOnly: true });
    expect(problems).toHaveLength(1);
  });
});

describe('print and parse round trip', () => {
  const texts = [
    'runningSum(amount)',
    'runningSum(amount, by: account, order: date)',
    'runningSum(amount, by: (account, branch), order: (date, txnId desc))',
    'groupSum(amount, by: dept)',
    'groupAvg(amount, by: dept)',
    'groupMin(when, by: dept)',
    'groupMax(amount)',
    'groupCount(by: customer)',
    'groupCount(x, by: customer)',
    'groupCount()',
    'previous(reading)',
    'next(reading, by: meter, order: when)',
    'fillDown(cat)',
    'rowNumber()',
    'rowNumber(by: invoice, order: (when desc, id))',
    'rank(order: sales desc)',
    'rank(by: region, order: (sales desc, name), ties: dense)',
    'rank(order: sales, ties: min)',
    'round(amount / groupSum(amount) * 100, 1)',
    'if(rowNumber(by: invoice) > 1, "Duplicate", null)',
    'runningSum(a, by: g) - previous(runningSum_x)',
    'coalesce(next(a, order: k desc), 0)',
  ];

  for (const text of texts) {
    it(text, () => {
      const parsed = ok(text);
      const printed = printFormula(parsed);
      expect(ok(printed)).toEqual(parsed);
      // text written the canonical way prints back as it was written
      expect(printed).toBe(text);
    });
  }

  it('an order key written "asc" prints without it and means the same', () => {
    const parsed = ok('previous(a, order: (k asc, j desc))');
    expect(printFormula(parsed)).toBe('previous(a, order: (k, j desc))');
    expect(ok(printFormula(parsed))).toEqual(parsed);
  });

  it('through the rules wire: print every computed column, read it back, and get the canonical rules', () => {
    const r: LearnResult = rules({
      columns: [col('acct', 'text'), col('amt', 'decimal'), col('d', 'date')],
      transform: {
        computed: [
          { id: 'bal', type: 'decimal', expr: ok('runningSum(amt, by: acct, order: (d, amt desc))') },
          { id: 'rk', type: 'integer', expr: ok('rank(order: bal desc, ties: dense)') },
          { id: 'share', type: 'decimal', expr: ok('round(amt / groupSum(amt, by: acct) * 100, 1)') },
        ],
      },
      out: ['bal', 'rk', 'share'],
    });
    const wire = formulaRulesToWire(r);
    expect(wire.transform.computed.map((c) => c.expr)).toEqual([
      'runningSum(amt, by: acct, order: (d, amt desc))',
      'rank(order: bal desc, ties: dense)',
      'round(amt / groupSum(amt, by: acct) * 100, 1)',
    ]);
    const back = formulaRulesFromWire(JSON.parse(JSON.stringify(wire)));
    expect(back.problems).toEqual([]);
    expect(back.rules).toEqual(canonicalizeRules(r));
  });
});

describe('WINDOW_SIGNATURES', () => {
  it('has exactly the eleven functions of the schema', () => {
    expect(Object.keys(WINDOW_SIGNATURES).sort()).toEqual([...WINDOW_FNS].sort());
  });
});

describe('property: print then parse gives back every valid window node', () => {
  // A seeded generator of valid window nodes (every function, every combination of by / order / ties its signature allows).
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it('2,000 random nodes round trip exactly (column names include the keywords by, order, desc, asc, ties)', () => {
    const rnd = lcg(7);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const names = ['a', 'amount', 'by', 'order', 'desc', 'asc', 'ties', 'rank', 'next', 'x1', '_k', 'Group_2'];
    const some = (max: number): string[] => Array.from({ length: 1 + Math.floor(rnd() * max) }, () => pick(names));
    for (let i = 0; i < 2000; i++) {
      const fn = pick(WINDOW_FNS);
      const sig = WINDOW_SIGNATURES[fn];
      const node: Record<string, unknown> = { op: 'window', fn };
      if (sig.arg === 'required' || (sig.arg === 'optional' && rnd() < 0.5)) node.arg = { col: pick(names) };
      if (rnd() < 0.6) node.by = some(3);
      if (sig.order === 'required' || (sig.order === 'optional' && rnd() < 0.6)) {
        node.order = some(3).map((column) => ({ column, dir: rnd() < 0.5 ? 'asc' : 'desc' }));
      }
      if (sig.ties && rnd() < 0.5) node.ties = pick(['min', 'dense']);
      const text = printFormula(node as unknown as Expr);
      const back = parseFormula(text, { allowWindows: true });
      expect(back.ok, text).toBe(true);
      if (back.ok) expect(back.expr, text).toEqual(node);
      // and nested in an expression
      const wrapped = `round(${text} * 2, 1)`;
      const again = parseFormula(wrapped, { allowWindows: true });
      expect(again.ok, wrapped).toBe(true);
    }
  });
});
