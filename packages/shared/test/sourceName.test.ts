// SPEC 8.15 "Saving", 21 v11 item 9: a new source is named after the example input file, with what changes between files taken out.
import { describe, expect, it } from 'vitest';
import { limits } from '../src/config/limits';
import { defaultSourceName } from '../src/sourceName';

describe('defaultSourceName: the file name without its extension', () => {
  it('drops the extension and any folder', () => {
    expect(defaultSourceName('orders.xlsx')).toBe('orders');
    expect(defaultSourceName('Price list.CSV')).toBe('Price list');
    expect(defaultSourceName('C:\\Users\\dana\\Desktop\\Price list.xls')).toBe('Price list');
    expect(defaultSourceName('exports/q/Price list.txt')).toBe('Price list');
  });

  it('keeps a dot that is not an extension, and the separators inside the name', () => {
    expect(defaultSourceName('Acme Inc. prices.xlsx')).toBe('Acme Inc. prices');
    expect(defaultSourceName('acme-corp_prices.csv')).toBe('acme-corp_prices');
    expect(defaultSourceName('report.final.xlsx')).toBe('report.final');
  });

  it('is nothing for an extension only, an empty name, or a name that is only a number or a date', () => {
    expect(defaultSourceName('.xlsx')).toBe('');
    expect(defaultSourceName('')).toBe('');
    expect(defaultSourceName('2026-09.xlsx')).toBe('');
    expect(defaultSourceName('20260915.csv')).toBe('');
    expect(defaultSourceName('(1).xlsx')).toBe('');
    expect(defaultSourceName('_ - .xlsx')).toBe('');
  });
});

describe('defaultSourceName: dates and digit runs', () => {
  it('takes a date out in any of its usual formats, with the separators it leaves', () => {
    expect(defaultSourceName('orders 2026-09.xlsx')).toBe('orders');
    expect(defaultSourceName('orders 2026-09-15.xlsx')).toBe('orders');
    expect(defaultSourceName('orders_2026_09_15.xlsx')).toBe('orders');
    expect(defaultSourceName('orders 15.09.2026.xlsx')).toBe('orders');
    expect(defaultSourceName('orders 15-09-26.xlsx')).toBe('orders');
    expect(defaultSourceName('orders 09_2026.xlsx')).toBe('orders');
    expect(defaultSourceName('orders20260915.xlsx')).toBe('orders');
    expect(defaultSourceName('2026-09 orders.xlsx')).toBe('orders');
    expect(defaultSourceName('orders (2026-09).xlsx')).toBe('orders');
  });

  it('takes a month name out when it sits next to a number', () => {
    expect(defaultSourceName('Sales Sep 2026.xlsx')).toBe('Sales');
    expect(defaultSourceName('Sales September 2026.xlsx')).toBe('Sales');
    expect(defaultSourceName('sales 15 sept 2026.xlsx')).toBe('sales');
    expect(defaultSourceName('Sales 2026 DEC.xlsx')).toBe('Sales');
    expect(defaultSourceName('Sales Jan.2026.xlsx')).toBe('Sales');
  });

  it('keeps a word that only looks like a month when no number is next to it', () => {
    expect(defaultSourceName('March Madness.xlsx')).toBe('March Madness');
    expect(defaultSourceName('Marketing 2026.xlsx')).toBe('Marketing');
    expect(defaultSourceName('Maya may.xlsx')).toBe('Maya may');
    expect(defaultSourceName('2026 Market.xlsx')).toBe('Market');
  });

  it('takes counters out (a browser adds "(1)" to a second download, a version is "v2")', () => {
    expect(defaultSourceName('orders (1).xlsx')).toBe('orders');
    expect(defaultSourceName('orders (12) (3).xlsx')).toBe('orders');
    expect(defaultSourceName('orders [2].xlsx')).toBe('orders');
    expect(defaultSourceName('orders final 3.xlsx')).toBe('orders final');
    expect(defaultSourceName('Q3 sales.xlsx')).toBe('Q sales');
  });

  it('keeps what stood between two numbers as separate words', () => {
    expect(defaultSourceName('orders_2026_items_09.xlsx')).toBe('orders items');
    expect(defaultSourceName('orders 1 of 3.xlsx')).toBe('orders of');
  });

  it('gives the same name for every month of the same kind of file', () => {
    const names = ['orders 2026-09.xlsx', 'orders 2026-10.xlsx', 'orders_2026_11 (1).xlsx','orders Dec 2026.xlsx'];
    expect(new Set(names.map(defaultSourceName))).toEqual(new Set(['orders']));
  });
});

describe('defaultSourceName: Hebrew and other scripts', () => {
  it('works on Hebrew names like on Latin ones', () => {
    expect(defaultSourceName('ספקים 2026-09.xlsx')).toBe('ספקים');
    expect(defaultSourceName('מחירון ספקים.csv')).toBe('מחירון ספקים');
    expect(defaultSourceName('הזמנות_15.09.2026.xlsx')).toBe('הזמנות');
    expect(defaultSourceName('דוח (2).xlsx')).toBe('דוח');
  });

  it('takes a Hebrew month out next to a number, and keeps it alone', () => {
    expect(defaultSourceName('מכירות ספטמבר 2026.xlsx')).toBe('מכירות');
    expect(defaultSourceName('2026 אוקטובר מכירות.xlsx')).toBe('מכירות');
    expect(defaultSourceName('מרץ.xlsx')).toBe('מרץ');
  });

  it('works with a mixed Hebrew and English name, and with Arabic-Indic digits', () => {
    expect(defaultSourceName('Acme - ספקים 2026.xlsx')).toBe('Acme - ספקים');
    expect(defaultSourceName('ספקים ٢٠٢٦.xlsx')).toBe('ספקים');
  });

  it('is the same name whatever the composed form of the letters', () => {
    expect(defaultSourceName('Cafe\u0301 2026.xlsx')).toBe('Caf\u00e9');
  });
});

describe('defaultSourceName: only a name the server accepts', () => {
  it('drops control and invisible direction characters', () => {
    expect(defaultSourceName('or\u0007ders\u200f 2026.xlsx')).toBe('or ders');
  });

  it('is cut to leave room for " (n)", never in the middle of a character, and not on a separator', () => {
    const long = defaultSourceName(`${'ab '.repeat(60)}2026.xlsx`);
    expect(long.length).toBeLessThanOrEqual(limits.registry.maxNameChars - 8);
    expect(long.endsWith(' ')).toBe(false);
    const emoji = defaultSourceName(`${'😀'.repeat(80)}.xlsx`);
    expect(emoji.length).toBeLessThanOrEqual(limits.registry.maxNameChars - 8);
    expect(emoji).toBe('😀'.repeat(emoji.length / 2));
  });
});
