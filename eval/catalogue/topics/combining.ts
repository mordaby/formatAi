// Combining: building one text from several columns.
import { pick, randInt } from '../../cases/lib/prng';
import { EN_FIRST, EN_LAST, HE_CITIES, HE_FIRST, HE_LAST, HE_DEPARTMENTS, pickCompany, randMoney, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType } from '../types';

const MONEY = '#,##0.00';

const joinSpace = defineType({
  id: 'combining.join-space',
  topic: 'combining',
  title: 'Join two columns with a space',
  description: 'First name and last name are joined into a full name.',
  lang: 'he',
  input: [
    { id: 'eid', header: 'מספר עובד', type: 'text' },
    { id: 'first', header: 'שם פרטי', type: 'text' },
    { id: 'last', header: 'שם משפחה', type: 'text' },
    { id: 'dept', header: 'מחלקה', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ eid: seqId('E', 100 + i, 4), first: pick(g.rng, HE_FIRST), last: pick(g.rng, HE_LAST), dept: pick(g.rng, HE_DEPARTMENTS) })),
  outputs: [
    { header: 'מספר עובד', from: 'eid' },
    { header: 'שם מלא', formula: 'concat(first, " ", last)', value: (r) => `${String(r.first)} ${String(r.last)}` },
    { header: 'מחלקה', from: 'dept' },
  ],
  rule: {},
});

const joinDash = defineType({
  id: 'combining.join-dash',
  topic: 'combining',
  title: 'Join two columns with a dash',
  description: 'A product code and a size are joined into a variant code ("TS100-XL").',
  lang: 'en',
  input: [
    { id: 'code', header: 'Product code', type: 'text' },
    { id: 'size', header: 'Size', type: 'text' },
    { id: 'stock', header: 'Stock', type: 'integer' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ code: `${pick(g.rng, ['TS', 'PL', 'JK', 'SH'])}${100 + Math.floor(i / 3)}`, size: ['S', 'M', 'L'][i % 3] ?? 'M', stock: randInt(g.rng, 0, 120) })),
  outputs: [
    { header: 'Variant', formula: 'concat(code, "-", size)', value: (r) => `${String(r.code)}-${String(r.size)}` },
    { header: 'Stock', from: 'stock' },
  ],
  rule: {},
});

const templateShort = defineType({
  id: 'combining.template-short-prefix',
  topic: 'combining',
  title: 'A short fixed prefix before a number',
  description: 'An order reference is built as "INV-1042" from a plain number.',
  lang: 'en',
  input: [
    { id: 'no', header: 'Number', type: 'integer' },
    { id: 'customer', header: 'Customer', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ no: 1000 + i * 3 + randInt(g.rng, 0, 2), customer: pickCompany(g.rng, 'en'), amount: randMoney(g.rng, 50, 9000) })),
  outputs: [
    { header: 'Reference', formula: 'concat("INV-", toText(no))', value: (r) => `INV-${String(r.no)}` },
    { header: 'Customer', from: 'customer' },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: {},
});

const templateFixed = defineType({
  id: 'combining.template-fixed-text',
  topic: 'combining',
  title: 'A label with longer fixed text and two columns',
  description: 'A description line is built as "Invoice #1042 - Acme Supply" from a number and a customer name.',
  lang: 'en',
  input: [
    { id: 'no', header: 'Number', type: 'integer' },
    { id: 'customer', header: 'Customer', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ no: 1000 + i * 3 + randInt(g.rng, 0, 2), customer: pickCompany(g.rng, 'en'), amount: randMoney(g.rng, 50, 9000) })),
  outputs: [
    { header: 'Description', formula: 'concat("Invoice #", toText(no), " - ", customer)', value: (r) => `Invoice #${String(r.no)} - ${String(r.customer)}` },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: {},
});

const join3 = defineType({
  id: 'combining.join-three-columns',
  topic: 'combining',
  title: 'Three columns into an address line',
  description: 'Street, house number and city become one address line ("הרצל 12, חיפה").',
  lang: 'he',
  input: [
    { id: 'cid', header: 'מספר לקוח', type: 'text' },
    { id: 'street', header: 'רחוב', type: 'text' },
    { id: 'num', header: 'מספר', type: 'integer' },
    { id: 'city', header: 'עיר', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      cid: seqId('C-', 100 + i, 4),
      street: pick(g.rng, ['הרצל', 'ויצמן', 'רוטשילד', 'אלנבי', 'הגפן', 'הזית']),
      num: randInt(g.rng, 1, 150),
      city: pick(g.rng, HE_CITIES),
    })),
  outputs: [
    { header: 'מספר לקוח', from: 'cid' },
    { header: 'כתובת', formula: 'concat(street, " ", toText(num), ", ", city)', value: (r) => `${String(r.street)} ${String(r.num)}, ${String(r.city)}` },
  ],
  rule: {},
});

const optionalMiddle = defineType({
  id: 'combining.join-optional-middle',
  topic: 'combining',
  title: 'Join three columns where the middle one is often empty',
  description: 'First, middle and last name are joined with single spaces; many rows have no middle name.',
  lang: 'en',
  input: [
    { id: 'cid', header: 'ID', type: 'text' },
    { id: 'first', header: 'First', type: 'text' },
    { id: 'middle', header: 'Middle', type: 'text' },
    { id: 'last', header: 'Last', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({ cid: seqId('P', 100 + i, 3), first: pick(g.rng, EN_FIRST), middle: randInt(g.rng, 0, 2) === 0 ? pick(g.rng, ['Lee', 'Ann', 'James', 'Rose']) : null, last: pick(g.rng, EN_LAST) })),
  outputs: [
    { header: 'ID', from: 'cid' },
    { header: 'Full name', formula: 'trim(concat(first, " ", middle, " ", last))', value: (r) => [r.first, r.middle, r.last].filter((x) => x !== null).join(' ') },
  ],
  rule: {},
});

export const COMBINING: CatalogueType[] = [joinSpace, joinDash, templateShort, templateFixed, join3, optionalMiddle];
