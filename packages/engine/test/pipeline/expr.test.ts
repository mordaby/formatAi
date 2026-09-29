import Decimal from 'decimal.js';
import type { Expr, RulesFunction, RulesTable } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import {
  MAX_EXPR_DEPTH,
  compileExpr,
  compileFunctions,
  compileTables,
  newEvalCx,
  substrCodePoints,
  type CompileEnv,
  type EvalCx,
} from '../../src/pipeline/v1/expr';
import { DateVal, type Val } from '../../src/pipeline/v1/values';
import { col, dataRows, rules, runOk, table, values } from './helpers';

const SLOTS = new Map([
  ['a', 0],
  ['b', 1],
  ['t', 2],
  ['d', 3],
  ['e', 4], // always empty
  ['d2', 5], // a second date, for dateDiff
]);

function row(
  a: Val = new Decimal(10),
  b: Val = new Decimal(4),
  t: Val = '  Hello  World ',
  d: Val = new DateVal({ y: 2024, m: 3, d: 5 }),
  d2: Val = null,
): Val[] {
  return [a, b, t, d, null, d2];
}

function ev(e: Expr, r: Val[] = row(), lang: 'he' | 'en' = 'he', extra: Partial<CompileEnv> = {}): { v: Val; cx: EvalCx } {
  const fn = compileExpr(e, { slotOf: SLOTS, language: lang, ...extra });
  const cx = newEvalCx();
  return { v: fn(r, cx), cx };
}

function num(e: Expr, r?: Val[]): string | null {
  const { v } = ev(e, r);
  if (v === null) return null;
  expect(v).toBeInstanceOf(Decimal);
  return (v as Decimal).toFixed();
}

const A = { col: 'a' };
const B = { col: 'b' };
const T = { col: 't' };
const D = { col: 'd' };
const D2 = { col: 'd2' };
const E = { col: 'e' };
const k = (c: string | number | boolean | null) => ({ const: c });
const dv = (y: number, m: number, d: number): DateVal => new DateVal({ y, m, d });

describe('arithmetic', () => {
  it('add / sub / mul / div, exact decimal', () => {
    expect(num({ op: 'add', args: [A, B, k(0.1)] })).toBe('14.1');
    expect(num({ op: 'sub', args: [A, B] })).toBe('6');
    expect(num({ op: 'mul', args: [A, k(0.17)] })).toBe('1.7');
    expect(num({ op: 'div', args: [A, B] })).toBe('2.5');
    expect(num({ op: 'add', args: [k(0.1), k(0.2)] })).toBe('0.3');
    expect(num({ op: 'div', args: [k(1), k(3)] })).toBe('0.33333333333333333333');
  });

  it('division by zero gives empty and reports divByZero', () => {
    const { v, cx } = ev({ op: 'div', args: [A, k(0)] });
    expect(v).toBeNull();
    expect(cx.problem).toBe('flag.expr.divByZero');
    const r2 = ev({ op: 'div', args: [A, E] });
    expect(r2.v).toBeNull();
    expect(r2.cx.problem).toBe('flag.expr.divByZero');
  });

  it('empty operands count as 0, all-empty gives empty', () => {
    expect(num({ op: 'add', args: [A, E] })).toBe('10');
    expect(num({ op: 'sub', args: [E, A] })).toBe('-10');
    expect(num({ op: 'mul', args: [A, E] })).toBe('0');
    expect(num({ op: 'div', args: [E, A] })).toBe('0');
    expect(ev({ op: 'add', args: [E, E] }).v).toBeNull();
    expect(ev({ op: 'neg', arg: E }).v).toBeNull();
    expect(ev({ op: 'round', arg: E, digits: 2 }).v).toBeNull();
  });

  it('numeric text is read as a number; other text reports notNumber', () => {
    expect(num({ op: 'add', args: [k('1,000'), k(1)] })).toBe('1001');
    const { v, cx } = ev({ op: 'add', args: [T, k(1)] });
    expect(v).toBeNull();
    expect(cx.problem).toBe('flag.expr.notNumber');
    expect(cx.problemValue).toBe('  Hello  World ');
  });

  it('dates are serials in arithmetic', () => {
    const serial = new DateVal({ y: 2024, m: 3, d: 5 }).serial;
    expect(num({ op: 'add', args: [D, k(1)] })).toBe(String(serial + 1));
  });

  it('neg, abs', () => {
    expect(num({ op: 'neg', arg: A })).toBe('-10');
    expect(num({ op: 'abs', arg: { op: 'neg', arg: A } })).toBe('10');
  });

  it('round is Excel ROUND (half away from zero)', () => {
    const r = (x: number | string, digits: number) => num({ op: 'round', arg: k(x), digits });
    expect(r(2.675, 2)).toBe('2.68');
    expect(r(-1.005, 2)).toBe('-1.01');
    expect(r(1234.5, 0)).toBe('1235');
    expect(r(-1234.5, 0)).toBe('-1235');
    expect(r(0.125, 2)).toBe('0.13');
    expect(r(1.005, 2)).toBe('1.01');
    expect(r(1234.5678, -2)).toBe('1200');
    expect(r(15, -1)).toBe('20');
    // amount × rate, then ROUND(…, 2): 342.05 × 1.18 = 403.619 → 403.62
    expect(num({ op: 'round', digits: 2, arg: { op: 'mul', args: [k(342.05), k(1.18)] } })).toBe('403.62');
  });
});

describe('text', () => {
  it('concat, with empty parts as ""', () => {
    expect(ev({ op: 'concat', args: [k('A'), k('-'), A, E] }).v).toBe('A-10');
    expect(ev({ op: 'concat', args: [E, E] }).v).toBeNull();
  });

  it('substr is 1-based; negative start counts from the end', () => {
    expect(ev({ op: 'substr', arg: k('ABCDEF'), start: 1, length: 3 }).v).toBe('ABC');
    expect(ev({ op: 'substr', arg: k('ABCDEF'), start: 3, length: 2 }).v).toBe('CD');
    expect(ev({ op: 'substr', arg: k('ABCDEF'), start: -2, length: 2 }).v).toBe('EF');
    expect(ev({ op: 'substr', arg: k('ABCDEF'), start: 5, length: 10 }).v).toBe('EF');
    expect(ev({ op: 'substr', arg: k('ABC'), start: 9, length: 1 }).v).toBeNull();
    expect(substrCodePoints('שלום עולם', 1, 4)).toBe('שלום');
    expect(substrCodePoints('a😀b', 2, 1)).toBe('😀');
  });

  it('trim collapses inner whitespace like Excel TRIM', () => {
    expect(ev({ op: 'trim', arg: T }).v).toBe('Hello World');
  });

  it('upper / lower (locale-independent)', () => {
    expect(ev({ op: 'upper', arg: k('abc אב') }).v).toBe('ABC אב');
    expect(ev({ op: 'lower', arg: k('ABC') }).v).toBe('abc');
  });

  it('replaceText is literal (no regex)', () => {
    expect(ev({ op: 'replaceText', arg: k('a.b.c'), find: '.', with: '-' }).v).toBe('a-b-c');
    expect(ev({ op: 'replaceText', arg: k('(1)+(2)'), find: '(', with: '' }).v).toBe('1)+2)');
  });

  it('padLeft pads, empty stays empty', () => {
    expect(ev({ op: 'padLeft', arg: k('123'), length: 6, char: '0' }).v).toBe('000123');
    expect(ev({ op: 'padLeft', arg: A, length: 4, char: '0' }).v).toBe('0010');
    expect(ev({ op: 'padLeft', arg: E, length: 4, char: '0' }).v).toBeNull();
  });
});

describe('dates', () => {
  it('datePart', () => {
    expect(num({ op: 'datePart', arg: D, part: 'year' })).toBe('2024');
    expect(num({ op: 'datePart', arg: D, part: 'month' })).toBe('3');
    expect(num({ op: 'datePart', arg: D, part: 'day' })).toBe('5');
  });

  it('dateFormat uses output.language for month names', () => {
    expect(ev({ op: 'dateFormat', arg: D, format: 'DD/MM/YYYY' }).v).toBe('05/03/2024');
    expect(ev({ op: 'dateFormat', arg: D, format: 'MMMM YYYY' }, row(), 'he').v).toBe('מרץ 2024');
    expect(ev({ op: 'dateFormat', arg: D, format: 'MMMM YYYY' }, row(), 'en').v).toBe('March 2024');
    expect(ev({ op: 'dateFormat', arg: D, format: 'D/M/YY' }).v).toBe('5/3/24');
  });

  it('non-dates report notDate', () => {
    const { v, cx } = ev({ op: 'datePart', arg: T, part: 'year' });
    expect(v).toBeNull();
    expect(cx.problem).toBe('flag.expr.notDate');
    expect(ev({ op: 'datePart', arg: k('2024-02-29'), part: 'day' }).v).toEqual(new Decimal(29));
  });
});

describe('logic and conditions', () => {
  it('if evaluates only the chosen branch', () => {
    const e: Expr = { op: 'if', cond: { op: 'gt', args: [A, k(5)] }, then: k('big'), else: { op: 'div', args: [A, k(0)] } };
    const { v, cx } = ev(e);
    expect(v).toBe('big');
    expect(cx.problem).toBeNull();
  });

  it('coalesce returns the first non-empty', () => {
    expect(ev({ op: 'coalesce', args: [E, k(''), B, A] }).v).toEqual(new Decimal(4));
    expect(ev({ op: 'coalesce', args: [E] }).v).toBeNull();
  });

  it('eq / ne are typed', () => {
    expect(ev({ op: 'eq', args: [A, k(10)] }).v).toBe(true);
    expect(ev({ op: 'eq', args: [A, k('10.0')] }).v).toBe(true);
    expect(ev({ op: 'eq', args: [k('00123'), k('123')] }).v).toBe(false);
    expect(ev({ op: 'eq', args: [k('מס\' פוליסה'), k('מס׳ פוליסה')] }).v).toBe(true);
    expect(ev({ op: 'eq', args: [D, k('2024-03-05')] }).v).toBe(true);
    expect(ev({ op: 'eq', args: [E, k(null)] }).v).toBe(true);
    expect(ev({ op: 'eq', args: [E, k(0)] }).v).toBe(false);
    expect(ev({ op: 'ne', args: [A, B] }).v).toBe(true);
  });

  it('gt / gte / lt / lte, false with an empty side', () => {
    expect(ev({ op: 'gt', args: [A, B] }).v).toBe(true);
    expect(ev({ op: 'gte', args: [A, k(10)] }).v).toBe(true);
    expect(ev({ op: 'lt', args: [A, B] }).v).toBe(false);
    expect(ev({ op: 'lte', args: [B, k(4)] }).v).toBe(true);
    expect(ev({ op: 'lt', args: [E, k(5)] }).v).toBe(false);
    expect(ev({ op: 'gt', args: [D, k('2024-01-31')] }).v).toBe(true);
    expect(ev({ op: 'lt', args: [k('apple'), k('banana')] }).v).toBe(true);
  });

  it('isEmpty / notEmpty / and / or / not', () => {
    expect(ev({ op: 'isEmpty', arg: E }).v).toBe(true);
    expect(ev({ op: 'notEmpty', arg: A }).v).toBe(true);
    expect(ev({ op: 'and', args: [{ op: 'gt', args: [A, k(1)] }, { op: 'notEmpty', arg: T }] }).v).toBe(true);
    expect(ev({ op: 'and', args: [{ op: 'gt', args: [A, k(1)] }, { op: 'isEmpty', arg: T }] }).v).toBe(false);
    expect(ev({ op: 'or', args: [{ op: 'isEmpty', arg: A }, { op: 'isEmpty', arg: E }] }).v).toBe(true);
    expect(ev({ op: 'not', arg: { op: 'isEmpty', arg: A } }).v).toBe(true);
  });

  it(`rejects depth > ${MAX_EXPR_DEPTH} (config: limits.rules.maxExprDepth) at compile time`, () => {
    let e: Expr = A;
    for (let i = 0; i < MAX_EXPR_DEPTH; i++) e = { op: 'neg', arg: e };
    expect(() => compileExpr(e, { slotOf: SLOTS, language: 'he' })).toThrow();
  });

  it('oneOf compares typed, like eq; startsWith/endsWith/contains are literal text', () => {
    expect(ev({ op: 'oneOf', arg: A, values: [1, 5, 10] }).v).toBe(true);
    expect(ev({ op: 'oneOf', arg: A, values: [1, 5] }).v).toBe(false);
    expect(ev({ op: 'oneOf', arg: E, values: [1, null] }).v).toBe(true);
    expect(ev({ op: 'startsWith', arg: k('  Hello'), text: '  He' }).v).toBe(true);
    expect(ev({ op: 'endsWith', arg: T, text: 'World ' }).v).toBe(true);
    expect(ev({ op: 'contains', arg: T, text: 'lo  Wo' }).v).toBe(true);
    expect(ev({ op: 'contains', arg: T, text: 'xyz' }).v).toBe(false);
    expect(ev({ op: 'startsWith', arg: E, text: 'x' }).v).toBe(false);
  });
});

describe('floor / ceil / mod / min / max', () => {
  it('floor / ceil round toward -/+ infinity; empty stays empty', () => {
    expect(num({ op: 'floor', arg: k(2.7) })).toBe('2');
    expect(num({ op: 'floor', arg: k(-2.1) })).toBe('-3');
    expect(num({ op: 'ceil', arg: k(2.1) })).toBe('3');
    expect(num({ op: 'ceil', arg: k(-2.7) })).toBe('-2');
    expect(ev({ op: 'floor', arg: E }).v).toBeNull();
  });

  it('mod follows Excel MOD: the result takes the divisor\'s sign', () => {
    expect(num({ op: 'mod', args: [k(-3), k(2)] })).toBe('1'); // MOD(-3,2) = 1
    expect(num({ op: 'mod', args: [k(3), k(-2)] })).toBe('-1'); // MOD(3,-2) = -1
    expect(num({ op: 'mod', args: [k(7), k(3)] })).toBe('1');
    expect(num({ op: 'mod', args: [k(-7), k(-3)] })).toBe('-1');
  });

  it('mod by zero (or an empty divisor) gives empty and reports divByZero; empty dividend acts as 0', () => {
    const byZero = ev({ op: 'mod', args: [k(5), k(0)] });
    expect(byZero.v).toBeNull();
    expect(byZero.cx.problem).toBe('flag.expr.divByZero');
    const byEmpty = ev({ op: 'mod', args: [k(5), E] });
    expect(byEmpty.cx.problem).toBe('flag.expr.divByZero');
    expect(num({ op: 'mod', args: [E, k(3)] })).toBe('0');
    expect(ev({ op: 'mod', args: [E, E] }).v).toBeNull();
  });

  it('min / max ignore empty operands; all-empty gives empty', () => {
    expect(num({ op: 'min', args: [k(5), k(2), k(8)] })).toBe('2');
    expect(num({ op: 'max', args: [k(5), k(2), k(8)] })).toBe('8');
    expect(num({ op: 'min', args: [E, k(3)] })).toBe('3');
    expect(num({ op: 'max', args: [E, k(3)] })).toBe('3');
    expect(ev({ op: 'min', args: [E, E] }).v).toBeNull();
    expect(ev({ op: 'max', args: [T, k(1)] }).cx.problem).toBe('flag.expr.notNumber');
  });
});

describe('length / split', () => {
  it('length counts Unicode code points, not UTF-16 units', () => {
    expect(num({ op: 'length', arg: k('שלום') })).toBe('4');
    expect(num({ op: 'length', arg: k('a😀b') })).toBe('3');
    expect(ev({ op: 'length', arg: E }).v).toBeNull();
  });

  it('split is 1-based; a negative index counts from the end; out of range is empty', () => {
    expect(ev({ op: 'split', arg: k('a,b,c'), separator: ',', index: 1 }).v).toBe('a');
    expect(ev({ op: 'split', arg: k('a,b,c'), separator: ',', index: 3 }).v).toBe('c');
    expect(ev({ op: 'split', arg: k('a,b,c'), separator: ',', index: -1 }).v).toBe('c');
    expect(ev({ op: 'split', arg: k('a,b,c'), separator: ',', index: -2 }).v).toBe('b');
    expect(ev({ op: 'split', arg: k('a,b,c'), separator: ',', index: 4 }).v).toBeNull();
    expect(ev({ op: 'split', arg: k('a,b,c'), separator: ',', index: -4 }).v).toBeNull();
    expect(ev({ op: 'split', arg: k('a,,c'), separator: ',', index: 2 }).v).toBeNull(); // empty part -> empty
    expect(ev({ op: 'split', arg: E, separator: ',', index: 1 }).v).toBeNull();
  });
});

describe('toNumber / toText', () => {
  it('toNumber parses text like the rest of the engine; failure reports notNumber', () => {
    expect(num({ op: 'toNumber', arg: k('1,234.50') })).toBe('1234.5');
    expect(ev({ op: 'toNumber', arg: E }).v).toBeNull();
    const bad = ev({ op: 'toNumber', arg: T });
    expect(bad.v).toBeNull();
    expect(bad.cx.problem).toBe('flag.expr.notNumber');
  });

  it('toText with no format is plain text; empty stays empty', () => {
    expect(ev({ op: 'toText', arg: A }).v).toBe('10');
    expect(ev({ op: 'toText', arg: E }).v).toBeNull();
  });

  it('toText with a number format renders like an output column format', () => {
    expect(ev({ op: 'toText', arg: k(1234.5), format: '0.00' }).v).toBe('1234.50');
    expect(ev({ op: 'toText', arg: k(1234567.125), format: '#,##0.00' }).v).toBe('1,234,567.13');
    expect(ev({ op: 'toText', arg: k(0.175), format: '0%' }).v).toBe('18%');
    const bad = ev({ op: 'toText', arg: T, format: '0.00' });
    expect(bad.v).toBeNull();
    expect(bad.cx.problem).toBe('flag.expr.notNumber');
  });

  it('toText with a date format uses formatYmd (month names honor output.language)', () => {
    expect(ev({ op: 'toText', arg: D, format: 'DD/MM/YYYY' }).v).toBe('05/03/2024');
    expect(ev({ op: 'toText', arg: D, format: 'MMMM YYYY' }, row(), 'en').v).toBe('March 2024');
    const bad = ev({ op: 'toText', arg: T, format: 'DD/MM/YYYY' });
    expect(bad.v).toBeNull();
    expect(bad.cx.problem).toBe('flag.expr.notDate');
  });
});

describe('dateAdd / dateDiff / endOfMonth', () => {
  it('dateAdd days is plain serial arithmetic', () => {
    const { v } = ev({ op: 'dateAdd', arg: D, days: 30 });
    expect(v).toEqual(dv(2024, 4, 4));
    expect(ev({ op: 'dateAdd', arg: E, days: 1 }).v).toBeNull();
  });

  it('dateAdd months/years clamps to month end like Excel EDATE', () => {
    // Jan 31 + 1 month: Feb 29 in a leap year, Feb 28 otherwise.
    expect(ev({ op: 'dateAdd', arg: k('2024-01-31'), months: 1 }).v).toEqual(dv(2024, 2, 29));
    expect(ev({ op: 'dateAdd', arg: k('2023-01-31'), months: 1 }).v).toEqual(dv(2023, 2, 28));
    // Rolls forward correctly when the day *does* exist in the target month.
    expect(ev({ op: 'dateAdd', arg: k('2024-01-15'), months: 1 }).v).toEqual(dv(2024, 2, 15));
    // Negative months, and a month rollover.
    expect(ev({ op: 'dateAdd', arg: k('2024-03-31'), months: -1 }).v).toEqual(dv(2024, 2, 29));
    // years: Feb 29 (leap) + 1 year -> Feb 28 (2025 isn't leap).
    expect(ev({ op: 'dateAdd', arg: k('2024-02-29'), years: 1 }).v).toEqual(dv(2025, 2, 28));
  });

  it('dateDiff days is a plain serial difference (can be negative)', () => {
    expect(num({ op: 'dateDiff', args: [k('2024-01-01'), k('2024-02-01')], unit: 'days' })).toBe('31');
    expect(num({ op: 'dateDiff', args: [k('2024-02-01'), k('2024-01-01')], unit: 'days' })).toBe('-31');
  });

  it('dateDiff months/years are complete units, like Excel DATEDIF', () => {
    // A full month/year needs the day to have "arrived": Jan 31 -> Feb 1 is 0
    // complete months; Jan 31 -> Mar 1 is 1 complete month (not 2).
    expect(num({ op: 'dateDiff', args: [k('2024-01-31'), k('2024-02-01')], unit: 'months' })).toBe('0');
    expect(num({ op: 'dateDiff', args: [k('2024-01-31'), k('2024-03-01')], unit: 'months' })).toBe('1');
    expect(num({ op: 'dateDiff', args: [k('2023-01-01'), k('2024-06-15')], unit: 'months' })).toBe('17');
    expect(num({ op: 'dateDiff', args: [k('2000-03-15'), k('2024-03-14')], unit: 'years' })).toBe('23');
    expect(num({ op: 'dateDiff', args: [k('2000-03-15'), k('2024-03-15')], unit: 'years' })).toBe('24');
  });

  // DECISION (see expr.ts): DATEDIF errors on a negative span; this engine never
  // errors, so dateDiff(b, a, unit) is defined as -dateDiff(a, b, unit).
  it('dateDiff on a negative span is the negation of the same measurement the other way round', () => {
    const fwd = num({ op: 'dateDiff', args: [k('2023-01-01'), k('2024-06-15')], unit: 'months' });
    const back = num({ op: 'dateDiff', args: [k('2024-06-15'), k('2023-01-01')], unit: 'months' });
    expect(back).toBe(String(-Number(fwd)));
    expect(num({ op: 'dateDiff', args: [D, D], unit: 'months' })).toBe('0');
  });

  it('dateDiff/dateAdd report notDate for a non-date, and pass empties through', () => {
    expect(ev({ op: 'dateDiff', args: [D, E], unit: 'days' }).v).toBeNull();
    const bad = ev({ op: 'dateDiff', args: [T, D], unit: 'days' });
    expect(bad.v).toBeNull();
    expect(bad.cx.problem).toBe('flag.expr.notDate');
  });

  it('endOfMonth gives the last calendar day, leap years included', () => {
    expect(ev({ op: 'endOfMonth', arg: k('2024-02-05') }).v).toEqual(dv(2024, 2, 29));
    expect(ev({ op: 'endOfMonth', arg: k('2023-02-05') }).v).toEqual(dv(2023, 2, 28));
    expect(ev({ op: 'endOfMonth', arg: k('2024-04-01') }).v).toEqual(dv(2024, 4, 30));
    expect(ev({ op: 'endOfMonth', arg: E }).v).toBeNull();
  });
});

describe('switch / lookup / call', () => {
  it('switch picks the first matching case, else the fallback', () => {
    const sw = (a: Val): Val =>
      ev(
        {
          op: 'switch',
          cases: [
            { when: { op: 'gt', args: [A, k(100)] }, then: k('big') },
            { when: { op: 'gt', args: [A, k(5)] }, then: k('medium') },
          ],
          else: k('small'),
        },
        row(a),
      ).v;
    expect(sw(new Decimal(200))).toBe('big');
    expect(sw(new Decimal(10))).toBe('medium');
    expect(sw(new Decimal(1))).toBe('small');
    expect(sw(null)).toBe('small'); // no case matches an empty value -> falls through
  });

  it('switch evaluates only the winning branch (like if)', () => {
    const e: Expr = {
      op: 'switch',
      cases: [{ when: k(true), then: k('ok') }],
      else: { op: 'div', args: [A, k(0)] },
    };
    const { v, cx } = ev(e);
    expect(v).toBe('ok');
    expect(cx.problem).toBeNull();
  });

  const table1: RulesTable = {
    name: 'products',
    columns: ['code', 'category', 'rate'],
    rows: [
      ['A1', 'Electronics', 0.1],
      ['B2', 'Furniture', 0.05],
    ],
  };
  const tablesEnv = { tables: compileTables([table1]) };

  it('lookup returns the matching column; the key is compared after type normalization', () => {
    expect(ev({ op: 'lookup', table: 'products', key: k('A1'), return: 'category', onMissing: 'empty' }, row(), 'he', tablesEnv).v).toBe(
      'Electronics',
    );
    // geresh/quote unification and trim, like every other equality in the engine.
    expect(ev({ op: 'lookup', table: 'products', key: k(' A1 '), return: 'rate', onMissing: 'empty' }, row(), 'he', tablesEnv).v).toEqual(
      new Decimal(0.1),
    );
  });

  it('lookup onMissing: flag reports "flag.lookupMissing" and gives empty', () => {
    const { v, cx } = ev({ op: 'lookup', table: 'products', key: k('ZZ'), return: 'category', onMissing: 'flag' }, row(), 'he', tablesEnv);
    expect(v).toBeNull();
    expect(cx.problem).toBe('flag.lookupMissing');
    expect(cx.problemValue).toBe('ZZ');
  });

  it('lookup onMissing: empty gives empty with no flag', () => {
    const { v, cx } = ev({ op: 'lookup', table: 'products', key: k('ZZ'), return: 'category', onMissing: 'empty' }, row(), 'he', tablesEnv);
    expect(v).toBeNull();
    expect(cx.problem).toBeNull();
  });

  it('lookup onMissing: keep returns the key value itself, unchanged', () => {
    const { v, cx } = ev({ op: 'lookup', table: 'products', key: k('ZZ'), return: 'category', onMissing: 'keep' }, row(), 'he', tablesEnv);
    expect(v).toBe('ZZ');
    expect(cx.problem).toBeNull();
  });

  it('lookup on an empty key gives empty, regardless of onMissing', () => {
    expect(ev({ op: 'lookup', table: 'products', key: E, return: 'category', onMissing: 'flag' }, row(), 'he', tablesEnv).v).toBeNull();
    expect(ev({ op: 'lookup', table: 'products', key: E, return: 'category', onMissing: 'flag' }, row(), 'he', tablesEnv).cx.problem).toBeNull();
  });

  it('call invokes a compiled function: params only, never the caller\'s columns', () => {
    const double: RulesFunction = {
      name: 'double',
      params: [{ name: 'x', type: 'decimal' }],
      returns: 'decimal',
      body: { op: 'mul', args: [{ param: 'x' }, { const: 2 }] },
    };
    const fns = compileFunctions([double], { language: 'he' }, new Map());
    expect(ev({ op: 'call', fn: 'double', args: [A] }, row(new Decimal(21)), 'he', { functions: fns }).v).toEqual(new Decimal(42));
    // A `call` with no functions in scope is an unknown reference (checkRules
    // normally rejects this before the engine ever runs).
    expect(() => ev({ op: 'call', fn: 'double', args: [A] }, row(new Decimal(21)))).toThrow();
  });

  it('a function may call an earlier function (nested calls with params)', () => {
    const inc: RulesFunction = {
      name: 'inc',
      params: [{ name: 'x', type: 'decimal' }],
      returns: 'decimal',
      body: { op: 'add', args: [{ param: 'x' }, { const: 1 }] },
    };
    const incTwice: RulesFunction = {
      name: 'incTwice',
      params: [{ name: 'x', type: 'decimal' }],
      returns: 'decimal',
      body: { op: 'call', fn: 'inc', args: [{ op: 'call', fn: 'inc', args: [{ param: 'x' }] }] },
    };
    const fns = compileFunctions([inc, incTwice], { language: 'he' }, new Map());
    const f = fns.get('incTwice')!;
    const cx = newEvalCx();
    expect(f([new Decimal(5)], cx)).toEqual(new Decimal(7));
  });

  it('a function calling itself or a function defined below it fails to compile (acyclic by construction)', () => {
    const later: RulesFunction = {
      name: 'later',
      params: [{ name: 'x', type: 'decimal' }],
      returns: 'decimal',
      body: { op: 'call', fn: 'notYetDefined', args: [{ param: 'x' }] },
    };
    expect(() => compileFunctions([later], { language: 'he' }, new Map())).toThrow();
  });
});

describe('functions used from several computed columns (pipeline)', () => {
  it('one function, called from 3 computed columns, each with different args', () => {
    const netOf: RulesFunction = {
      name: 'netOf',
      params: [
        { name: 'gross', type: 'decimal' },
        { name: 'rate', type: 'decimal' },
      ],
      returns: 'decimal',
      body: { op: 'round', digits: 2, arg: { op: 'div', args: [{ param: 'gross' }, { op: 'add', args: [{ const: 1 }, { param: 'rate' }] }] } },
    };
    const r = rules({
      columns: [col('amount', 'decimal'), col('rate', 'decimal')],
      transform: {
        functions: [netOf],
        computed: [
          { id: 'netAtOwnRate', type: 'decimal', expr: { op: 'call', fn: 'netOf', args: [{ col: 'amount' }, { col: 'rate' }] } },
          { id: 'netAt10', type: 'decimal', expr: { op: 'call', fn: 'netOf', args: [{ col: 'amount' }, { const: 0.1 }] } },
          { id: 'netAt20', type: 'decimal', expr: { op: 'call', fn: 'netOf', args: [{ col: 'amount' }, { const: 0.2 }] } },
        ],
      },
      out: ['amount', 'netAtOwnRate', 'netAt10', 'netAt20'],
    });
    const res = runOk(r, table(['amount', 'rate'], [[118, 0.18]]));
    expect(values(res.sheet)).toEqual([[118, 100, 107.27, 98.33]]);
  });

  it('a table declared in transform.tables drives lookup in a computed column', () => {
    const r = rules({
      columns: [col('code', 'text')],
      transform: {
        tables: [{ name: 'cat', columns: ['code', 'label'], rows: [['A', 'Alpha'], ['B', 'Beta']] }],
        computed: [
          { id: 'label', type: 'text', expr: { op: 'lookup', table: 'cat', key: { col: 'code' }, return: 'label', onMissing: 'flag' } },
        ],
      },
      out: ['code', 'label'],
    });
    const res = runOk(r, table(['code'], [['A'], ['B'], ['C']]));
    expect(values(res.sheet)).toEqual([
      ['A', 'Alpha'],
      ['B', 'Beta'],
      ['C', null],
    ]);
    expect(res.flags).toEqual([{ rowNumber: 4, column: 'label', rule: 'expr', value: 'C', messageKey: 'flag.lookupMissing' }]);
  });
});

describe('computed columns in the pipeline', () => {
  it('run in order, may reference earlier computed ids, are coerced to their type', () => {
    const r = rules({
      columns: [col('amount', 'decimal'), col('rate', 'decimal')],
      transform: {
        computed: [
          { id: 'total', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'amount' }, { col: 'rate' }] } } },
          { id: 'withTax', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'total' }, k(1.18)] } } },
          { id: 'label', type: 'text', expr: { op: 'concat', args: [k('#'), { col: 'total' }] } },
          { id: 'ratio', type: 'decimal', expr: { op: 'div', args: [{ col: 'amount' }, { col: 'rate' }] } },
        ],
      },
      out: ['amount', 'total', 'withTax', 'label', 'ratio'],
    });
    const res = runOk(r, table(['amount', 'rate'], [[1000, 0.17], [342.05, 0]]));
    expect(values(res.sheet)).toEqual([
      [1000, 170, 200.6, '#170', 5882.3529411764705],
      [342.05, 0, 0, '#0', null],
    ]);
    expect(res.flags).toEqual([
      { rowNumber: 3, column: 'ratio', rule: 'expr', value: null, messageKey: 'flag.expr.divByZero' },
    ]);
    const cells = dataRows(res.sheet)[1]!.cells;
    expect(cells[4]!.flagged).toBe(true);
    expect(cells[1]!.flagged).toBeUndefined();
  });
});

describe('roundExcel', () => {
  it('matches excelRound (values/numbers) for every digits value', async () => {
    const { roundExcel } = await import('../../src/pipeline/v1/expr');
    const { excelRound } = await import('../../src/values/numbers');
    const samples = ['2.675', '-1.005', '1234.5', '-1234.5', '0.125', '-0.125', '1.0049999', '999.995', '0', '-0.5', '0.5', '123456789.123456789', '-7.45', '1e-7'];
    for (let i = 0; i < 200; i++) samples.push(String((i * 7919) % 100003 / 1000 - 50));
    for (const s of samples) {
      for (let digits = -3; digits <= 6; digits++) {
        const d = new Decimal(s);
        expect(roundExcel(d, digits).eq(excelRound(d, digits)), `${s} @ ${digits}`).toBe(true);
      }
    }
  });
});
