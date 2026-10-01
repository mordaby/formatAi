import { describe, expect, it } from 'vitest';
import type { Expr } from '@formatai/shared';
import { limits } from '@formatai/shared';
import { parseFormula } from '../../src/formula/parseFormula';
import { printFormula } from '../../src/formula/printFormula';
import { OP_SIGNATURES, type SigOp } from '../../src/check/signatures';

function ok(text: string, ctx?: { params?: string[] }): Expr {
  const r = parseFormula(text, { allowWindows: true, ...ctx });
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error.message} at ${r.error.offset}`);
  return r.expr;
}

function err(text: string, ctx?: { params?: string[] }) {
  const r = parseFormula(text, ctx);
  if (r.ok) throw new Error(`expected an error, parsed to ${JSON.stringify(r.expr)}`);
  return r.error;
}

describe('parseFormula: literals', () => {
  it('parses integers and decimals', () => {
    expect(ok('5')).toEqual({ const: 5 });
    expect(ok('3.14')).toEqual({ const: 3.14 });
    expect(ok('0')).toEqual({ const: 0 });
  });

  it('folds unary minus on a number literal into a negative const', () => {
    expect(ok('-5')).toEqual({ const: -5 });
    expect(ok('-3.14')).toEqual({ const: -3.14 });
  });

  it('produces neg for unary minus on a non-literal', () => {
    expect(ok('-amount')).toEqual({ op: 'neg', arg: { col: 'amount' } });
    expect(ok('-(a + b)')).toEqual({ op: 'neg', arg: { op: 'add', args: [{ col: 'a' }, { col: 'b' }] } });
    expect(ok('-f(x)')).toEqual({ op: 'neg', arg: { op: 'call', fn: 'f', args: [{ col: 'x' }] } });
  });

  it('parses string literals with escapes, quotes and Hebrew', () => {
    expect(ok('"hello"')).toEqual({ const: 'hello' });
    expect(ok('"he said \\"hi\\""')).toEqual({ const: 'he said "hi"' });
    expect(ok('"back\\\\slash"')).toEqual({ const: 'back\\slash' });
    expect(ok('"זקמ עגש"')).toEqual({ const: 'זקמ עגש' });
    expect(ok('""')).toEqual({ const: '' });
  });

  it('parses true/false/null', () => {
    expect(ok('true')).toEqual({ const: true });
    expect(ok('false')).toEqual({ const: false });
    expect(ok('null')).toEqual({ const: null });
  });

  it('parses bare identifiers as columns at top level', () => {
    expect(ok('amount')).toEqual({ col: 'amount' });
  });

  it('resolves identifiers to params inside a function body context', () => {
    expect(ok('rate', { params: ['rate'] })).toEqual({ param: 'rate' });
  });

  it('errors on an unknown identifier inside a function body', () => {
    const e = err('amount', { params: ['rate'] });
    expect(e.message).toMatch(/unknown identifier "amount"/);
    expect(e.offset).toBe(0);
  });
});

describe('parseFormula: infix arithmetic and precedence', () => {
  it('respects * / over + -', () => {
    expect(ok('a + b * c')).toEqual({ op: 'add', args: [{ col: 'a' }, { op: 'mul', args: [{ col: 'b' }, { col: 'c' }] }] });
  });

  it('is left-associative and flattens same-op chains', () => {
    expect(ok('a + b + c')).toEqual({ op: 'add', args: [{ col: 'a' }, { col: 'b' }, { col: 'c' }] });
    expect(ok('a - b - c')).toEqual({ op: 'sub', args: [{ col: 'a' }, { col: 'b' }, { col: 'c' }] });
  });

  it('wraps into a new node when the operator changes', () => {
    expect(ok('a + b - c')).toEqual({
      op: 'sub',
      args: [{ op: 'add', args: [{ col: 'a' }, { col: 'b' }] }, { col: 'c' }],
    });
  });

  it('honors explicit parens', () => {
    expect(ok('(a + b) * c')).toEqual({ op: 'mul', args: [{ op: 'add', args: [{ col: 'a' }, { col: 'b' }] }, { col: 'c' }] });
    expect(ok('a * (b + c)')).toEqual({ op: 'mul', args: [{ col: 'a' }, { op: 'add', args: [{ col: 'b' }, { col: 'c' }] }] });
  });

  it('parses comparisons at the lowest precedence, non-chainable', () => {
    expect(ok('a + 1 = b * 2')).toEqual({
      op: 'eq',
      args: [{ op: 'add', args: [{ col: 'a' }, { const: 1 }] }, { op: 'mul', args: [{ col: 'b' }, { const: 2 }] }],
    });
  });

  it('maps every comparison symbol', () => {
    expect(ok('a <> b')).toMatchObject({ op: 'ne' });
    expect(ok('a < b')).toMatchObject({ op: 'lt' });
    expect(ok('a > b')).toMatchObject({ op: 'gt' });
    expect(ok('a <= b')).toMatchObject({ op: 'lte' });
    expect(ok('a >= b')).toMatchObject({ op: 'gte' });
    expect(ok('a = b')).toMatchObject({ op: 'eq' });
  });
});

describe('parseFormula: function calls', () => {
  it('parses round(x, digits)', () => {
    expect(ok('round(amount * 0.17, 2)')).toEqual({
      op: 'round',
      arg: { op: 'mul', args: [{ col: 'amount' }, { const: 0.17 }] },
      digits: 2,
    });
  });

  it('parses if(cond, then, else)', () => {
    expect(ok('if(status = "VIP", price * 0.9, price)')).toEqual({
      op: 'if',
      cond: { op: 'eq', args: [{ col: 'status' }, { const: 'VIP' }] },
      then: { op: 'mul', args: [{ col: 'price' }, { const: 0.9 }] },
      else: { col: 'price' },
    });
  });

  it('parses lookup with and without onMissing', () => {
    expect(ok('lookup("rates", code, "rate")')).toEqual({
      op: 'lookup',
      table: 'rates',
      key: { col: 'code' },
      return: 'rate',
      onMissing: 'flag',
    });
    expect(ok('lookup("rates", code, "rate", "keep")')).toMatchObject({ onMissing: 'keep' });
  });

  it('parses switch with multiple cases and an else', () => {
    expect(ok('switch(a = 1, "one", a = 2, "two", "other")')).toEqual({
      op: 'switch',
      cases: [
        { when: { op: 'eq', args: [{ col: 'a' }, { const: 1 }] }, then: { const: 'one' } },
        { when: { op: 'eq', args: [{ col: 'a' }, { const: 2 }] }, then: { const: 'two' } },
      ],
      else: { const: 'other' },
    });
  });

  it('parses dateAdd choosing the right discriminant key', () => {
    expect(ok('dateAdd(d, 30, "days")')).toEqual({ op: 'dateAdd', arg: { col: 'd' }, days: 30 });
    expect(ok('dateAdd(d, -1, "months")')).toEqual({ op: 'dateAdd', arg: { col: 'd' }, months: -1 });
    expect(ok('dateAdd(d, 2, "years")')).toEqual({ op: 'dateAdd', arg: { col: 'd' }, years: 2 });
  });

  it('parses oneOf with a variadic literal tail', () => {
    expect(ok('oneOf(x, "a", "b", 3)')).toEqual({ op: 'oneOf', arg: { col: 'x' }, values: ['a', 'b', 3] });
  });

  it('parses variadic ops (and/or/concat/coalesce/min/max)', () => {
    expect(ok('and(a, b, c)')).toEqual({ op: 'and', args: [{ col: 'a' }, { col: 'b' }, { col: 'c' }] });
    expect(ok('concat(a, "-", b)')).toEqual({ op: 'concat', args: [{ col: 'a' }, { const: '-' }, { col: 'b' }] });
  });

  it('calls an unrecognized name as a user function (transform.functions)', () => {
    expect(ok('netOf(amount, rate)')).toEqual({ op: 'call', fn: 'netOf', args: [{ col: 'amount' }, { col: 'rate' }] });
  });

  it('parses nested calls inside a function body using params', () => {
    expect(ok('round(base * rate, 2)', { params: ['base', 'rate'] })).toEqual({
      op: 'round',
      arg: { op: 'mul', args: [{ param: 'base' }, { param: 'rate' }] },
      digits: 2,
    });
  });
});

describe('parseFormula: literal-only params reject expressions', () => {
  it('rejects an expression (not a literal at all) for a literal-only param', () => {
    expect(err('round(x, y)').message).toMatch(/round\(\).*"digits".*fixed value, not an expression/);
    expect(err('replaceText(x, y, "b")').message).toMatch(/"find".*fixed value, not an expression/);
    expect(err('datePart(x, y)').message).toMatch(/"part".*fixed value, not an expression/);
  });

  it('rejects a wrongly-typed literal for a literal-only param', () => {
    expect(err('round(x, "2")').message).toMatch(/"digits".*fixed whole number/);
    expect(err('replaceText(x, 1, "b")').message).toMatch(/"find".*fixed piece of text/);
    expect(err('padLeft(x, 5, "ab")').message).toMatch(/"char".*single character/);
    expect(err('split(x, 1, 1)').message).toMatch(/"separator".*fixed piece of text/);
  });

  it('rejects a non-literal for an enum param', () => {
    const e = err('datePart(x, y)');
    expect(e.message).toMatch(/"part".*fixed value, not an expression/);
  });

  it('rejects an out-of-set literal for an enum param, and a wrongly-typed one', () => {
    expect(err('datePart(x, "century")').message).toMatch(/"part".*must be one of/);
    expect(err('datePart(x, 5)').message).toMatch(/"part".*must be one of/);
  });
});

describe('parseFormula: arity and syntax errors carry offsets', () => {
  it('reports a missing-close-paren error with an offset', () => {
    const e = err('round(amount, 2');
    expect(e.message).toMatch(/expected "\)" at \d+/);
    expect(e.offset).toBe('round(amount, 2'.length);
  });

  it('reports an arity error for a known op', () => {
    const e = err('round(amount)');
    expect(e.message).toBe('round() needs 2 argument(s)');
  });

  it('reports too many arguments', () => {
    const e = err('round(amount, 2, 3)');
    expect(e.message).toMatch(/round\(\) takes at most 2 argument\(s\)/);
  });

  it('reports an unexpected token', () => {
    const e = err('amount + ');
    expect(e.message).toMatch(/unexpected token/);
  });

  it('reports split() with a zero index as an error', () => {
    const e = err('split(x, "-", 0)');
    expect(e.message).toMatch(/non-zero/);
  });

  it('reports switch() with an even argument count', () => {
    const e = err('switch(a = 1, "x")');
    expect(e.message).toMatch(/switch\(\)/);
  });
});

describe('parseFormula: security hardening (untrusted LLM output)', () => {
  it('rejects formula text over the configured length cap without parsing it', () => {
    const huge = '('.repeat(100_000);
    const e = err(huge);
    expect(e.message).toMatch(/maximum length/);
    expect(huge.length).toBeGreaterThan(limits.rules.maxFormulaChars);
  });

  it('rejects a 1 MB garbage string cheaply via the length cap', () => {
    const huge = 'x'.repeat(1_000_000);
    const e = err(huge);
    expect(e.message).toMatch(/maximum length/);
  });

  it('guards recursion depth on deeply nested parens well under the length cap', () => {
    const nested = '('.repeat(200) + '1' + ')'.repeat(200);
    expect(nested.length).toBeLessThan(limits.rules.maxFormulaChars);
    const e = err(nested);
    expect(e.message).toMatch(/nested too deeply/);
  });

  it('guards recursion depth on deeply nested calls', () => {
    const nested = 'abs('.repeat(200) + '1' + ')'.repeat(200);
    const e = err(nested);
    expect(e.message).toMatch(/nested too deeply/);
  });

  it('treats __proto__/constructor/toString as ordinary identifiers, never as object keys', () => {
    expect(ok('__proto__')).toEqual({ col: '__proto__' });
    expect(ok('constructor(x)')).toEqual({ op: 'call', fn: 'constructor', args: [{ col: 'x' }] });
    expect(ok('lookup("__proto__", key, "constructor")')).toEqual({
      op: 'lookup',
      table: '__proto__',
      key: { col: 'key' },
      return: 'constructor',
      onMissing: 'flag',
    });
    expect(ok('toString', { params: ['toString'] })).toEqual({ param: 'toString' });
  });

  it('never evaluates or interprets a string literal as code', () => {
    // A string containing formula-looking text is just a const leaf, nothing more.
    expect(ok('"round(amount, 2)"')).toEqual({ const: 'round(amount, 2)' });
  });
});

describe('parseFormula <-> printFormula: round trip for every op', () => {
  const CASES: Record<SigOp, string> = {
    add: 'a + b + c',
    sub: 'a - b - c',
    mul: 'a * b',
    div: 'a / b',
    neg: '-a',
    abs: 'abs(a)',
    floor: 'floor(a)',
    ceil: 'ceil(a)',
    mod: 'mod(a, b)',
    min: 'min(a, b, c)',
    max: 'max(a, b, c)',
    round: 'round(a, 2)',
    concat: 'concat(a, "-", b)',
    substr: 'substr(a, 1, 3)',
    trim: 'trim(a)',
    upper: 'upper(a)',
    lower: 'lower(a)',
    length: 'length(a)',
    replaceText: 'replaceText(a, "x", "y")',
    padLeft: 'padLeft(a, 5, "0")',
    split: 'split(a, "-", 1)',
    toNumber: 'toNumber(a)',
    toText: 'toText(a)',
    datePart: 'datePart(a, "year")',
    dateFormat: 'dateFormat(a, "DD/MM/YYYY")',
    dateAdd: 'dateAdd(a, 30, "days")',
    dateDiff: 'dateDiff(a, b, "months")',
    endOfMonth: 'endOfMonth(a)',
    weekday: 'weekday(a)',
    makeDate: 'makeDate(a, b, c)',
    toDate: 'toDate(a, "D MMMM YYYY")',
    dateLiteral: 'date("2026-01-31")',
    keepChars: 'keepChars(a, "digits")',
    titleCase: 'titleCase(a)',
    find: 'find(a, "-")',
    if: 'if(a = 1, "x", "y")',
    switch: 'switch(a = 1, "x", a = 2, "y", "z")',
    coalesce: 'coalesce(a, b, c)',
    lookup: 'lookup("t", a, "r")',
    call: 'netOf(a, b)',
    eq: 'a = b',
    ne: 'a <> b',
    gt: 'a > b',
    gte: 'a >= b',
    lt: 'a < b',
    lte: 'a <= b',
    isEmpty: 'isEmpty(a)',
    notEmpty: 'notEmpty(a)',
    oneOf: 'oneOf(a, "x", "y")',
    startsWith: 'startsWith(a, "x")',
    endsWith: 'endsWith(a, "x")',
    contains: 'contains(a, "x")',
    and: 'and(a, b)',
    or: 'or(a, b)',
    not: 'not(a)',
    window: 'runningSum(a, by: b, order: (c, d desc))',
  };

  for (const op of Object.keys(CASES) as SigOp[]) {
    it(`round-trips ${op}`, () => {
      const text = CASES[op];
      const parsed = ok(text);
      const printed = printFormula(parsed);
      const reparsed = ok(printed);
      expect(reparsed).toEqual(parsed);
    });
  }

  it('with promptOpsOnly, every op the prompt documents parses exactly as before and every held-back op becomes a call', () => {
    for (const op of Object.keys(CASES) as SigOp[]) {
      const sig = OP_SIGNATURES[op];
      if (sig.formula.form !== 'call' || op === 'call') continue;
      const text = CASES[op];
      const normal = ok(text);
      const llm = parseFormula(text, { promptOpsOnly: true });
      expect(llm.ok, text).toBe(true);
      if (!llm.ok) continue;
      if (sig.inPrompt === false) expect(llm.expr, text).toMatchObject({ op: 'call' });
      else expect(llm.expr, text).toEqual(normal);
    }
  });

  it('every op in OP_SIGNATURES has a round-trip case above', () => {
    const missing = (Object.keys(OP_SIGNATURES) as SigOp[]).filter((op) => !(op in CASES));
    expect(missing).toEqual([]);
  });

  it('round-trips a toText with an explicit format', () => {
    const parsed = ok('toText(a, "#,##0.00")');
    expect(ok(printFormula(parsed))).toEqual(parsed);
  });

  it('round-trips a lookup with a non-default onMissing', () => {
    const parsed = ok('lookup("t", a, "r", "keep")');
    const printed = printFormula(parsed);
    expect(printed).toContain('"keep"');
    expect(ok(printed)).toEqual(parsed);
  });

  it('round-trips negative number constants exactly', () => {
    const parsed = ok('-5');
    expect(printFormula(parsed)).toBe('-5');
  });

  it('round-trips a function body using params', () => {
    const ctx = { params: ['base', 'rate'] };
    const parsed = ok('round(base * rate, 2)', ctx);
    const printed = printFormula(parsed);
    expect(printed).toBe('round(base * rate, 2)');
    expect(ok(printed, ctx)).toEqual(parsed);
  });

  it('round-trips mixed +/- nesting with correct parens', () => {
    const parsed = ok('a - (b + c)');
    const printed = printFormula(parsed);
    expect(ok(printed)).toEqual(parsed);
  });

  it('round-trips a parenthesized product inside a sum', () => {
    const parsed = ok('a * (b + c)');
    expect(ok(printFormula(parsed))).toEqual(parsed);
  });
});

describe('parseFormula: operations added after learn-v6 (inPrompt: false)', () => {
  const NEW_OPS: [SigOp, string][] = [
    ['weekday', 'weekday(d)'],
    ['makeDate', 'makeDate(y, m, d)'],
    ['toDate', 'toDate(t, "MMMM YYYY")'],
    ['dateLiteral', 'date("2026-01-31")'],
    ['keepChars', 'keepChars(t, "digits")'],
    ['titleCase', 'titleCase(t)'],
    ['find', 'find(t, "-")'],
  ];

  it('the editor / default reader parses all of them', () => {
    for (const [op, text] of NEW_OPS) {
      const e = ok(text);
      expect('op' in e && e.op, text).toBe(op);
    }
  });

  it('with promptOpsOnly (an LLM answer) they are unknown names: calls to functions that do not exist', () => {
    for (const [, text] of NEW_OPS) {
      const r = parseFormula(text, { promptOpsOnly: true });
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(r.expr, text).toMatchObject({ op: 'call' });
    }
    expect(parseFormula('date("2026-01-31")', { promptOpsOnly: true })).toEqual({
      ok: true,
      expr: { op: 'call', fn: 'date', args: [{ const: '2026-01-31' }] },
    });
  });

  it('with promptOpsOnly every op the prompt documents still parses as a built-in', () => {
    expect(parseFormula('round(a, 2)', { promptOpsOnly: true })).toEqual({ ok: true, expr: { op: 'round', arg: { col: 'a' }, digits: 2 } });
    expect(parseFormula('dateAdd(a, 1, "days")', { promptOpsOnly: true }).ok).toBe(true);
  });

  it('rejects malformed arguments with a message that says what is needed', () => {
    expect(err('date("2026-02-30")').message).toContain('YYYY-MM-DD');
    expect(err('toDate(t, "")').message).toContain('format');
    expect(err('find(t, "")').message).toContain('search');
    expect(err('keepChars(t, "symbols")').message).toContain('"digits"');
    expect(err('makeDate(a, b)').message).toContain('makeDate()');
    expect(err('weekday()').message).toContain('weekday()');
    expect(err('titleCase(a, b)').message).toContain('titleCase()');
  });
});

