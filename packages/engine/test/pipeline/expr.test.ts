import Decimal from 'decimal.js';
import type { Expr } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { compileExpr, newEvalCx, substrCodePoints, type EvalCx } from '../../src/pipeline/v1/expr';
import { DateVal, type Val } from '../../src/pipeline/v1/values';
import { col, dataRows, rules, runOk, table, values } from './helpers';

const SLOTS = new Map([
  ['a', 0],
  ['b', 1],
  ['t', 2],
  ['d', 3],
  ['e', 4], // always empty
]);

function row(a: Val = new Decimal(10), b: Val = new Decimal(4), t: Val = '  Hello  World ', d: Val = new DateVal({ y: 2024, m: 3, d: 5 })): Val[] {
  return [a, b, t, d, null];
}

function ev(e: Expr, r: Val[] = row(), lang: 'he' | 'en' = 'he'): { v: Val; cx: EvalCx } {
  const fn = compileExpr(e, { slotOf: SLOTS, language: lang });
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
const E = { col: 'e' };
const k = (c: string | number | boolean | null) => ({ const: c });

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
    // premium × rate, then ROUND(…, 2): 342.05 × 1.18 = 403.619 → 403.62
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

  it('rejects depth > 6 at compile time', () => {
    let e: Expr = A;
    for (let i = 0; i < 6; i++) e = { op: 'neg', arg: e };
    expect(() => compileExpr(e, { slotOf: SLOTS, language: 'he' })).toThrow();
  });
});

describe('computed columns in the pipeline', () => {
  it('run in order, may reference earlier computed ids, are coerced to their type', () => {
    const r = rules({
      columns: [col('premium', 'decimal'), col('rate', 'decimal')],
      transform: {
        computed: [
          { id: 'commission', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'premium' }, { col: 'rate' }] } } },
          { id: 'withVat', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'commission' }, k(1.18)] } } },
          { id: 'label', type: 'text', expr: { op: 'concat', args: [k('#'), { col: 'commission' }] } },
          { id: 'ratio', type: 'decimal', expr: { op: 'div', args: [{ col: 'premium' }, { col: 'rate' }] } },
        ],
      },
      out: ['premium', 'commission', 'withVat', 'label', 'ratio'],
    });
    const res = runOk(r, table(['premium', 'rate'], [[1000, 0.17], [342.05, 0]]));
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
