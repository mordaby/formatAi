// Across-row (window) functions in the shared rules language: the `window` node's schema, and what `checkRules` says about it
// (columns that must exist where the computed column is, windows only in a computed column, reserved function names).
import { describe, expect, it } from 'vitest';
import { checkRules } from '../src/rules/check';
import { ExprSchema, LearnResultSchema, WINDOW_FNS, type Expr, type LearnResult } from '../src/rules/schema';

const w = (n: object): Expr => ({ op: 'window', ...n }) as Expr;

function baseRules(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'acct', header: 'Acct', type: 'text' },
        { id: 'amt', header: 'Amt', type: 'decimal' },
        { id: 'd', header: 'D', type: 'date' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: { sheetName: 'S', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Acct', from: 'acct' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

describe('ExprSchema: the window node', () => {
  const valid = (e: unknown) => expect(ExprSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  const invalid = (e: unknown) => expect(ExprSchema.safeParse(e).success, JSON.stringify(e)).toBe(false);

  it('parses every function, with and without its optional parts', () => {
    for (const fn of WINDOW_FNS) valid({ op: 'window', fn });
    valid({ op: 'window', fn: 'runningSum', arg: { col: 'amt' }, by: ['acct'], order: [{ column: 'd', dir: 'desc' }] });
    valid({ op: 'window', fn: 'rank', order: [{ column: 'amt', dir: 'asc' }, { column: 'd', dir: 'desc' }], ties: 'dense' });
    valid({ op: 'if', cond: { op: 'gt', args: [{ op: 'window', fn: 'rowNumber' }, { const: 1 }] }, then: { const: 'x' }, else: { const: null } });
  });

  it('is strict: no extra keys, a fixed set of functions, ties and dir values, non-empty by/order', () => {
    invalid({ op: 'window', fn: 'median', arg: { col: 'a' } });
    invalid({ op: 'window', fn: 'runningSum', arg: { col: 'a' }, extra: 1 });
    invalid({ op: 'window', fn: 'rank', ties: 'max' });
    invalid({ op: 'window', fn: 'runningSum', arg: { col: 'a' }, order: [{ column: 'd', dir: 'down' }] });
    invalid({ op: 'window', fn: 'runningSum', arg: { col: 'a' }, order: [{ col: 'd', dir: 'asc' }] });
    invalid({ op: 'window', fn: 'runningSum', arg: { col: 'a' }, order: [{ column: 'd', dir: 'asc', extra: true }] });
    invalid({ op: 'window', fn: 'runningSum', arg: { col: 'a' }, by: [] });
    invalid({ op: 'window', fn: 'runningSum', arg: { col: 'a' }, order: [] });
    invalid({ op: 'window', fn: 'runningSum', arg: { col: 'a' }, by: [''] });
    invalid({ op: 'window' });
  });

  it('v1: the column argument is a column id, not an expression', () => {
    invalid({ op: 'window', fn: 'runningSum', arg: { op: 'add', args: [{ col: 'a' }, { const: 1 }] } });
    invalid({ op: 'window', fn: 'runningSum', arg: { const: 1 } });
  });

  it('the schema version stays 1: a whole rules file with a window validates', () => {
    const r = baseRules();
    r.transform.computed = [{ id: 'bal', type: 'decimal', expr: w({ fn: 'runningSum', arg: { col: 'amt' }, by: ['acct'], order: [{ column: 'd', dir: 'asc' }] }) }];
    expect(LearnResultSchema.safeParse(r).success).toBe(true);
  });
});

describe('checkRules: windows', () => {
  const withComputed = (exprs: { id: string; expr: Expr }[]): LearnResult => {
    const r = baseRules();
    r.transform.computed = exprs.map((e) => ({ id: e.id, type: 'decimal', expr: e.expr }));
    return r;
  };

  it('a computed column may hold one, with columns of the input (and of earlier computed columns)', () => {
    expect(checkRules(withComputed([{ id: 'bal', expr: w({ fn: 'runningSum', arg: { col: 'amt' }, by: ['acct'], order: [{ column: 'd', dir: 'asc' }] }) }]))).toEqual([]);
    expect(
      checkRules(
        withComputed([
          { id: 'bal', expr: w({ fn: 'runningSum', arg: { col: 'amt' } }) },
          { id: 'rk', expr: w({ fn: 'rank', order: [{ column: 'bal', dir: 'desc' }] }) },
        ]),
      ),
    ).toEqual([]);
  });

  it('every column it names must exist where that column is: the argument, each by, each order key', () => {
    const p = checkRules(withComputed([{ id: 'bal', expr: w({ fn: 'runningSum', arg: { col: 'nope' }, by: ['acct', 'gone'], order: [{ column: 'd', dir: 'asc' }, { column: 'missing', dir: 'desc' }] }) }]));
    expect(p.map((x) => [x.path, x.message])).toEqual([
      ['transform.computed[0].expr.by[1]', 'unknown column id "gone"'],
      ['transform.computed[0].expr.order[1].column', 'unknown column id "missing"'],
      ['transform.computed[0].expr.arg', 'unknown column id "nope"'],
    ]);
  });

  it('a computed column cannot name itself or a later one (no cycle is possible)', () => {
    const p = checkRules(
      withComputed([
        { id: 'a', expr: w({ fn: 'rank', order: [{ column: 'b', dir: 'asc' }] }) },
        { id: 'b', expr: w({ fn: 'runningSum', arg: { col: 'amt' } }) },
      ]),
    );
    expect(p.map((x) => x.message)).toEqual(['unknown column id "b"']);
    expect(checkRules(withComputed([{ id: 'a', expr: w({ fn: 'rowNumber', by: ['a'] }) }])).map((x) => x.message)).toEqual(['unknown column id "a"']);
  });

  it('a column the expand step removed is not there to name', () => {
    const r = baseRules();
    r.transform.expand = { mode: 'columnsToRows', columns: ['amt'], labelId: 'label', valueId: 'val', valueType: 'decimal', skipEmpty: true };
    r.transform.computed = [{ id: 'run', type: 'decimal', expr: w({ fn: 'runningSum', arg: { col: 'val' }, by: ['label'], order: [{ column: 'amt', dir: 'asc' }] }) }];
    expect(checkRules(r).map((x) => x.message)).toEqual(['unknown column id "amt"']);
  });

  it('not in a row filter, a fan-out value or a function body: those run before the step or are pure', () => {
    const win = w({ fn: 'groupSum', arg: { col: 'amt' } });
    const filter = baseRules();
    filter.input.rowFilters = [{ expr: { op: 'gt', args: [win, { const: 0 }] } }];
    expect(checkRules(filter).map((x) => [x.path, x.message])).toEqual([
      ['input.rowFilters[0].expr[0]', "groupSum() is an across-row function and works only in a computed column's formula"],
    ]);
    const fan = baseRules();
    fan.transform.expand = { mode: 'fixedFanOut', rows: [{ set: { n: w({ fn: 'rowNumber' }) } }] };
    expect(checkRules(fan).map((x) => x.message)).toEqual(["rowNumber() is an across-row function and works only in a computed column's formula"]);
    const fn = baseRules();
    fn.transform.functions = [{ name: 'f', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: w({ fn: 'rowNumber' }) }];
    expect(checkRules(fn).map((x) => x.message)).toEqual(["rowNumber() is an across-row function and works only in a computed column's formula"]);
  });

  it('inside a bigger computed expression too (nested in if/add)', () => {
    const r = withComputed([{ id: 'x', expr: { op: 'add', args: [{ col: 'amt' }, w({ fn: 'groupSum', arg: { col: 'amt' }, by: ['zzz'] })] } }]);
    expect(checkRules(r).map((p) => p.message)).toEqual(['unknown column id "zzz"']);
  });

  it('a window\'s argument must be a column even in stored JSON that skipped the schema', () => {
    const r = withComputed([{ id: 'x', expr: w({ fn: 'runningSum', arg: { op: 'neg', arg: { col: 'amt' } } }) }]);
    expect(checkRules(r).map((p) => p.message)).toEqual(['runningSum() reads a column id; make a computed column first for anything calculated']);
  });

  it('depth: a window with its column is two levels', () => {
    const deep = w({ fn: 'runningSum', arg: { col: 'amt' } });
    let e: Expr = deep;
    for (let i = 0; i < 6; i++) e = { op: 'neg', arg: e };
    // 6 negs + window + column = 8 levels, the limit
    expect(checkRules(withComputed([{ id: 'x', expr: e }]))).toEqual([]);
    expect(checkRules(withComputed([{ id: 'x', expr: { op: 'neg', arg: e } }])).map((p) => p.kind)).toEqual(['depth']);
  });
});

describe('checkRules: function names the formula language already uses', () => {
  const rules = (name: string): LearnResult => {
    const r = baseRules();
    r.transform.functions = [{ name, params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { param: 'x' } }];
    return r;
  };

  it('new rules (opt in): a function named like an across-row function would be read as the built-in, so it is refused', () => {
    for (const fn of WINDOW_FNS) {
      expect(checkRules(rules(fn), { rejectBuiltinFunctionNames: true }).map((p) => p.message), fn).toEqual([
        `function name "${fn}" is a built-in function of the formula language; choose another name`,
      ]);
    }
    expect(checkRules(rules('myRank'), { rejectBuiltinFunctionNames: true })).toEqual([]);
  });

  it('stored rules: never refused for it (calls already saved keep running)', () => {
    expect(checkRules(rules('rank'))).toEqual([]);
    expect(checkRules(rules('next'))).toEqual([]);
  });
});
