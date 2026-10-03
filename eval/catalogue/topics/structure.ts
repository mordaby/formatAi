// Structure: the shape of the file around the cells (columns kept, renamed, added; title rows).
import { pick, randInt } from '../../cases/lib/prng';
import { EN_FIRST, EN_LAST, MONTHS_HE, pickCity, randDigits, randMoney, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType, type Ymd } from '../types';

const MONEY = '#,##0.00';

const renameReorderDrop = defineType({
  id: 'structure.rename-reorder-drop',
  topic: 'structure',
  title: 'Rename, reorder and drop columns',
  description: 'A CRM export is reshaped for an import: headers renamed, last name before first name, phone and city dropped.',
  lang: 'en',
  input: [
    { id: 'cid', header: 'Customer ID', type: 'text' },
    { id: 'first', header: 'First Name', type: 'text' },
    { id: 'last', header: 'Last Name', type: 'text' },
    { id: 'email', header: 'Email', type: 'text' },
    { id: 'phone', header: 'Phone', type: 'text' },
    { id: 'city', header: 'City', type: 'text' },
    { id: 'status', header: 'Status', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const first = pick(g.rng, EN_FIRST);
      const last = pick(g.rng, EN_LAST);
      return { cid: seqId('C-', 100 + i, 4), first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`, phone: `555-${randDigits(g.rng, 4)}`, city: pickCity(g.rng, 'en'), status: pick(g.rng, ['Active', 'Inactive', 'Lead']) };
    }),
  outputs: [
    { header: 'Contact ID', from: 'cid' },
    { header: 'Surname', from: 'last' },
    { header: 'Given name', from: 'first' },
    { header: 'Email Address', from: 'email' },
    { header: 'Account Status', from: 'status' },
  ],
  rule: {},
});

const constantColumn = defineType({
  id: 'structure.constant-column',
  topic: 'structure',
  title: 'A column with the same fixed value on every row',
  description: 'A currency column with the constant "ILS" is added for the import file.',
  lang: 'he',
  input: [
    { id: 'inv', header: 'חשבונית', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('H-', 100 + i, 4), amount: randMoney(g.rng, 20, 9000) })),
  outputs: [
    { header: 'חשבונית', from: 'inv' },
    { header: 'סכום', from: 'amount', format: MONEY },
    { header: 'מטבע', formula: '"ILS"', value: () => 'ILS' },
  ],
  rule: {},
});

const constantTitle = defineType({
  id: 'structure.constant-title-row',
  topic: 'structure',
  title: 'A fixed title above the header',
  description: 'The report starts with a bold title line and a blank row before the header.',
  lang: 'en',
  input: [
    { id: 'sku', header: 'SKU', type: 'text' },
    { id: 'name', header: 'Product', type: 'text' },
    { id: 'qty', header: 'On hand', type: 'integer' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ sku: seqId('SK', 100 + i, 4), name: `${pick(g.rng, ['Hammer', 'Drill', 'Saw', 'Ruler'])}-${i}`, qty: randInt(g.rng, 0, 400) })),
  titles: () => ['Monthly stock report', null],
  outputs: [
    { header: 'SKU', from: 'sku' },
    { header: 'Product', from: 'name' },
    { header: 'On hand', from: 'qty' },
  ],
  rule: { output: { titleRows: [{ text: 'Monthly stock report', bold: true }, { blank: true }] } },
});

const titleWithMonth = defineType({
  id: 'structure.title-with-month',
  topic: 'structure',
  title: 'A title that carries the month of the data',
  description: 'The title line says "דוח הזמנות - ספטמבר 2026", the month taken from the latest order date, so next month\'s file gets next month\'s title.',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'date', header: 'תאריך', type: 'date' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => {
    const y = randInt(g.rng, 2025, 2026);
    const m = randInt(g.rng, 1, 12);
    return rowsOf(g, (i) => ({ oid: seqId('O-', 100 + i, 4), date: { y, m, d: randInt(g.rng, 1, 28) }, amount: randMoney(g.rng, 50, 4000) }));
  },
  titles: (rows) => {
    const latest = rows.map((r) => r.date as Ymd).reduce((a, b) => (b.d > a.d ? b : a));
    return [`דוח הזמנות - ${MONTHS_HE[latest.m - 1]} ${latest.y}`, null];
  },
  outputs: [
    { header: 'הזמנה', from: 'oid' },
    { header: 'תאריך', from: 'date', format: 'DD/MM/YYYY' },
    { header: 'סכום', from: 'amount', format: MONEY },
  ],
  rule: { output: { titleRows: [{ parts: [{ text: 'דוח הזמנות - ' }, { agg: 'max', column: 'date', format: 'MMMM YYYY' }], bold: true }, { blank: true }] } },
});

export const STRUCTURE: CatalogueType[] = [renameReorderDrop, constantColumn, constantTitle, titleWithMonth];
