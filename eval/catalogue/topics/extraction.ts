// Text extraction: pulling a piece out of a text cell.
import { pick, randInt } from '../../cases/lib/prng';
import { EN_FIRST, EN_LAST, EN_PRODUCTS, HE_FIRST, HE_LAST, HE_PRODUCTS, HE_CITIES, randDigits, randMoney, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType } from '../types';

const MONEY = '#,##0.00';

const leftN = defineType({
  id: 'extraction.left-n',
  topic: 'extraction',
  title: 'First N characters',
  description: 'The first 3 characters of an item code become a category code.',
  lang: 'en',
  input: [
    { id: 'code', header: 'Item code', type: 'text' },
    { id: 'name', header: 'Product', type: 'text' },
    { id: 'price', header: 'Price', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      code: `${pick(g.rng, ['ELC', 'PLM', 'HDW', 'FRN', 'TXT'])}${1000 + i * 13 + randInt(g.rng, 0, 12)}`,
      name: pick(g.rng, EN_PRODUCTS),
      price: randMoney(g.rng, 5, 900),
    })),
  outputs: [
    { header: 'Item code', from: 'code' },
    { header: 'Category', formula: 'substr(code, 1, 3)', value: (r) => String(r.code).slice(0, 3) },
    { header: 'Product', from: 'name' },
  ],
  rule: {},
});

const rightN = defineType({
  id: 'extraction.right-n',
  topic: 'extraction',
  title: 'Last N characters',
  description: 'The last 4 digits of a 16-digit card number.',
  lang: 'he',
  input: [
    { id: 'customer', header: 'שם לקוח', type: 'text' },
    { id: 'card', header: 'מספר כרטיס', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, () => ({
      customer: `${pick(g.rng, HE_FIRST)} ${pick(g.rng, HE_LAST)}`,
      card: `${randInt(g.rng, 4, 5)}${randDigits(g.rng, 15)}`,
      amount: randMoney(g.rng, 20, 4000),
    })),
  outputs: [
    { header: 'שם לקוח', from: 'customer' },
    { header: '4 ספרות אחרונות', formula: 'substr(card, -4, 4)', value: (r) => String(r.card).slice(-4) },
    { header: 'סכום', from: 'amount', format: MONEY },
  ],
  rule: {},
});

const midN = defineType({
  id: 'extraction.mid-n',
  topic: 'extraction',
  title: 'Characters from the middle',
  description: 'Characters 3-5 of a fixed-layout SKU (year, department code, running number) are the department code.',
  lang: 'en',
  input: [
    { id: 'sku', header: 'SKU', type: 'text' },
    { id: 'desc', header: 'Description', type: 'text' },
    { id: 'qty', header: 'Quantity', type: 'integer' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      sku: `${randInt(g.rng, 22, 26)}${pick(g.rng, ['ABX', 'KLM', 'QRT', 'WNP', 'DFG'])}${String(10000 + i * 37 + randInt(g.rng, 0, 30))}`,
      desc: pick(g.rng, EN_PRODUCTS),
      qty: randInt(g.rng, 1, 500),
    })),
  outputs: [
    { header: 'SKU', from: 'sku' },
    { header: 'Department code', formula: 'substr(sku, 3, 3)', value: (r) => String(r.sku).slice(2, 5) },
    { header: 'Quantity', from: 'qty' },
  ],
  rule: {},
});

const beforeSep = defineType({
  id: 'extraction.before-sep',
  topic: 'extraction',
  title: 'Text before a separator',
  description: 'The document type is the part of the reference before the first dash (INV-2026-0042 -> INV); the prefixes differ in length.',
  lang: 'en',
  input: [
    { id: 'ref', header: 'Reference', type: 'text' },
    { id: 'customer', header: 'Customer', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      ref: `${pick(g.rng, ['INV', 'CRN', 'PO', 'QUOTE'])}-${randInt(g.rng, 2025, 2026)}-${seqId('', 40 + i, 4)}`,
      customer: pick(g.rng, ['Acme Supply', 'Northwind Traders', 'Global Parts', 'Blue Harbor']),
      amount: randMoney(g.rng, 100, 9000),
    })),
  outputs: [
    { header: 'Reference', from: 'ref' },
    { header: 'Document type', formula: 'split(ref, "-", 1)', value: (r) => String(r.ref).split('-')[0] ?? null },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: {},
});

const afterLastSep = defineType({
  id: 'extraction.after-last-sep',
  topic: 'extraction',
  title: 'Last segment of a path',
  description: 'The product name is the last segment of a category path (ציוד/כלי עבודה/פטיש); paths are two or three levels deep.',
  lang: 'he',
  input: [
    { id: 'path', header: 'נתיב קטגוריה', type: 'text' },
    { id: 'sku', header: 'מק"ט', type: 'text' },
    { id: 'price', header: 'מחיר', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const top = pick(g.rng, ['ציוד', 'חומרי בניין', 'חשמל']);
      const mid = pick(g.rng, ['כלי עבודה', 'כלי יד', 'כלי חשמל']);
      const leaf = pick(g.rng, HE_PRODUCTS);
      return { path: randInt(g.rng, 0, 2) === 0 ? `${top}/${leaf}` : `${top}/${mid}/${leaf}`, sku: seqId('SK', 100 + i, 4), price: randMoney(g.rng, 10, 700) };
    }),
  outputs: [
    { header: 'מק"ט', from: 'sku' },
    { header: 'שם מוצר', formula: 'split(path, "/", -1)', value: (r) => String(r.path).split('/').pop() ?? null },
    { header: 'מחיר', from: 'price', format: MONEY },
  ],
  rule: {},
});

const betweenMarkers = defineType({
  id: 'extraction.between-markers',
  topic: 'extraction',
  title: 'Text between two markers',
  description: 'The customer tier written in brackets after a name ("Dana Cohen (Premium)") becomes its own column.',
  lang: 'en',
  input: [
    { id: 'customer', header: 'Customer', type: 'text' },
    { id: 'orders', header: 'Orders', type: 'integer' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      customer: `${pick(g.rng, EN_FIRST)} ${pick(g.rng, EN_LAST)}${i % 2 === 0 ? '' : ' Jr'} (${pick(g.rng, ['Premium', 'Standard', 'VIP', 'Trial', 'Partner'])})`,
      orders: randInt(g.rng, 1, 60),
    })),
  outputs: [
    { header: 'Customer', from: 'customer' },
    { header: 'Tier', formula: 'split(split(customer, "(", 2), ")", 1)', value: (r) => /\(([^)]*)\)/.exec(String(r.customer))?.[1] ?? null },
    { header: 'Orders', from: 'orders' },
  ],
  rule: {},
});

const nthWord = defineType({
  id: 'extraction.nth-word',
  topic: 'extraction',
  title: 'The n-th word',
  description: 'The house number is the second word of an address line ("הרצל 12 חיפה"), as a number.',
  lang: 'he',
  input: [
    { id: 'cid', header: 'מספר לקוח', type: 'text' },
    { id: 'address', header: 'כתובת', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      cid: seqId('C-', 200 + i, 4),
      address: `${pick(g.rng, ['הרצל', 'ויצמן', 'רוטשילד', 'אלנבי', 'הגפן', 'הזית', 'דיזנגוף', 'סוקולוב'])} ${randInt(g.rng, 1, 180)} ${pick(g.rng, HE_CITIES.filter((c) => !c.includes(' ')))}`,
    })),
  outputs: [
    { header: 'מספר לקוח', from: 'cid' },
    { header: 'מספר בית', formula: 'toNumber(split(address, " ", 2))', type: 'decimal', value: (r) => Number(String(r.address).split(' ')[1]) },
  ],
  rule: {},
});

const lastWord = defineType({
  id: 'extraction.last-word',
  topic: 'extraction',
  title: 'The last word',
  description: 'The family name is the last word of a full name that has two or three words.',
  lang: 'en',
  input: [
    { id: 'cid', header: 'Customer ID', type: 'text' },
    { id: 'name', header: 'Full name', type: 'text' },
    { id: 'city', header: 'City', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      cid: seqId('CU', 300 + i, 4),
      name: [pick(g.rng, EN_FIRST), ...(randInt(g.rng, 0, 1) === 1 ? [pick(g.rng, ['Lee', 'Ann', 'Rose', 'James'])] : []), pick(g.rng, EN_LAST)].join(' '),
      city: pick(g.rng, ['Austin', 'Denver', 'Miami', 'Seattle']),
    })),
  outputs: [
    { header: 'Customer ID', from: 'cid' },
    { header: 'Family name', formula: 'split(name, " ", -1)', value: (r) => String(r.name).split(' ').pop() ?? null },
    { header: 'City', from: 'city' },
  ],
  rule: {},
});

const initials = defineType({
  id: 'extraction.initials',
  topic: 'extraction',
  title: 'Initials from two columns',
  description: 'The initials are the first letter of the first name followed by the first letter of the last name.',
  lang: 'he',
  input: [
    { id: 'eid', header: 'מספר עובד', type: 'text' },
    { id: 'first', header: 'שם פרטי', type: 'text' },
    { id: 'last', header: 'שם משפחה', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ eid: seqId('E', 500 + i, 4), first: pick(g.rng, HE_FIRST), last: pick(g.rng, HE_LAST) })),
  outputs: [
    { header: 'מספר עובד', from: 'eid' },
    { header: 'ראשי תיבות', formula: 'concat(substr(first, 1, 1), substr(last, 1, 1))', value: (r) => `${String(r.first)[0]}${String(r.last)[0]}` },
  ],
  rule: {},
});

const digitsOnly = defineType({
  id: 'extraction.digits-only',
  topic: 'extraction',
  title: 'Keep only the digits',
  description: 'The numeric part of a messy reference ("Ref#A-77/2024", "מס\' 4521-ב"): every non-digit character, whatever it is, is dropped.',
  lang: 'en',
  input: [
    { id: 'raw', header: 'Reference text', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const junk = ['Ref#', 'No. ', 'INV/', 'מס\' ', 'PO:', '#', 'ID-', 'Order '];
      const tail = ['', '-B', '/X', ' (old)', '.', 'א', ' rev2'];
      return { raw: `${pick(g.rng, junk)}${pick(g.rng, ['A', 'B', ''])}${i % 3 === 0 ? '-' : ''}${randDigits(g.rng, randInt(g.rng, 3, 6))}${pick(g.rng, tail)}`, amount: randMoney(g.rng, 10, 3000) };
    }),
  outputs: [
    { header: 'Reference text', from: 'raw' },
    { header: 'Reference number', formula: 'keepChars(raw, "digits")', value: (r) => String(r.raw).replace(/[^0-9]/g, '') },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: {},
});

const SPEC_WORDS = ['Heavy duty', '500g', 'Blue', 'Pro series', 'EU plug', '2 pack', 'Matte', 'Steel'];
const afterFirst = (desc: unknown): string => String(desc).split(' - ').slice(1).join(' - ');

const afterFirstSepBounded = defineType({
  id: 'extraction.after-first-sep-bounded',
  topic: 'extraction',
  title: 'Everything after the first separator (up to 4 parts)',
  description: 'The specification is everything after the first " - " of a product description that has 2-4 parts ("Hammer - Heavy duty - 500g"). Said with one conditional per extra part.',
  lang: 'en',
  input: [
    { id: 'sku', header: 'SKU', type: 'text' },
    { id: 'desc', header: 'Description', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ sku: seqId('SKU-', 700 + i, 4), desc: [pick(g.rng, EN_PRODUCTS), ...Array.from({ length: randInt(g.rng, 1, 3) }, () => pick(g.rng, SPEC_WORDS))].join(' - ') })),
  outputs: [
    { header: 'SKU', from: 'sku' },
    {
      header: 'Specification',
      formula: 'concat(split(desc, " - ", 2), if(notEmpty(split(desc, " - ", 3)), concat(" - ", split(desc, " - ", 3)), ""), if(notEmpty(split(desc, " - ", 4)), concat(" - ", split(desc, " - ", 4)), ""))',
      value: (r) => afterFirst(r.desc),
    },
  ],
  rule: {},
});

const afterFirstSepRest = defineType({
  id: 'extraction.after-first-sep-rest',
  topic: 'extraction',
  title: 'Everything after the first separator (any number of parts)',
  description: 'The specification is everything after the first " - " of a product description with any number of parts, 2 to 6 ("Hammer - Heavy duty - 500g - Blue ...").',
  lang: 'en',
  input: [
    { id: 'sku', header: 'SKU', type: 'text' },
    { id: 'desc', header: 'Description', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ sku: seqId('SKU-', 700 + i, 4), desc: [pick(g.rng, EN_PRODUCTS), ...Array.from({ length: randInt(g.rng, 1, 5) }, () => pick(g.rng, SPEC_WORDS))].join(' - ') })),
  outputs: [
    { header: 'SKU', from: 'sku' },
    { header: 'Specification', value: (r) => afterFirst(r.desc) },
  ],
  rule: null,
  missing: {
    capability: 'positionSearch',
    detail: 'split cuts at every " - " and returns one part by number, so the rest after the FIRST separator cannot be said for an open number of parts; find(desc, " - ") now gives the position of the first one, but substr takes literal start/length and cannot cut at it',
    workaround: 'for a fixed maximum number of parts, one if(notEmpty(split(x, sep, n)), concat(sep, split(x, sep, n)), "") per extra part (see extraction.after-first-sep-bounded)',
  },
});

export const EXTRACTION: CatalogueType[] = [leftN, rightN, midN, beforeSep, afterLastSep, betweenMarkers, nthWord, lastWord, initials, digitsOnly, afterFirstSepBounded, afterFirstSepRest];
