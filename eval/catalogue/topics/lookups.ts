// Lookups: a value found in a table of reference data.
import { pick } from '../../cases/lib/prng';
import { randMoney, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType } from '../types';

const MONEY = '#,##0.00';

const REGION_OF_CITY: Record<string, string> = {
  'תל אביב': 'מרכז',
  'פתח תקווה': 'מרכז',
  רחובות: 'מרכז',
  חיפה: 'צפון',
  נהריה: 'צפון',
  טבריה: 'צפון',
  'באר שבע': 'דרום',
  אשדוד: 'דרום',
};

const valueMap = defineType({
  id: 'lookups.value-map',
  topic: 'lookups',
  title: 'Value map (city to region)',
  description: 'Each city is replaced by its sales region through a fixed list of pairs.',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'city', header: 'עיר', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('O-', 100 + i, 4), city: pick(g.rng, Object.keys(REGION_OF_CITY)), amount: randMoney(g.rng, 50, 8000) })),
  outputs: [
    { header: 'הזמנה', from: 'oid' },
    { header: 'אזור', from: 'city', value: (r) => REGION_OF_CITY[String(r.city)] ?? null },
    { header: 'סכום', from: 'amount', format: MONEY },
  ],
  rule: { transform: { valueMaps: [{ column: 'city', map: REGION_OF_CITY, onMissing: 'flag' }] } },
});

const PRODUCTS: [string, string, number][] = [
  ['P100', 'Tools', 0.17],
  ['P200', 'Garden', 0.17],
  ['P300', 'Books', 0],
  ['P400', 'Food', 0],
  ['P500', 'Electronics', 0.17],
  ['P600', 'Toys', 0.17],
];

const codeTable = defineType({
  id: 'lookups.code-table-two-attributes',
  topic: 'lookups',
  title: 'Code table with two attributes',
  description: 'A product code is looked up in a small reference table that gives both its category and its VAT rate.',
  lang: 'en',
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'code', header: 'Product code', type: 'text' },
    { id: 'net', header: 'Net', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), code: pick(g.rng, PRODUCTS)[0], net: randMoney(g.rng, 10, 900) })),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Category', formula: 'lookup("products", code, "category")', value: (r) => PRODUCTS.find((p) => p[0] === r.code)?.[1] ?? null },
    { header: 'VAT rate', formula: 'lookup("products", code, "rate")', type: 'decimal', value: (r) => PRODUCTS.find((p) => p[0] === r.code)?.[2] ?? null },
    { header: 'Net', from: 'net', format: MONEY },
  ],
  rule: { transform: { tables: [{ name: 'products', columns: ['code', 'category', 'rate'], rows: PRODUCTS.map((p) => [...p]) }] } },
});

const RATES: Record<string, number> = { 'IL|A': 0.1, 'IL|B': 0.05, 'US|A': 0.12, 'US|B': 0.07, 'DE|A': 0.15, 'DE|B': 0.09 };

const compositeKey = defineType({
  id: 'lookups.composite-key',
  topic: 'lookups',
  title: 'Lookup by two columns',
  description: 'A commission rate depends on the country and the customer tier together (a table keyed by both).',
  lang: 'he',
  input: [
    { id: 'deal', header: 'עסקה', type: 'text' },
    { id: 'country', header: 'מדינה', type: 'text' },
    { id: 'tier', header: 'דרגה', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ deal: seqId('D-', 100 + i, 4), country: pick(g.rng, ['IL', 'US', 'DE']), tier: pick(g.rng, ['A', 'B']) })),
  outputs: [
    { header: 'עסקה', from: 'deal' },
    { header: 'עמלה', formula: 'lookup("rates", concat(country, "|", tier), "rate")', type: 'decimal', value: (r) => RATES[`${String(r.country)}|${String(r.tier)}`] ?? null },
  ],
  rule: { transform: { tables: [{ name: 'rates', columns: ['key', 'rate'], rows: Object.entries(RATES).map(([k, v]) => [k, v]) }] } },
});

export const LOOKUPS: CatalogueType[] = [valueMap, codeTable, compositeKey];
