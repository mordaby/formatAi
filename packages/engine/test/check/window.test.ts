// Across-row (window) functions: the static type check, stored-JSON shape and the limits (docs/proposals/window-operations.md).
// References and placement (checkRules) are tested in packages/shared/test/check.window.test.ts, the formula text in test/formula/window.test.ts.
import { limits, type Expr, type LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { checkLimits } from '../../src/check/limits';
import { typeCheck } from '../../src/check/typeCheck';
import { parseFormula } from '../../src/formula';

const f = (text: string): Expr => {
  const r = parseFormula(text, { allowWindows: true });
  if (!r.ok) throw new Error(`${text}: ${r.error.message}`);
  return r.expr;
};

function mk(computed: { id: string; type: string; expr: Expr }[], outFrom?: string): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'acct', header: 'Acct', type: 'text' },
        { id: 'code', header: 'Code', type: 'idLike' },
        { id: 'amt', header: 'Amt', type: 'decimal' },
        { id: 'qty', header: 'Qty', type: 'integer' },
        { id: 'when', header: 'When', type: 'date' },
        { id: 'flag', header: 'Flag', type: 'boolean' },
        { id: 'k', header: 'K', type: 'integer' },
      ],
    },
    transform: { computed: computed as never, valueMaps: [], sort: [] },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Out', from: outFrom ?? computed[computed.length - 1]?.id ?? 'amt' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

const types = (text: string, declared: string): { path: string; message: string }[] => typeCheck(mk([{ id: 'out', type: declared, expr: f(text) }]));

describe('typeCheck: what each window function takes and gives', () => {
  it('runningSum / groupSum need a number; integer stays integer, anything else is decimal', () => {
    expect(types('runningSum(amt)', 'decimal')).toEqual([]);
    expect(types('groupSum(qty, by: acct)', 'integer')).toEqual([]);
    expect(types('groupSum(amt, by: acct)', 'integer')).toEqual([
      { kind: 'type', path: 'transform.computed[0].expr', message: 'expected integer, got decimal' },
    ]);
    // a declared decimal column may hold the integer result
    expect(types('runningSum(qty)', 'decimal')).toEqual([]);
  });

  it('a text column where a number is needed: the sentence points to a computed column and toNumber', () => {
    for (const fn of ['runningSum', 'groupSum', 'groupAvg']) {
      const p = types(`${fn}(acct)`, 'decimal');
      expect(p, fn).toEqual([{ kind: 'type', path: 'transform.computed[0].expr.arg', message: 'expected decimal, got text; use toNumber in a computed column first' }]);
    }
    expect(types('groupSum(code)', 'decimal')[0]!.message).toBe('expected decimal, got idLike; use toNumber in a computed column first');
    expect(types('runningSum(when)', 'decimal')[0]!.message).toBe('expected decimal, got date');
    expect(types('groupAvg(flag)', 'decimal')[0]!.message).toBe('expected decimal, got boolean');
  });

  it('groupAvg gives a decimal', () => {
    expect(types('groupAvg(qty)', 'decimal')).toEqual([]);
    expect(types('groupAvg(qty)', 'integer')[0]!.message).toBe('expected integer, got decimal');
  });

  it('groupMin / groupMax take a number or a date and give that type', () => {
    expect(types('groupMin(amt, by: acct)', 'decimal')).toEqual([]);
    expect(types('groupMax(when, by: acct)', 'date')).toEqual([]);
    expect(types('groupMax(when)', 'decimal')[0]!.message).toBe('expected decimal, got date');
    expect(types('groupMin(acct)', 'text')[0]!.message).toMatch(/^expected decimal or date, got text/);
    expect(types('groupMax(flag)', 'boolean')[0]!.message).toBe('expected decimal or date, got boolean');
  });

  it('previous / next / fillDown take any column and give its type', () => {
    expect(types('previous(acct)', 'text')).toEqual([]);
    expect(types('next(when, order: when)', 'date')).toEqual([]);
    expect(types('fillDown(flag, by: acct)', 'boolean')).toEqual([]);
    expect(types('fillDown(code)', 'text')).toEqual([]); // idLike widens to text
    expect(types('previous(acct)', 'decimal')[0]!.message).toBe('expected decimal, got text; use toNumber');
  });

  it('groupCount / rowNumber / rank give an integer, whatever the columns', () => {
    expect(types('groupCount(by: acct)', 'integer')).toEqual([]);
    expect(types('groupCount(when, by: (acct, flag))', 'integer')).toEqual([]);
    expect(types('rowNumber(by: when, order: acct desc)', 'integer')).toEqual([]);
    expect(types('rank(order: when, by: flag, ties: dense)', 'integer')).toEqual([]);
    expect(types('rank(order: acct)', 'text')[0]!.message).toBe('expected text, got integer; use toText');
  });

  it('by: and order: columns may be of any type', () => {
    for (const col of ['acct', 'code', 'amt', 'qty', 'when', 'flag']) {
      expect(types(`runningSum(amt, by: ${col}, order: ${col} desc)`, 'decimal'), col).toEqual([]);
    }
  });

  it('a window inside a bigger expression is typed as a value', () => {
    expect(types('round(amt / groupSum(amt) * 100, 1)', 'decimal')).toEqual([]);
    expect(types('if(rowNumber(by: acct) > 1, "Duplicate", null)', 'text')).toEqual([]);
    expect(types('rowNumber() + acct', 'decimal')[0]!.message).toBe('expected decimal, got text; use toNumber');
    expect(types('if(rank(order: k), "a", "b")', 'text')[0]!.message).toBe('expected boolean, got integer');
  });

  it('a window may read an earlier computed column, with that column\'s declared type', () => {
    const rules = mk([
      { id: 'a', type: 'text', expr: { col: 'acct' } },
      { id: 'out', type: 'decimal', expr: f('runningSum(a)') },
    ]);
    expect(typeCheck(rules).map((p) => p.message)).toEqual(['expected decimal, got text; use toNumber in a computed column first']);
  });
});

describe('typeCheck: stored JSON gets the shape check the formula parser gives text', () => {
  const node = (n: object): LearnResult => mk([{ id: 'out', type: 'decimal', expr: n as Expr }]);

  it('a missing or surplus column, order on a group function, ties off rank, rank without order', () => {
    const msg = (n: object) => typeCheck(node(n)).map((p) => p.message);
    expect(msg({ op: 'window', fn: 'runningSum' })).toEqual(['runningSum() needs a column, e.g. runningSum(amount)']);
    expect(msg({ op: 'window', fn: 'rowNumber', arg: { col: 'amt' } })[0]).toMatch(/^rowNumber\(\) takes no column/);
    expect(msg({ op: 'window', fn: 'groupSum', arg: { col: 'amt' }, order: [{ column: 'k', dir: 'asc' }] })[0]).toMatch(/does not take order:/);
    expect(msg({ op: 'window', fn: 'runningSum', arg: { col: 'amt' }, ties: 'min' })[0]).toMatch(/does not take ties:/);
    expect(msg({ op: 'window', fn: 'rank' })[0]).toMatch(/needs order:/);
    expect(msg({ op: 'window', fn: 'rank', order: [{ column: 'k', dir: 'desc' }], ties: 'dense' }).filter((m) => !m.startsWith('expected'))).toEqual([]);
  });

  it('an expression in place of the column (schema allows the type, v1 does not)', () => {
    const p = typeCheck(node({ op: 'window', fn: 'runningSum', arg: { op: 'add', args: [{ col: 'amt' }, { const: 1 }] } }));
    expect(p).toEqual([{ kind: 'type', path: 'transform.computed[0].expr.arg', message: 'runningSum() reads a column id; make a computed column first for anything calculated' }]);
  });

  it('an unknown column is left to checkRules (no cascade here)', () => {
    expect(typeCheck(node({ op: 'window', fn: 'runningSum', arg: { col: 'nope' }, by: ['nope2'] }))).toEqual([]);
  });
});

describe('checkLimits: windows', () => {
  const windows = (n: number): { id: string; type: string; expr: Expr }[] => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, type: 'decimal', expr: f('runningSum(amt)') }));

  it('maxWindowOps window functions per file; the message says how many', () => {
    const ok = checkLimits(mk(windows(limits.rules.maxWindowOps)), 'paid').filter((p) => p.message.includes('across-row'));
    expect(ok).toEqual([]);
    const over = checkLimits(mk(windows(limits.rules.maxWindowOps + 1)), 'paid').filter((p) => p.message.includes('across-row'));
    expect(over).toEqual([{ kind: 'limit', path: 'transform.computed', message: `9 across-row functions (runningSum, rank, ...) exceed the maximum of ${limits.rules.maxWindowOps} per file` }]);
  });

  it('maxWindowKeys columns in one by: and in one order:', () => {
    const cols = Array.from({ length: limits.rules.maxWindowKeys + 1 }, (_, i) => ['acct', 'code', 'amt', 'qty'][i]!);
    const by = cols.join(', ');
    const p = checkLimits(mk([{ id: 'out', type: 'decimal', expr: f(`runningSum(amt, by: (${by}))`) }]), 'paid');
    expect(p.map((x) => x.message)).toEqual(['runningSum() names 4 columns in by:, more than the maximum of 3']);
    const q = checkLimits(mk([{ id: 'out', type: 'integer', expr: f(`rowNumber(order: (${by}))`) }]), 'paid');
    expect(q.map((x) => x.message)).toEqual(['rowNumber() names 4 columns in order:, more than the maximum of 3']);
    const fine = checkLimits(mk([{ id: 'out', type: 'decimal', expr: f(`runningSum(amt, by: (${cols.slice(0, 3).join(', ')}), order: (${cols.slice(0, 3).join(', ')}))`) }]), 'paid');
    expect(fine).toEqual([]);
  });

  it('each window node counts as one rule, on top of its output column', () => {
    // 29 output columns + 1 window = 30 rules, the registered tier's limit; a second window makes 31.
    const columns = Array.from({ length: 29 }, (_, i) => ({ header: `C${i}`, from: 'amt' }));
    const make = (n: number): LearnResult => {
      const r = mk(windows(n));
      r.output.columns = columns;
      return r;
    };
    expect(checkLimits(make(0), 'registered')).toEqual([]);
    expect(checkLimits(make(1), 'registered')).toEqual([]);
    expect(checkLimits(make(2), 'registered').map((p) => p.message)).toEqual([`31 rules exceeds the "registered" tier's limit of 30 rules per format`]);
    // two windows in ONE expression count twice
    const one = mk([{ id: 'out', type: 'integer', expr: f('rowNumber() + rank(order: k)') }]);
    one.output.columns = columns;
    expect(checkLimits(one, 'registered').map((p) => p.message)).toEqual([`31 rules exceeds the "registered" tier's limit of 30 rules per format`]);
  });

  it('a window costs 2 nodes and 1 level of depth: a deep chain of windows reads fine, a 200-node column is still caught', () => {
    // depth: window (1) + its column (1) = 2
    expect(checkLimits(mk([{ id: 'out', type: 'decimal', expr: f('round(runningSum(amt), 2)') }]), 'paid')).toEqual([]);
    // 200 nodes per output column: an add (1) over 99 windows of 2 nodes each is 199, over 100 it is 201
    const sum = (n: number): Expr => ({ op: 'add', args: Array.from({ length: n }, () => f('groupSum(amt)')) });
    const nodeMsgs = (n: number): string[] => checkLimits(mk([{ id: 'out', type: 'decimal', expr: sum(n) }]), 'paid').map((p) => p.message).filter((m) => m.includes('expression nodes'));
    expect(nodeMsgs(99)).toEqual([]);
    expect(nodeMsgs(100)).toEqual(['output column "Out" uses 201 expression nodes (limit 200)']);
  });

  it('the node count follows by: and order: into computed columns that feed the window, not just the arguments', () => {
    const helper = { id: 'h', type: 'text', expr: { op: 'concat', args: Array.from({ length: 60 }, () => ({ col: 'acct' })) } as Expr };
    const withBy = mk([helper, { id: 'out', type: 'decimal', expr: f('runningSum(amt, by: h)') }]);
    const withoutBy = mk([helper, { id: 'out', type: 'decimal', expr: f('runningSum(amt)') }]);
    const count = (r: LearnResult): number => {
      // 200 is the limit; raise the helper until the by: version trips it and the plain one does not
      return checkLimits(r, 'paid').filter((p) => p.message.includes('expression nodes')).length;
    };
    expect(count(withoutBy)).toBe(0);
    expect(count(withBy)).toBe(0); // 61 + 3 + 2: well within
    const fat = { ...helper, expr: { op: 'concat', args: Array.from({ length: 199 }, () => ({ col: 'acct' })) } as Expr };
    expect(count(mk([fat, { id: 'out', type: 'decimal', expr: f('runningSum(amt, by: h)') }]))).toBe(1);
    expect(count(mk([fat, { id: 'out', type: 'decimal', expr: f('runningSum(amt, order: h)') }]))).toBe(1);
    expect(count(mk([fat, { id: 'out', type: 'decimal', expr: f('runningSum(amt)') }]))).toBe(0);
  });

  it('order items are not mistaken for expression children (depth stays 2)', () => {
    const e = f('rank(order: (k desc, amt, qty), by: (acct, code))');
    expect(checkLimits(mk([{ id: 'out', type: 'integer', expr: e }]), 'paid')).toEqual([]);
  });
});
