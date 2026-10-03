// The rules map says what an across-row (window) column does, in plain words, in both languages - for all eleven functions.
import type { Expr, LearnResult, WindowFn } from '@formatai/shared';
import { WINDOW_FNS } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { describeRules } from './describe';
import { lineTexts, withColumn } from './fixtures';

const HE_HEADERS: Record<string, string> = { c_cost: 'עלות', c_supplier: 'ספק', c_date: 'תאריך', c_order: 'מספר הזמנה', c_amount: 'סכום', c_group: 'קבוצה', c_name: 'שם' };

function sentence(expr: Expr, lang: 'en' | 'he', header = 'Result'): string {
  const base: LearnResult = withColumn(header, expr);
  const r: LearnResult =
    lang === 'he' ? { ...base, input: { ...base.input, columns: base.input.columns.map((c) => ({ ...c, header: HE_HEADERS[c.id] ?? c.header })) } } : base;
  const model = describeRules(r, { lang });
  const found = lineTexts(model).find(([id]) => id === `col:${header}`);
  if (!found) throw new Error(`no line in ${JSON.stringify(lineTexts(model))}`);
  return found[1];
}

const w = (n: object): Expr => ({ op: 'window', ...n }) as Expr;
const c = (id: string): Expr => ({ col: id });

describe('window columns, in English', () => {
  const en = (e: Expr): string => sentence(e, 'en');

  it('running total: the column, the group, the order', () => {
    expect(en(w({ fn: 'runningSum', arg: c('c_amount'), by: ['c_supplier'] }))).toBe('Result ← running total of Amount per Supplier, in file order');
    expect(en(w({ fn: 'runningSum', arg: c('c_amount') }))).toBe('Result ← running total of Amount, in file order');
    expect(en(w({ fn: 'runningSum', arg: c('c_amount'), by: ['c_supplier'], order: [{ column: 'c_date', dir: 'asc' }] }))).toBe(
      'Result ← running total of Amount per Supplier, in order of Date',
    );
    expect(en(w({ fn: 'runningSum', arg: c('c_amount'), order: [{ column: 'c_date', dir: 'desc' }, { column: 'c_order', dir: 'asc' }] }))).toBe(
      'Result ← running total of Amount, in order of Date (descending), then Order number',
    );
    expect(en(w({ fn: 'runningSum', arg: c('c_amount'), by: ['c_supplier', 'c_group'] }))).toBe('Result ← running total of Amount per Supplier and Group, in file order');
  });

  it('a group total, average, lowest, highest and count', () => {
    expect(en(w({ fn: 'groupSum', arg: c('c_amount'), by: ['c_group'] }))).toBe('Result ← the total of Amount per Group');
    expect(en(w({ fn: 'groupSum', arg: c('c_amount') }))).toBe('Result ← the total of Amount over all rows');
    expect(en(w({ fn: 'groupAvg', arg: c('c_amount'), by: ['c_group'] }))).toBe('Result ← the average of Amount per Group');
    expect(en(w({ fn: 'groupMin', arg: c('c_date'), by: ['c_group'] }))).toBe('Result ← the lowest Date per Group');
    expect(en(w({ fn: 'groupMax', arg: c('c_amount') }))).toBe('Result ← the highest Amount over all rows');
    expect(en(w({ fn: 'groupCount', by: ['c_supplier'] }))).toBe('Result ← the number of rows per Supplier');
    expect(en(w({ fn: 'groupCount' }))).toBe('Result ← the number of rows over all rows');
    expect(en(w({ fn: 'groupCount', arg: c('c_amount'), by: ['c_supplier'] }))).toBe('Result ← the number of rows with a value in Amount per Supplier');
  });

  it('previous, next, fill down, row number', () => {
    expect(en(w({ fn: 'previous', arg: c('c_cost') }))).toBe('Result ← Cost from the previous row, in file order');
    expect(en(w({ fn: 'next', arg: c('c_cost'), by: ['c_supplier'], order: [{ column: 'c_date', dir: 'asc' }] }))).toBe('Result ← Cost from the next row per Supplier, in order of Date');
    expect(en(w({ fn: 'fillDown', arg: c('c_name') }))).toBe('Result ← the last Name that is not empty, carried down, in file order');
    expect(en(w({ fn: 'rowNumber' }))).toBe('Result ← row number, in file order');
    expect(en(w({ fn: 'rowNumber', by: ['c_order'] }))).toBe('Result ← row number per Order number, in file order');
  });

  it('rank: by what, per what, and what equal values get', () => {
    expect(en(w({ fn: 'rank', order: [{ column: 'c_amount', dir: 'desc' }] }))).toBe('Result ← rank by Amount (descending), equal values share a rank');
    expect(en(w({ fn: 'rank', order: [{ column: 'c_amount', dir: 'desc' }], ties: 'dense', by: ['c_group'] }))).toBe(
      'Result ← rank by Amount (descending) per Group, equal values share a rank, with no gaps',
    );
  });

  it('every one of the eleven functions has a sentence that does not leak ids', () => {
    const sample: Record<WindowFn, object> = {
      runningSum: { arg: c('c_amount') },
      groupSum: { arg: c('c_amount') },
      groupAvg: { arg: c('c_amount') },
      groupMin: { arg: c('c_amount') },
      groupMax: { arg: c('c_amount') },
      groupCount: {},
      previous: { arg: c('c_amount') },
      next: { arg: c('c_amount') },
      fillDown: { arg: c('c_name') },
      rowNumber: {},
      rank: { order: [{ column: 'c_amount', dir: 'asc' }] },
    };
    for (const fn of WINDOW_FNS) {
      const text = en(w({ fn, ...sample[fn] }));
      expect(text, fn).toMatch(/^Result ← /);
      expect(text, fn).not.toMatch(/c_|p_|window|\(/);
      expect(text.length, fn).toBeGreaterThan('Result ← '.length + 5);
    }
  });

  it('in the middle of a calculation: a plain formula with names, never an id', () => {
    const share = en({ op: 'round', digits: 1, arg: { op: 'mul', args: [{ op: 'div', args: [c('c_amount'), w({ fn: 'groupSum', arg: c('c_amount'), by: ['c_group'] })] }, { const: 100 }] } });
    expect(share).toContain('groupSum(Amount, by: Group)');
    expect(share).not.toMatch(/c_/);
  });
});

describe('window columns, in Hebrew', () => {
  const he = (e: Expr): string => sentence(e, 'he', 'תוצאה');

  it('running total', () => {
    expect(he(w({ fn: 'runningSum', arg: c('c_amount'), by: ['c_supplier'] }))).toBe('תוצאה ← סכום מצטבר של סכום לכל ספק, לפי סדר הקובץ');
    expect(he(w({ fn: 'runningSum', arg: c('c_amount'), order: [{ column: 'c_date', dir: 'desc' }, { column: 'c_order', dir: 'asc' }] }))).toBe(
      'תוצאה ← סכום מצטבר של סכום, לפי סדר תאריך (בסדר יורד), ואז מספר הזמנה',
    );
  });

  it('group functions', () => {
    expect(he(w({ fn: 'groupSum', arg: c('c_amount'), by: ['c_group'] }))).toBe('תוצאה ← הסכום של סכום לכל קבוצה');
    expect(he(w({ fn: 'groupAvg', arg: c('c_amount') }))).toBe('תוצאה ← הממוצע של סכום בכל השורות');
    expect(he(w({ fn: 'groupMin', arg: c('c_date'), by: ['c_group'] }))).toBe('תוצאה ← הערך הנמוך ביותר של תאריך לכל קבוצה');
    expect(he(w({ fn: 'groupMax', arg: c('c_date') }))).toBe('תוצאה ← הערך הגבוה ביותר של תאריך בכל השורות');
    expect(he(w({ fn: 'groupCount', by: ['c_supplier'] }))).toBe('תוצאה ← מספר השורות לכל ספק');
    expect(he(w({ fn: 'groupCount', arg: c('c_amount'), by: ['c_supplier'] }))).toBe('תוצאה ← מספר השורות שיש בהן ערך ב-סכום לכל ספק');
  });

  it('previous, next, fill down, row number, rank', () => {
    expect(he(w({ fn: 'previous', arg: c('c_cost') }))).toBe('תוצאה ← עלות מהשורה הקודמת, לפי סדר הקובץ');
    expect(he(w({ fn: 'next', arg: c('c_cost'), by: ['c_supplier'] }))).toBe('תוצאה ← עלות מהשורה הבאה לכל ספק, לפי סדר הקובץ');
    expect(he(w({ fn: 'fillDown', arg: c('c_name') }))).toBe('תוצאה ← הערך האחרון של שם שאינו ריק, מועבר כלפי מטה, לפי סדר הקובץ');
    expect(he(w({ fn: 'rowNumber', by: ['c_order'] }))).toBe('תוצאה ← מספר השורה לכל מספר הזמנה, לפי סדר הקובץ');
    expect(he(w({ fn: 'rank', order: [{ column: 'c_amount', dir: 'desc' }], ties: 'dense' }))).toBe('תוצאה ← דירוג לפי סכום (בסדר יורד), ערכים שווים חולקים דירוג, בלי דילוגים');
    expect(he(w({ fn: 'rank', order: [{ column: 'c_amount', dir: 'asc' }] }))).toBe('תוצאה ← דירוג לפי סכום, ערכים שווים חולקים דירוג');
  });
});
