// Formatting: the same information, written differently.
import { pick, randInt } from '../../cases/lib/prng';
import { EN_FIRST, EN_LAST, MONTHS_HE, fmtNumber, pad2, randDate, randDigits, randMoney, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType, type Ymd } from '../types';

const MONEY = '#,##0.00';

function iso(d: Ymd): string {
  return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
}

const numberThousands = defineType({
  id: 'formatting.number-thousands',
  topic: 'formatting',
  title: 'Number as text with thousands separators',
  description: 'An amount is written as text with a thousands separator and two decimals (1234567.5 -> "1,234,567.50").',
  lang: 'en',
  input: [
    { id: 'inv', header: 'Invoice', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('INV-', 1000 + i, 5), amount: randMoney(g.rng, 100, 2500000) })),
  outputs: [
    { header: 'Invoice', from: 'inv' },
    { header: 'Amount', formula: 'toText(amount, "#,##0.00")', value: (r) => fmtNumber(r.amount as number, 2) },
  ],
  rule: {},
});

const currencyPrefix = defineType({
  id: 'formatting.currency-text',
  topic: 'formatting',
  title: 'Currency symbol in front of the amount',
  description: 'An amount becomes text with the shekel sign in front ("₪1,234.50").',
  lang: 'he',
  input: [
    { id: 'inv', header: 'חשבונית', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('H-', 100 + i, 4), amount: randMoney(g.rng, 20, 90000) })),
  outputs: [
    { header: 'חשבונית', from: 'inv' },
    { header: 'סכום', formula: 'concat("₪", toText(amount, "#,##0.00"))', value: (r) => `₪${fmtNumber(r.amount as number, 2)}` },
  ],
  rule: {},
});

const percentText = defineType({
  id: 'formatting.percent-text',
  topic: 'formatting',
  title: 'Ratio as a percentage text',
  description: 'A ratio such as 0.153 is written as the text "15.3%".',
  lang: 'en',
  input: [
    { id: 'region', header: 'Region', type: 'text' },
    { id: 'share', header: 'Share', type: 'decimal', format: '0.0%' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ region: `${pick(g.rng, ['North', 'South', 'East', 'West'])}-${i + 1}`, share: randInt(g.rng, 5, 600) / 1000 })),
  outputs: [
    { header: 'Region', from: 'region' },
    { header: 'Share', formula: 'toText(share, "0.0%")', value: (r) => `${fmtNumber((r.share as number) * 100, 1, false)}%` },
  ],
  rule: {},
});

const dateIso = defineType({
  id: 'formatting.date-iso',
  topic: 'formatting',
  title: 'Date as ISO text',
  description: 'A real date cell is written as the text 2026-09-05 (YYYY-MM-DD).',
  lang: 'en',
  input: [
    { id: 'order', header: 'Order', type: 'text' },
    { id: 'd', header: 'Order date', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ order: seqId('SO-', 500 + i, 4), d: randDate(g.rng, 2025, 2026) })),
  outputs: [
    { header: 'Order', from: 'order' },
    { header: 'Order date', formula: 'dateFormat(d, "YYYY-MM-DD")', value: (r) => iso(r.d as Ymd) },
  ],
  rule: {},
});

const dateTextReformat = defineType({
  id: 'formatting.date-text-reformat',
  topic: 'formatting',
  title: 'Text date, month-first to day-first',
  description: 'A date typed as text in US order (MM/DD/YYYY) is rewritten as DD.MM.YYYY.',
  lang: 'en',
  input: [
    { id: 'ship', header: 'Shipment', type: 'text' },
    { id: 'd', header: 'Ship date', type: 'date', dateAs: 'MM/DD/YYYY' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ ship: seqId('SH-', 70 + i, 4), d: randDate(g.rng, 2025, 2026) })),
  outputs: [
    { header: 'Shipment', from: 'ship' },
    { header: 'Ship date', formula: 'dateFormat(d, "DD.MM.YYYY")', value: (r) => `${pad2((r.d as Ymd).d)}.${pad2((r.d as Ymd).m)}.${(r.d as Ymd).y}` },
  ],
  rule: {},
});

const dateHebrewMonth = defineType({
  id: 'formatting.date-hebrew-month',
  topic: 'formatting',
  title: 'Date with a Hebrew month name',
  description: 'A date is written with the month name in Hebrew ("5 ספטמבר 2026").',
  lang: 'he',
  input: [
    { id: 'doc', header: 'מסמך', type: 'text' },
    { id: 'd', header: 'תאריך', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ doc: seqId('D-', 300 + i, 4), d: randDate(g.rng, 2025, 2026) })),
  outputs: [
    { header: 'מסמך', from: 'doc' },
    { header: 'תאריך', formula: 'dateFormat(d, "D MMMM YYYY")', value: (r) => `${(r.d as Ymd).d} ${MONTHS_HE[(r.d as Ymd).m - 1]} ${(r.d as Ymd).y}` },
  ],
  rule: {},
});

const phoneDashes = defineType({
  id: 'formatting.phone-dashes',
  topic: 'formatting',
  title: 'Phone number with dashes',
  description: 'A 10-digit mobile number gets dashes: 0541234567 -> 054-123-4567.',
  lang: 'he',
  input: [
    { id: 'name', header: 'שם', type: 'text' },
    { id: 'phone', header: 'טלפון', type: 'text' },
  ],
  generate: (g) => rowsOf(g, () => ({ name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר'])} ${pick(g.rng, ['כהן', 'לוי', 'מזרחי', 'פרץ'])}`, phone: `05${randInt(g.rng, 0, 8)}${randDigits(g.rng, 7)}` })),
  outputs: [
    { header: 'שם', from: 'name' },
    { header: 'טלפון', formula: 'concat(substr(phone, 1, 3), "-", substr(phone, 4, 3), "-", substr(phone, 7, 4))', value: (r) => `${String(r.phone).slice(0, 3)}-${String(r.phone).slice(3, 6)}-${String(r.phone).slice(6)}` },
  ],
  rule: {},
});

const paddedNumber = defineType({
  id: 'formatting.padded-number',
  topic: 'formatting',
  title: 'Number padded to a fixed width',
  description: 'A running number is written with leading zeros to 6 characters (42 -> "000042").',
  lang: 'en',
  input: [
    { id: 'no', header: 'Item no', type: 'integer' },
    { id: 'name', header: 'Description', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ no: 40 + i * 37 + randInt(g.rng, 0, 30), name: `${pick(g.rng, EN_FIRST)} ${pick(g.rng, EN_LAST)}` })),
  outputs: [
    { header: 'Item no', formula: 'padLeft(toText(no), 6, "0")', value: (r) => String(r.no).padStart(6, '0') },
    { header: 'Description', from: 'name' },
  ],
  rule: {},
});

const restoreZeros = defineType({
  id: 'formatting.restore-leading-zeros',
  topic: 'formatting',
  title: 'Restore lost leading zeros of an ID',
  description: 'Nine-digit ID numbers were stored as numbers, so the leading zero is gone; the output has the full 9 characters.',
  lang: 'he',
  input: [
    { id: 'name', header: 'שם', type: 'text' },
    { id: 'tz', header: 'ת.ז.', type: 'idLike', padLeft: 9 },
  ],
  generate: (g) => rowsOf(g, () => ({ name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר', 'שירה'])} ${pick(g.rng, ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון'])}`, tz: randInt(g.rng, 1000000, 99999999) })),
  outputs: [
    { header: 'שם', from: 'name' },
    { header: 'ת.ז.', from: 'tz', value: (r) => String(r.tz).padStart(9, '0') },
  ],
  rule: {},
});

function parseTextNumber(s: string): number {
  const neg = s.startsWith('(') && s.endsWith(')');
  const n = Number(s.replace(/[()₪,\s]/g, ''));
  return neg ? -n : n;
}

const textNumberToNumber = defineType({
  id: 'formatting.text-number-to-number',
  topic: 'formatting',
  title: 'Numbers stored as text become numbers',
  description: 'Amounts exported as text ("1,234.50", "₪99", "(250.00)" for a negative) become real numbers.',
  lang: 'en',
  input: [
    { id: 'ref', header: 'Reference', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const v = randMoney(g.rng, 5, 9000);
      const style = i % 4;
      return { ref: seqId('R-', 20 + i, 4), amount: style === 0 ? fmtNumber(v, 2) : style === 1 ? `₪${fmtNumber(v, 2)}` : style === 2 ? `(${fmtNumber(v, 2)})` : String(v) };
    }),
  outputs: [
    { header: 'Reference', from: 'ref' },
    { header: 'Amount', from: 'amount', format: MONEY, value: (r) => parseTextNumber(String(r.amount)) },
  ],
  rule: {},
});

const dateTextToDate = defineType({
  id: 'formatting.date-text-to-date',
  topic: 'formatting',
  title: 'Text date becomes a real date',
  description: 'Dates exported as text (DD/MM/YYYY) become real Excel dates.',
  lang: 'he',
  input: [
    { id: 'doc', header: 'מסמך', type: 'text' },
    { id: 'd', header: 'תאריך', type: 'date', dateAs: 'DD/MM/YYYY' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ doc: seqId('D-', 400 + i, 4), d: randDate(g.rng, 2025, 2026) })),
  outputs: [
    { header: 'מסמך', from: 'doc' },
    { header: 'תאריך', from: 'd', format: 'DD/MM/YYYY' },
  ],
  rule: {},
});

export const FORMATTING: CatalogueType[] = [numberThousands, currencyPrefix, percentText, dateIso, dateTextReformat, dateHebrewMonth, phoneDashes, paddedNumber, restoreZeros, textNumberToNumber, dateTextToDate];
