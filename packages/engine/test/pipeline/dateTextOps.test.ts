// The date and text operations added after learn-v6: weekday, makeDate, toDate, date("...") literals,
// keepChars, titleCase, find - and the `ddd`/`dddd` weekday-name date tokens. Each is written as FORMULA
// TEXT (the way the editor's Advanced view and the formula parser see it) and run through the real
// expression compiler, in Hebrew and English. Types are in test/check/typeCheck.test.ts, the schema in
// packages/shared/test/schema.exprOps.test.ts, the prompt exclusion in test/check/promptOpsSync.test.ts.
import Decimal from 'decimal.js';
import type { Expr } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { canonicalizeExpr } from '../../src/formula/canonicalize';
import { parseFormula } from '../../src/formula/parseFormula';
import { printFormula } from '../../src/formula/printFormula';
import { compileExpr, newEvalCx } from '../../src/pipeline/v1/expr';
import { DateVal, type Val } from '../../src/pipeline/v1/values';
import { ymdToSerial } from '../../src/values/dates';
import { col, dataRows, rules, runOk, table, values } from './helpers';

function parse(formula: string): Expr {
  const r = parseFormula(formula);
  if (!r.ok) throw new Error(`formula "${formula}": ${r.error.message}`);
  return r.expr;
}

const dv = (y: number, m: number, d: number): DateVal => new DateVal({ y, m, d });
const dec = (n: number): Decimal => new Decimal(n);

/** Evaluates formula text against named values; the result and the first problem reported (if any). */
function run(formula: string, vars: Record<string, Val> = {}, lang: 'he' | 'en' = 'en'): { v: Val; problem: string | null; flagValue: Val } {
  const slotOf = new Map(Object.keys(vars).map((k, i) => [k, i] as const));
  const fn = compileExpr(parse(formula), { slotOf, language: lang });
  const cx = newEvalCx();
  const v = fn(Object.values(vars), cx);
  return { v, problem: cx.problem, flagValue: cx.problemValue };
}

function ymd(v: Val): [number, number, number] | null {
  if (v === null) return null;
  expect(v).toBeInstanceOf(DateVal);
  const d = v as DateVal;
  return [d.y, d.m, d.d];
}

function int(v: Val): number | null {
  if (v === null) return null;
  expect(v).toBeInstanceOf(Decimal);
  return (v as Decimal).toNumber();
}

describe('weekday(date): 1 = Sunday ... 7 = Saturday', () => {
  it('numbers the week from Sunday (the Israeli convention)', () => {
    // 2026-01-01 is a Thursday.
    const days = [4, 5, 6, 7, 8, 9, 10].map((d) => int(run('weekday(d)', { d: dv(2026, 1, d) }).v));
    expect(days).toEqual([1, 2, 3, 4, 5, 6, 7]); // 4 Jan = Sunday ... 10 Jan = Saturday
    expect(int(run('weekday(d)', { d: dv(2026, 1, 1) }).v)).toBe(5);
  });

  it('is right across leap days and century boundaries', () => {
    expect(int(run('weekday(d)', { d: dv(2024, 2, 29) }).v)).toBe(5); // Thursday
    expect(int(run('weekday(d)', { d: dv(2000, 1, 1) }).v)).toBe(7); // Saturday
    expect(int(run('weekday(d)', { d: dv(2100, 3, 1) }).v)).toBe(2); // Monday
    expect(int(run('weekday(d)', { d: dv(1900, 3, 1) }).v)).toBe(5); // Thursday
  });

  it('reads ISO text as a date, leaves empty empty and flags a non-date', () => {
    expect(int(run('weekday(t)', { t: '2026-01-04' }).v)).toBe(1);
    expect(run('weekday(d)', { d: null })).toEqual({ v: null, problem: null, flagValue: null });
    const bad = run('weekday(t)', { t: 'not a date' });
    expect(bad.v).toBeNull();
    expect(bad.problem).toBe('flag.expr.notDate');
  });
});

describe('dateFormat / toText: ddd and dddd are the weekday name in output.language', () => {
  const thu = dv(2026, 1, 1);
  const sat = dv(2026, 1, 3);
  const sun = dv(2026, 1, 4);

  it('English', () => {
    expect(run('dateFormat(d, "dddd")', { d: thu }, 'en').v).toBe('Thursday');
    expect(run('dateFormat(d, "ddd")', { d: thu }, 'en').v).toBe('Thu');
    expect(run('dateFormat(d, "dddd, D MMMM YYYY")', { d: sun }, 'en').v).toBe('Sunday, 4 January 2026');
    expect(run('dateFormat(d, "ddd DD/MM")', { d: thu }, 'en').v).toBe('Thu 01/01');
  });

  it('Hebrew', () => {
    expect(run('dateFormat(d, "dddd")', { d: thu }, 'he').v).toBe('יום חמישי');
    expect(run('dateFormat(d, "dddd")', { d: sun }, 'he').v).toBe('יום ראשון');
    expect(run('dateFormat(d, "dddd")', { d: sat }, 'he').v).toBe('שבת');
    expect(run('dateFormat(d, "ddd")', { d: thu }, 'he').v).toBe("יום ה'");
    expect(run('dateFormat(d, "dddd DD/MM/YYYY")', { d: sun }, 'he').v).toBe('יום ראשון 04/01/2026');
  });

  it('the same tokens work in toText with a date format, and a plain dd is still the day', () => {
    expect(run('toText(d, "dddd")', { d: thu }, 'en').v).toBe('Thursday');
    expect(run('toText(d, "dd/mm")', { d: thu }, 'en').v).toBe('01/01');
    expect(run('dateFormat(d, "DD")', { d: dv(2026, 1, 9) }, 'en').v).toBe('09');
  });
});

describe('makeDate(year, month, day)', () => {
  it('builds a date from three numbers', () => {
    expect(ymd(run('makeDate(y, m, d)', { y: dec(2026), m: dec(1), d: dec(31) }).v)).toEqual([2026, 1, 31]);
    expect(ymd(run('makeDate(2024, 2, 29)').v)).toEqual([2024, 2, 29]);
  });

  it('reads numbers kept as text', () => {
    expect(ymd(run('makeDate(y, m, d)', { y: '2026', m: '03', d: '5' }).v)).toEqual([2026, 3, 5]);
  });

  it('an impossible date is empty and flagged, with the parts as the flag value', () => {
    for (const [y, m, d] of [[2026, 2, 30], [2026, 13, 1], [2025, 2, 29], [2026, 0, 5], [2026, 4, 31], [2026, 1, 0]] as const) {
      const r = run('makeDate(y, m, d)', { y: dec(y), m: dec(m), d: dec(d) });
      expect(r.v, `${y}-${m}-${d}`).toBeNull();
      expect(r.problem, `${y}-${m}-${d}`).toBe('flag.expr.notDate');
      expect(r.flagValue).toBe(`${y}-${m}-${d}`);
    }
  });

  it('a year outside 1900-9999 (including a 2-digit year) and a fraction are invalid', () => {
    expect(run('makeDate(26, 1, 5)').problem).toBe('flag.expr.notDate');
    expect(run('makeDate(1899, 12, 31)').problem).toBe('flag.expr.notDate');
    expect(run('makeDate(10000, 1, 1)').problem).toBe('flag.expr.notDate');
    expect(run('makeDate(2026, 1.5, 1)').problem).toBe('flag.expr.notDate');
    expect(ymd(run('makeDate(1900, 1, 1)').v)).toEqual([1900, 1, 1]);
    expect(ymd(run('makeDate(9999, 12, 31)').v)).toEqual([9999, 12, 31]);
  });

  it('an empty part gives an empty date without a flag; text that is not a number flags notNumber', () => {
    expect(run('makeDate(y, m, d)', { y: dec(2026), m: null, d: dec(1) })).toEqual({ v: null, problem: null, flagValue: null });
    const bad = run('makeDate(y, m, d)', { y: 'abc', m: dec(1), d: dec(1) });
    expect(bad.v).toBeNull();
    expect(bad.problem).toBe('flag.expr.notNumber');
  });
});

describe('toDate(text, format): the inputFormats tokens plus month names in Hebrew and English', () => {
  it('reads numeric formats', () => {
    expect(ymd(run('toDate(t, "DD/MM/YYYY")', { t: '31/01/2026' }).v)).toEqual([2026, 1, 31]);
    expect(ymd(run('toDate(t, "D.M.YY")', { t: '5.3.26' }).v)).toEqual([2026, 3, 5]);
    expect(ymd(run('toDate(t, "MM/DD/YYYY")', { t: '01/31/2026' }).v)).toEqual([2026, 1, 31]);
    expect(ymd(run('toDate(t, "YYYYMMDD")', { t: '20260131' }).v)).toEqual([2026, 1, 31]);
  });

  it('reads a number as its plain text', () => {
    expect(ymd(run('toDate(n, "YYYYMMDD")', { n: dec(20260131) }).v)).toEqual([2026, 1, 31]);
  });

  it('reads English month names (MMMM full, MMM short, any case, Sept too)', () => {
    expect(ymd(run('toDate(t, "D MMMM YYYY")', { t: '5 September 2026' }).v)).toEqual([2026, 9, 5]);
    expect(ymd(run('toDate(t, "MMMM D, YYYY")', { t: 'March 7, 2024' }).v)).toEqual([2024, 3, 7]);
    expect(ymd(run('toDate(t, "D MMM YYYY")', { t: '05 Sep 2026' }).v)).toEqual([2026, 9, 5]);
    expect(ymd(run('toDate(t, "D MMM YYYY")', { t: '5 SEPT 2026' }).v)).toEqual([2026, 9, 5]);
    expect(ymd(run('toDate(t, "D MMMM YYYY")', { t: '5 may 2026' }).v)).toEqual([2026, 5, 5]);
    expect(ymd(run('toDate(t, "D-MMM-YY")', { t: '5-Dec-26' }).v)).toEqual([2026, 12, 5]);
  });

  it('reads Hebrew month names, full and short, in either direction of the file language', () => {
    expect(ymd(run('toDate(t, "D MMMM YYYY")', { t: '5 ספטמבר 2026' }).v)).toEqual([2026, 9, 5]);
    expect(ymd(run('toDate(t, "D MMMM YYYY")', { t: '17 דצמבר 2025' }, 'he').v)).toEqual([2025, 12, 17]);
    expect(ymd(run('toDate(t, "D MMM YYYY")', { t: '3 אוק 2026' }).v)).toEqual([2026, 10, 3]);
    expect(ymd(run('toDate(t, "D MMMM YYYY")', { t: '9 מרס 2026' }).v)).toEqual([2026, 3, 9]);
    // The Hebrew "in <month>" prefix is a literal in the format.
    expect(ymd(run('toDate(t, "D בMMMM YYYY")', { t: '5 בספטמבר 2026' }).v)).toEqual([2026, 9, 5]);
    // An English name in a Hebrew-language file (and vice versa) is fine too.
    expect(ymd(run('toDate(t, "D MMMM YYYY")', { t: '5 September 2026' }, 'he').v)).toEqual([2026, 9, 5]);
  });

  it('a format without a day (month and year) means the 1st', () => {
    expect(ymd(run('toDate(t, "MMMM YYYY")', { t: 'ינואר 2026' }).v)).toEqual([2026, 1, 1]);
    expect(ymd(run('toDate(t, "MMMM YYYY")', { t: 'January 2026' }).v)).toEqual([2026, 1, 1]);
    expect(ymd(run('toDate(t, "MM/YYYY")', { t: '07/2025' }).v)).toEqual([2025, 7, 1]);
  });

  it('a text that does not fit is empty and flagged with the text as the value', () => {
    for (const [format, text] of [
      ['DD/MM/YYYY', '31/02/2026'], // impossible date
      ['DD/MM/YYYY', '2026-01-31'], // other shape
      ['D MMMM YYYY', '5 Foo 2026'], // unknown month name
      ['D MMMM YYYY', '5 September'], // no year
      ['MMMM YYYY', 'January 26'], // 4-digit year needed
      ['D MMMM YYYY', ' 5 September 2026 x'], // trailing junk
      ['D MMMM YYYY', 'garbage'],
    ] as const) {
      const r = run('toDate(t, f)'.replace('f', JSON.stringify(format)), { t: text });
      expect(r.v, `${format} / ${text}`).toBeNull();
      expect(r.problem, `${format} / ${text}`).toBe('flag.expr.notDate');
      expect(r.flagValue).toBe(text);
    }
  });

  it('empty stays empty without a flag, whitespace around the text is ignored, a date stays a date', () => {
    expect(run('toDate(t, "DD/MM/YYYY")', { t: null })).toEqual({ v: null, problem: null, flagValue: null });
    expect(ymd(run('toDate(t, "D MMMM YYYY")', { t: '  5 September 2026  ' }).v)).toEqual([2026, 9, 5]);
    expect(ymd(run('toDate(d, "DD/MM/YYYY")', { d: dv(2026, 1, 31) }).v)).toEqual([2026, 1, 31]);
  });

  it('dates before 1900 are refused, not read as 1900 + year', () => {
    expect(run('toDate(t, "DD/MM/YYYY")', { t: '05/01/0026' }).problem).toBe('flag.expr.notDate');
    expect(run('toDate(t, "DD/MM/YYYY")', { t: '05/01/1850' }).problem).toBe('flag.expr.notDate');
  });
});

describe('date("YYYY-MM-DD") literal', () => {
  it('is a date, usable wherever a date is', () => {
    expect(ymd(run('date("2026-12-31")').v)).toEqual([2026, 12, 31]);
    expect(int(run('dateDiff(d, date("2026-12-31"), "days")', { d: dv(2026, 12, 1) }).v)).toBe(30);
    expect(int(run('dateDiff(date("2026-01-01"), d, "days")', { d: dv(2026, 1, 31) }).v)).toBe(30);
    expect(run('d < date("2026-06-01")', { d: dv(2026, 5, 31) }).v).toBe(true);
    expect(run('d < date("2026-06-01")', { d: dv(2026, 6, 1) }).v).toBe(false);
    expect(int(run('weekday(date("2026-01-04"))').v)).toBe(1);
  });

  it('only a real ISO date parses (an impossible or malformed one is a parse error, not a runtime surprise)', () => {
    for (const text of ['date("2026-02-30")', 'date("2026-1-5")', 'date("31/01/2026")', 'date("")', 'date("1899-12-31")', 'date(x)']) {
      expect(parseFormula(text).ok, text).toBe(false);
    }
  });
});

describe('keepChars(text, "digits" | "letters" | "lettersAndDigits")', () => {
  it('digits drops everything else, leading zeros stay (it is text)', () => {
    expect(run('keepChars(t, "digits")', { t: 'Ref#A-77/2024' }).v).toBe('772024');
    expect(run('keepChars(t, "digits")', { t: '(054) 123-4567' }).v).toBe('0541234567');
    expect(run('keepChars(t, "digits")', { t: "מס' 4521-ב" }).v).toBe('4521');
  });

  it('letters counts Hebrew letters as letters (not niqqud, punctuation or spaces)', () => {
    expect(run('keepChars(t, "letters")', { t: "מס' 4521-ב" }).v).toBe('מסב');
    expect(run('keepChars(t, "letters")', { t: 'Ab1-cD 2é' }).v).toBe('AbcDé');
    expect(run('keepChars(t, "letters")', { t: 'שָׁלוֹם 123' }).v).toBe('שלום');
  });

  it('lettersAndDigits keeps both, in order', () => {
    expect(run('keepChars(t, "lettersAndDigits")', { t: "מס' 4521-ב / A7" }).v).toBe('מס4521בA7');
  });

  it('nothing left is empty; empty in is empty out', () => {
    expect(run('keepChars(t, "digits")', { t: 'no digits here' }).v).toBeNull();
    expect(run('keepChars(t, "digits")', { t: null }).v).toBeNull();
  });

  it('reads a number or a date as its text', () => {
    expect(run('keepChars(n, "digits")', { n: dec(1234.5) }).v).toBe('12345');
  });

  it('an unknown class is a parse error', () => {
    expect(parseFormula('keepChars(t, "everything")').ok).toBe(false);
    expect(parseFormula('keepChars(t, cls)').ok).toBe(false);
  });
});

describe('titleCase(text)', () => {
  it('first letter of each word upper, the rest lower', () => {
    expect(run('titleCase(t)', { t: 'dana COHEN' }).v).toBe('Dana Cohen');
    expect(run('titleCase(t)', { t: 'JOHN SMITH JR' }).v).toBe('John Smith Jr');
    expect(run('titleCase(t)', { t: 'acme   widgets\tltd' }).v).toBe('Acme   Widgets\tLtd');
  });

  it('a hyphen starts a word; an apostrophe does not', () => {
    expect(run('titleCase(t)', { t: 'JEAN-LUC picard' }).v).toBe('Jean-Luc Picard');
    expect(run('titleCase(t)', { t: "o'neil" }).v).toBe("O'neil");
    expect(run('titleCase(t)', { t: "don't" }).v).toBe("Don't");
  });

  it('leading punctuation does not count; a word that starts with a digit is just lower-cased', () => {
    expect(run('titleCase(t)', { t: '(israel) ltd' }).v).toBe('(Israel) Ltd');
    expect(run('titleCase(t)', { t: '3RD floor' }).v).toBe('3rd Floor');
  });

  it('Hebrew is unaffected, mixed text changes only its Latin letters', () => {
    expect(run('titleCase(t)', { t: 'דנה כהן' }).v).toBe('דנה כהן');
    expect(run('titleCase(t)', { t: 'דנה SMITH בע"מ' }).v).toBe('דנה Smith בע"מ');
  });

  it('empty stays empty', () => {
    expect(run('titleCase(t)', { t: null }).v).toBeNull();
  });
});

describe('find(text, "search")', () => {
  it('is the 1-based position of the first occurrence', () => {
    expect(int(run('find(t, " - ")', { t: 'Hammer - Heavy duty - 500g' }).v)).toBe(7);
    expect(int(run('find(t, "H")', { t: 'Hammer - Heavy duty' }).v)).toBe(1);
    expect(int(run('find(t, "-")', { t: 'INV-2026-0042' }).v)).toBe(4);
  });

  it('is 0 when the text is absent, and case-sensitive', () => {
    expect(int(run('find(t, "@")', { t: 'no email here' }).v)).toBe(0);
    expect(int(run('find(t, "inv")', { t: 'INV-1' }).v)).toBe(0);
  });

  it('counts characters, not UTF-16 units, and works in Hebrew', () => {
    expect(int(run('find(t, " ")', { t: 'שלום עולם' }).v)).toBe(5);
    expect(int(run('find(t, "עולם")', { t: 'שלום עולם' }).v)).toBe(6);
    expect(int(run('find(t, "b")', { t: 'a\u{1F600}b' }).v)).toBe(3);
  });

  it('is literal: pattern characters are just characters', () => {
    expect(int(run('find(t, ".*")', { t: 'a.*b' }).v)).toBe(2);
    expect(int(run('find(t, ".")', { t: 'abc' }).v)).toBe(0);
  });

  it('empty text stays empty; an empty search is a parse error', () => {
    expect(run('find(t, "-")', { t: null }).v).toBeNull();
    expect(parseFormula('find(t, "")').ok).toBe(false);
    expect(parseFormula('find(t, other)').ok).toBe(false);
  });

  it('is an integer: usable in comparisons and arithmetic', () => {
    expect(run('find(t, "-") > 0', { t: 'a-b' }).v).toBe(true);
    expect(run('find(t, "-") > 0', { t: 'ab' }).v).toBe(false);
    expect(int(run('find(t, "-") + 1', { t: 'a-b' }).v)).toBe(3);
  });
});

describe('formula text round trip', () => {
  it('prints every new op back to the text it came from', () => {
    for (const text of [
      'weekday(d)',
      'makeDate(year, month, day)',
      'makeDate(2026, month + 1, 1)',
      'toDate(t, "D MMMM YYYY")',
      'toDate(t, "MMMM YYYY")',
      'date("2026-01-31")',
      'dateDiff(d, date("2026-12-31"), "days")',
      'keepChars(t, "digits")',
      'keepChars(t, "letters")',
      'keepChars(t, "lettersAndDigits")',
      'titleCase(trim(t))',
      'find(t, " - ")',
      'substr(t, 1, 3)',
    ]) {
      const expr = parse(text);
      expect(printFormula(expr), text).toBe(text);
      expect(parse(printFormula(expr))).toEqual(expr);
    }
  });

  it('canonicalizeExpr leaves them as they are and flattens only the arithmetic inside them', () => {
    for (const text of ['weekday(d)', 'toDate(t, "MMMM YYYY")', 'date("2026-01-31")', 'keepChars(t, "letters")', 'titleCase(t)', 'find(t, "-")', 'makeDate(y, m, d)']) {
      expect(canonicalizeExpr(parse(text)), text).toEqual(parse(text));
    }
    const nested: Expr = { op: 'makeDate', args: [{ op: 'add', args: [{ op: 'add', args: [{ col: 'a' }, { col: 'b' }] }, { col: 'c' }] }, { const: 1 }, { const: 1 }] };
    expect(canonicalizeExpr(nested)).toEqual(parse('makeDate(a + b + c, 1, 1)'));
  });

  it('builds the documented tree shapes', () => {
    expect(parse('weekday(d)')).toEqual({ op: 'weekday', arg: { col: 'd' } });
    expect(parse('makeDate(y, m, d)')).toEqual({ op: 'makeDate', args: [{ col: 'y' }, { col: 'm' }, { col: 'd' }] });
    expect(parse('toDate(t, "D MMMM YYYY")')).toEqual({ op: 'toDate', arg: { col: 't' }, format: 'D MMMM YYYY' });
    expect(parse('date("2026-01-31")')).toEqual({ op: 'dateLiteral', value: '2026-01-31' });
    expect(parse('keepChars(t, "digits")')).toEqual({ op: 'keepChars', arg: { col: 't' }, chars: 'digits' });
    expect(parse('titleCase(t)')).toEqual({ op: 'titleCase', arg: { col: 't' } });
    expect(parse('find(t, "-")')).toEqual({ op: 'find', arg: { col: 't' }, search: '-' });
  });

  it('a bare `date` is still a column named date', () => {
    expect(parse('weekday(date)')).toEqual({ op: 'weekday', arg: { col: 'date' } });
  });
});

describe('the whole pipeline: rules written with the new ops', () => {
  it('builds dates from parts, names the weekday in the output language, and flags what is not a date', () => {
    const r = rules({
      columns: [col('doc'), col('day', 'integer'), col('month', 'integer'), col('year', 'integer')],
      transform: {
        computed: [
          { id: 'when', type: 'date', expr: parse('makeDate(year, month, day)') },
          { id: 'dow', type: 'text', expr: parse('dateFormat(when, "dddd")') },
          { id: 'dowNum', type: 'integer', expr: parse('weekday(when)') },
        ],
      },
      out: ['doc', { header: 'תאריך', from: 'when', format: 'DD/MM/YYYY' }, { header: 'יום', from: 'dow' }, { header: 'מספר יום', from: 'dowNum' }],
      output: { language: 'he' },
    });
    const res = runOk(
      r,
      table(['doc', 'day', 'month', 'year'], [
        ['a', 4, 1, 2026],
        ['b', 31, 2, 2026],
        ['c', 3, 1, 2026],
      ]),
    );
    expect(values(res.sheet)).toEqual([
      ['a', ymdToSerial({ y: 2026, m: 1, d: 4 }), 'יום ראשון', 1],
      ['b', null, null, null],
      ['c', ymdToSerial({ y: 2026, m: 1, d: 3 }), 'שבת', 7],
    ]);
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.messageKey])).toEqual([[3, 'when', 'flag.expr.notDate']]);
    expect(dataRows(res.sheet)[1]!.cells[1]!.flagged).toBe(true);
  });

  it('parses month-name dates, keeps digits, title-cases and finds, all in one file', () => {
    const r = rules({
      columns: [col('name'), col('ref'), col('when'), col('desc')],
      transform: {
        computed: [
          { id: 'day', type: 'date', expr: parse('toDate(when, "D MMMM YYYY")') },
          { id: 'num', type: 'text', expr: parse('keepChars(ref, "digits")') },
          { id: 'fixed', type: 'text', expr: parse('titleCase(name)') },
          { id: 'pos', type: 'integer', expr: parse('find(desc, " - ")') },
          { id: 'left', type: 'integer', expr: parse('dateDiff(day, date("2026-12-31"), "days")') },
        ],
      },
      out: [
        { header: 'name', from: 'fixed' },
        { header: 'num', from: 'num' },
        { header: 'day', from: 'day', format: 'DD/MM/YYYY' },
        { header: 'pos', from: 'pos' },
        { header: 'left', from: 'left' },
      ],
      output: { language: 'en' },
    });
    const res = runOk(
      r,
      table(['name', 'ref', 'when', 'desc'], [
        ['dana COHEN', 'Ref#A-77/2024', '5 September 2026', 'Hammer - Heavy'],
        ['דנה כהן', "מס' 4521-ב", '9 מרץ 2026', 'no separator'],
        ['x', 'y', 'someday', ''],
      ]),
    );
    expect(values(res.sheet)).toEqual([
      ['Dana Cohen', '772024', ymdToSerial({ y: 2026, m: 9, d: 5 }), 7, 117],
      ['דנה כהן', '4521', ymdToSerial({ y: 2026, m: 3, d: 9 }), 0, 297],
      ['X', null, null, null, null],
    ]);
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.messageKey, f.value])).toEqual([[4, 'day', 'flag.expr.notDate', 'someday']]);
  });
});
