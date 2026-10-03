// Text cleanup: removing noise from text cells without changing what they say.
import { pick, randInt } from '../../cases/lib/prng';
import { EN_FIRST, EN_LAST, HE_FIRST, HE_LAST, randDigits, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType } from '../types';

const trimNameEn = defineType({
  id: 'cleanup.trim',
  topic: 'cleanup',
  title: 'Trim leading and trailing spaces',
  description: 'Names exported with stray spaces at the start and end ("  Dana Cohen ") are cleaned.',
  lang: 'en',
  input: [
    { id: 'cid', header: 'Customer ID', type: 'text' },
    { id: 'name', header: 'Name', type: 'text' },
    { id: 'city', header: 'City', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      cid: seqId('CU', 100 + i, 4),
      name: `${' '.repeat(randInt(g.rng, 0, 2))}${pick(g.rng, EN_FIRST)} ${pick(g.rng, EN_LAST)}${' '.repeat(randInt(g.rng, 0, 3))}`,
      city: pick(g.rng, ['Austin', 'Denver', 'Miami', 'Seattle']),
    })),
  outputs: [
    { header: 'Customer ID', from: 'cid' },
    { header: 'Name', formula: 'trim(name)', value: (r) => String(r.name).trim() },
    { header: 'City', from: 'city' },
  ],
  rule: {},
});

const collapseSpaces = defineType({
  id: 'cleanup.collapse-spaces',
  topic: 'cleanup',
  title: 'Collapse repeated inner spaces',
  description: 'Hebrew names typed with two or three spaces between the words are normalized to single spaces.',
  lang: 'he',
  input: [
    { id: 'eid', header: 'מספר עובד', type: 'text' },
    { id: 'name', header: 'שם מלא', type: 'text' },
    { id: 'dept', header: 'מחלקה', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      eid: seqId('E', 100 + i, 4),
      name: `${pick(g.rng, HE_FIRST)}${' '.repeat(randInt(g.rng, 1, 3))}${pick(g.rng, HE_LAST)}`,
      dept: pick(g.rng, ['מכירות', 'רכש', 'כספים']),
    })),
  outputs: [
    { header: 'מספר עובד', from: 'eid' },
    { header: 'שם מלא', formula: 'trim(name)', value: (r) => String(r.name).trim().replace(/\s+/g, ' ') },
    { header: 'מחלקה', from: 'dept' },
  ],
  rule: {},
});

const upper = defineType({
  id: 'cleanup.upper-case',
  topic: 'cleanup',
  title: 'Upper case',
  description: 'Product codes typed in mixed case are written in capitals.',
  lang: 'en',
  input: [
    { id: 'code', header: 'Code', type: 'text' },
    { id: 'qty', header: 'Quantity', type: 'integer' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const code = `${pick(g.rng, ['ab', 'Cd', 'xY', 'GH', 'kl', 'Mn'])}-${1000 + i * 11 + randInt(g.rng, 0, 10)}${pick(g.rng, ['a', 'B', 'c', ''])}`;
      return { code, qty: randInt(g.rng, 1, 200) };
    }),
  outputs: [
    { header: 'Code', formula: 'upper(code)', value: (r) => String(r.code).toUpperCase() },
    { header: 'Quantity', from: 'qty' },
  ],
  rule: {},
});

const lower = defineType({
  id: 'cleanup.lower-case',
  topic: 'cleanup',
  title: 'Lower case',
  description: 'Email addresses typed in mixed case are written in lower case.',
  lang: 'en',
  input: [
    { id: 'cid', header: 'Customer ID', type: 'text' },
    { id: 'email', header: 'Email', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const f = pick(g.rng, EN_FIRST);
      const l = pick(g.rng, EN_LAST);
      return { cid: seqId('CU', 400 + i, 4), email: `${randInt(g.rng, 0, 1) === 0 ? f : f.toLowerCase()}.${randInt(g.rng, 0, 1) === 0 ? l.toUpperCase() : l}${i}@Example.com` };
    }),
  outputs: [
    { header: 'Customer ID', from: 'cid' },
    { header: 'Email', formula: 'lower(email)', value: (r) => String(r.email).toLowerCase() },
  ],
  rule: {},
});

const properCase = defineType({
  id: 'cleanup.proper-case',
  topic: 'cleanup',
  title: 'Capitalize each word (proper case)',
  description: 'Names typed as "dana COHEN" become "Dana Cohen": the first letter of every word in capitals, the rest in lower case.',
  lang: 'en',
  input: [
    { id: 'cid', header: 'Customer ID', type: 'text' },
    { id: 'name', header: 'Name', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const messy = (w: string): string => (randInt(g.rng, 0, 1) === 0 ? w.toLowerCase() : w.toUpperCase());
      return { cid: seqId('CU', 200 + i, 4), name: `${messy(pick(g.rng, EN_FIRST))} ${messy(pick(g.rng, EN_LAST))}` };
    }),
  outputs: [
    { header: 'Customer ID', from: 'cid' },
    { header: 'Name', formula: 'titleCase(name)', value: (r) => String(r.name).split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') },
  ],
  rule: {},
});

const removeChars = defineType({
  id: 'cleanup.remove-chars',
  topic: 'cleanup',
  title: 'Remove given characters',
  description: 'Phone numbers written as "(054) 123-4567" lose the brackets, the dash and the space: "0541234567".',
  lang: 'en',
  input: [
    { id: 'cid', header: 'Customer ID', type: 'text' },
    { id: 'phone', header: 'Phone', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const d = `05${randInt(g.rng, 0, 8)}${randDigits(g.rng, 7)}`;
      return { cid: seqId('CU', 300 + i, 4), phone: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` };
    }),
  outputs: [
    { header: 'Customer ID', from: 'cid' },
    {
      header: 'Phone',
      formula: 'replaceText(replaceText(replaceText(replaceText(phone, "(", ""), ")", ""), "-", ""), " ", "")',
      value: (r) => String(r.phone).replace(/[() -]/g, ''),
    },
  ],
  rule: {},
});

const replaceLiteral = defineType({
  id: 'cleanup.replace-text',
  topic: 'cleanup',
  title: 'Replace a literal text',
  description: 'The legal suffix בע"מ is removed from company names (some names do not have it).',
  lang: 'he',
  input: [
    { id: 'sid', header: 'מספר ספק', type: 'text' },
    { id: 'name', header: 'שם ספק', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ sid: seqId('S', 100 + i, 4), name: `${pick(g.rng, ['אלון', 'טכנו', 'גרין', 'מרום', 'שחר', 'נגב', 'כרמל', 'הדר', 'אורן', 'גלעד'])} ${pick(g.rng, ['יבוא', 'שיווק', 'תעשיות', 'לוגיסטיקה', 'בנייה', 'מזון', 'ציוד', 'הובלות'])}${pick(g.rng, ['', ' בע"מ', ' בע"מ'])}` })),
  outputs: [
    { header: 'מספר ספק', from: 'sid' },
    { header: 'שם ספק', formula: 'trim(replaceText(name, " בע\\"מ", ""))', value: (r) => String(r.name).split(' בע"מ').join('').trim() },
  ],
  rule: {},
});

export const CLEANUP: CatalogueType[] = [trimNameEn, collapseSpaces, upper, lower, properCase, removeChars, replaceLiteral];
