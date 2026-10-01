// Arithmetic: numbers computed from numbers.
import { pick, randInt } from '../../cases/lib/prng';
import { cents, randMoney, roundTo, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType } from '../types';

const MONEY = '#,##0.00';
const num = (v: unknown): number => v as number;

const percentOf = defineType({
  id: 'arithmetic.percent-of',
  topic: 'arithmetic',
  title: 'Percentage of a target',
  description: 'Achievement is the actual figure as a percentage of the target, with one decimal (87.3).',
  lang: 'he',
  input: [
    { id: 'dept', header: 'מחלקה', type: 'text' },
    { id: 'target', header: 'יעד', type: 'integer', format: '#,##0' },
    { id: 'actual', header: 'בפועל', type: 'integer', format: '#,##0' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const target = randInt(g.rng, 100, 900) * 100;
      return { dept: `${pick(g.rng, ['מכירות', 'רכש', 'כספים', 'שיווק'])} ${i + 1}`, target, actual: Math.round(target * (randInt(g.rng, 400, 1300) / 1000)) };
    }),
  outputs: [
    { header: 'מחלקה', from: 'dept' },
    { header: 'יעד', from: 'target', format: '#,##0' },
    { header: 'בפועל', from: 'actual', format: '#,##0' },
    { header: 'עמידה ביעד %', formula: 'round(actual / target * 100, 1)', type: 'decimal', format: '0.0', value: (r) => roundTo((num(r.actual) / num(r.target)) * 100, 1) },
  ],
  rule: {},
});

const vatAdd = defineType({
  id: 'arithmetic.vat-add',
  topic: 'arithmetic',
  title: 'Add VAT',
  description: 'The gross price is the net price plus 17% VAT, rounded to 2 decimals.',
  lang: 'en',
  input: [
    { id: 'inv', header: 'Invoice', type: 'text' },
    { id: 'net', header: 'Net', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('INV-', 200 + i, 4), net: randMoney(g.rng, 10, 5000) })),
  outputs: [
    { header: 'Invoice', from: 'inv' },
    { header: 'Net', from: 'net', format: MONEY },
    { header: 'Gross', formula: 'round(net * 1.17, 2)', type: 'decimal', format: MONEY, value: (r) => roundTo((Math.round(num(r.net) * 100) * 117) / 100, 0) / 100 },
  ],
  rule: {},
});

const vatRemove = defineType({
  id: 'arithmetic.vat-remove',
  topic: 'arithmetic',
  title: 'Remove VAT',
  description: 'The net price is the gross price divided by 1.17, rounded to 2 decimals.',
  lang: 'he',
  input: [
    { id: 'inv', header: 'חשבונית', type: 'text' },
    { id: 'gross', header: 'ברוטו', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('H-', 200 + i, 4), gross: randMoney(g.rng, 10, 6000) })),
  outputs: [
    { header: 'חשבונית', from: 'inv' },
    { header: 'ברוטו', from: 'gross', format: MONEY },
    { header: 'נטו', formula: 'round(gross / 1.17, 2)', type: 'decimal', format: MONEY, value: (r) => roundTo(num(r.gross) / 1.17, 2) },
  ],
  rule: {},
});

const roundNearest = defineType({
  id: 'arithmetic.round-to-nearest',
  topic: 'arithmetic',
  title: 'Round to the nearest 5',
  description: 'Prices are rounded to the nearest 5 (12.4 -> 10, 12.5 -> 15).',
  lang: 'en',
  input: [
    { id: 'sku', header: 'SKU', type: 'text' },
    { id: 'price', header: 'Price', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ sku: seqId('SK', 100 + i, 4), price: randMoney(g.rng, 3, 400) })),
  outputs: [
    { header: 'SKU', from: 'sku' },
    { header: 'Price', from: 'price', format: MONEY },
    { header: 'Rounded', formula: 'round(price / 5, 0) * 5', type: 'decimal', format: '0', value: (r) => roundTo(num(r.price) / 5, 0) * 5 },
  ],
  rule: {},
});

const difference = defineType({
  id: 'arithmetic.difference',
  topic: 'arithmetic',
  title: 'Difference of two columns',
  description: 'The variance is the budget minus the actual spend.',
  lang: 'he',
  input: [
    { id: 'item', header: 'סעיף', type: 'text' },
    { id: 'budget', header: 'תקציב', type: 'decimal', format: MONEY },
    { id: 'actual', header: 'ביצוע', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ item: `${pick(g.rng, ['שכר', 'שיווק', 'ציוד', 'נסיעות', 'תוכנה'])} ${i + 1}`, budget: randMoney(g.rng, 1000, 90000), actual: randMoney(g.rng, 800, 95000) })),
  outputs: [
    { header: 'סעיף', from: 'item' },
    { header: 'תקציב', from: 'budget', format: MONEY },
    { header: 'ביצוע', from: 'actual', format: MONEY },
    { header: 'סטייה', formula: 'budget - actual', type: 'decimal', format: MONEY, value: (r) => cents(Math.round(num(r.budget) * 100) - Math.round(num(r.actual) * 100)) },
  ],
  rule: {},
});

const ratio = defineType({
  id: 'arithmetic.ratio',
  topic: 'arithmetic',
  title: 'Ratio of two columns',
  description: 'The unit price is the revenue divided by the units sold, rounded to 2 decimals.',
  lang: 'en',
  input: [
    { id: 'product', header: 'Product', type: 'text' },
    { id: 'revenue', header: 'Revenue', type: 'decimal', format: MONEY },
    { id: 'units', header: 'Units', type: 'integer' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ product: `${pick(g.rng, ['Hammer', 'Drill', 'Saw', 'Ruler', 'Pliers'])}-${i + 1}`, revenue: randMoney(g.rng, 100, 50000), units: randInt(g.rng, 1, 400) })),
  outputs: [
    { header: 'Product', from: 'product' },
    { header: 'Revenue', from: 'revenue', format: MONEY },
    { header: 'Units', from: 'units' },
    { header: 'Unit price', formula: 'round(revenue / units, 2)', type: 'decimal', format: MONEY, value: (r) => roundTo(num(r.revenue) / num(r.units), 2) },
  ],
  rule: {},
});

const sumSeveral = defineType({
  id: 'arithmetic.sum-of-columns',
  topic: 'arithmetic',
  title: 'Sum of several columns',
  description: 'The yearly total is the sum of four quarterly columns.',
  lang: 'he',
  input: [
    { id: 'branch', header: 'סניף', type: 'text' },
    { id: 'q1', header: 'רבעון 1', type: 'integer', format: '#,##0' },
    { id: 'q2', header: 'רבעון 2', type: 'integer', format: '#,##0' },
    { id: 'q3', header: 'רבעון 3', type: 'integer', format: '#,##0' },
    { id: 'q4', header: 'רבעון 4', type: 'integer', format: '#,##0' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ branch: `${pick(g.rng, ['חיפה', 'תל אביב', 'באר שבע', 'אילת', 'נתניה'])} ${i + 1}`, q1: randInt(g.rng, 100, 9000), q2: randInt(g.rng, 100, 9000), q3: randInt(g.rng, 100, 9000), q4: randInt(g.rng, 100, 9000) })),
  outputs: [
    { header: 'סניף', from: 'branch' },
    { header: 'רבעון 1', from: 'q1', format: '#,##0' },
    { header: 'רבעון 2', from: 'q2', format: '#,##0' },
    { header: 'רבעון 3', from: 'q3', format: '#,##0' },
    { header: 'רבעון 4', from: 'q4', format: '#,##0' },
    { header: 'סה"כ שנתי', formula: 'q1 + q2 + q3 + q4', type: 'integer', format: '#,##0', value: (r) => num(r.q1) + num(r.q2) + num(r.q3) + num(r.q4) },
  ],
  rule: {},
});

const priceTimesQty = defineType({
  id: 'arithmetic.price-times-quantity',
  topic: 'arithmetic',
  title: 'Price times quantity',
  description: 'A line total is the unit price times the quantity, rounded to 2 decimals.',
  lang: 'en',
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'price', header: 'Unit price', type: 'decimal', format: MONEY },
    { id: 'qty', header: 'Qty', type: 'integer' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), price: randMoney(g.rng, 1, 700), qty: randInt(g.rng, 1, 60) })),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Unit price', from: 'price', format: MONEY },
    { header: 'Qty', from: 'qty' },
    { header: 'Total', formula: 'round(price * qty, 2)', type: 'decimal', format: MONEY, value: (r) => cents(Math.round(num(r.price) * 100) * num(r.qty)) },
  ],
  rule: {},
});

const discountPercent = defineType({
  id: 'arithmetic.discount-percent',
  topic: 'arithmetic',
  title: 'Price after a percentage discount',
  description: 'The net price is the list price reduced by a discount percentage that differs by row (0-25).',
  lang: 'he',
  input: [
    { id: 'item', header: 'פריט', type: 'text' },
    { id: 'price', header: 'מחיר', type: 'decimal', format: MONEY },
    { id: 'disc', header: 'הנחה %', type: 'integer' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ item: seqId('P-', 300 + i, 4), price: randMoney(g.rng, 20, 2000), disc: pick(g.rng, [0, 5, 10, 15, 20, 25]) })),
  outputs: [
    { header: 'פריט', from: 'item' },
    { header: 'מחיר', from: 'price', format: MONEY },
    { header: 'הנחה %', from: 'disc' },
    { header: 'מחיר נטו', formula: 'round(price * (1 - disc / 100), 2)', type: 'decimal', format: MONEY, value: (r) => roundTo((Math.round(num(r.price) * 100) * (100 - num(r.disc))) / 10000, 2) },
  ],
  rule: {},
});

export const ARITHMETIC: CatalogueType[] = [percentOf, vatAdd, vatRemove, roundNearest, difference, ratio, sumSeveral, priceTimesQty, discountPercent];
