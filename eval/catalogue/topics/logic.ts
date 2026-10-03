// Logic: a value that depends on a condition.
import { pick, randInt } from '../../cases/lib/prng';
import { HE_STATUS, pickOrUnseen, randMoney, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType } from '../types';

const MONEY = '#,##0.00';

const ifElse = defineType({
  id: 'logic.if-else-text',
  topic: 'logic',
  title: 'If / else on a text value',
  description: 'An "active" flag column says yes when the status is "פעיל" and no for every other status.',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'status', header: 'סטטוס', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('O-', 100 + i, 4), status: pickOrUnseen(g, HE_STATUS, ['בהמתנה', 'הוקפא']), amount: randMoney(g.rng, 50, 5000) })),
  outputs: [
    { header: 'הזמנה', from: 'oid' },
    { header: 'פעיל', formula: 'if(status = "פעיל", "כן", "לא")', value: (r) => (r.status === 'פעיל' ? 'כן' : 'לא') },
    { header: 'סכום', from: 'amount', format: MONEY },
  ],
  rule: {},
});

const numericBands = defineType({
  id: 'logic.numeric-bands',
  topic: 'logic',
  title: 'Numeric bands',
  description: 'A size class from the quantity: under 10 is Small, under 100 is Medium, otherwise Large.',
  lang: 'en',
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'qty', header: 'Quantity', type: 'integer' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), qty: randInt(g.rng, 1, 300) })),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Quantity', from: 'qty' },
    { header: 'Size', formula: 'switch(qty < 10, "Small", qty < 100, "Medium", "Large")', value: (r) => ((r.qty as number) < 10 ? 'Small' : (r.qty as number) < 100 ? 'Medium' : 'Large') },
  ],
  rule: {},
});

const multiWay = defineType({
  id: 'logic.multi-way-choice',
  topic: 'logic',
  title: 'Multi-way choice on two columns',
  description: 'A shipping class depends on the country and on whether the parcel is over 20 kg (four classes).',
  lang: 'en',
  input: [
    { id: 'parcel', header: 'Parcel', type: 'text' },
    { id: 'country', header: 'Country', type: 'text' },
    { id: 'kg', header: 'Weight kg', type: 'decimal' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ parcel: seqId('PK', 50 + i, 4), country: pickOrUnseen(g, ['IL', 'IL', 'US', 'DE'], ['FR', 'JP']), kg: randInt(g.rng, 5, 600) / 10 })),
  outputs: [
    { header: 'Parcel', from: 'parcel' },
    {
      header: 'Class',
      formula: 'switch(and(country = "IL", kg > 20), "Local-heavy", country = "IL", "Local", kg > 20, "Export-heavy", "Export")',
      value: (r) => {
        const heavy = (r.kg as number) > 20;
        return r.country === 'IL' ? (heavy ? 'Local-heavy' : 'Local') : heavy ? 'Export-heavy' : 'Export';
      },
    },
  ],
  rule: {},
});

const flagWhen = defineType({
  id: 'logic.flag-when',
  topic: 'logic',
  title: 'Flag a row when a condition holds',
  description: 'Orders over 5,000 get the flag "לבדיקה"; every other order has an empty cell.',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('O-', 200 + i, 4), amount: randMoney(g.rng, 100, 9000) })),
  outputs: [
    { header: 'הזמנה', from: 'oid' },
    { header: 'סכום', from: 'amount', format: MONEY },
    { header: 'הערה', formula: 'if(amount > 5000, "לבדיקה", "")', value: (r) => ((r.amount as number) > 5000 ? 'לבדיקה' : null) },
  ],
  rule: {},
});

const andOr = defineType({
  id: 'logic.and-or-condition',
  topic: 'logic',
  title: 'Priority from an and / or condition',
  description: 'An order is "Priority" when it is at least 1,000 and comes from the North or East region, otherwise "Normal".',
  lang: 'en',
  input: [
    { id: 'oid', header: 'Order', type: 'text' },
    { id: 'region', header: 'Region', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('SO', 300 + i, 4), region: pick(g.rng, ['North', 'South', 'East', 'West']), amount: randMoney(g.rng, 100, 3000) })),
  outputs: [
    { header: 'Order', from: 'oid' },
    { header: 'Amount', from: 'amount', format: MONEY },
    {
      header: 'Handling',
      formula: 'if(and(amount >= 1000, or(region = "North", region = "East")), "Priority", "Normal")',
      value: (r) => ((r.amount as number) >= 1000 && (r.region === 'North' || r.region === 'East') ? 'Priority' : 'Normal'),
    },
  ],
  rule: {},
});

const coalesceFallback = defineType({
  id: 'logic.fallback-when-empty',
  topic: 'logic',
  title: 'Use another column when the first is empty',
  description: 'The contact number is the mobile when there is one, otherwise the office phone.',
  lang: 'he',
  input: [
    { id: 'name', header: 'שם', type: 'text' },
    { id: 'mobile', header: 'נייד', type: 'text' },
    { id: 'phone', header: 'טלפון משרד', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר'])} ${pick(g.rng, ['כהן', 'לוי', 'מזרחי', 'פרץ'])} ${i + 1}`,
      mobile: randInt(g.rng, 0, 2) === 0 ? null : `05${randInt(g.rng, 0, 8)}${String(randInt(g.rng, 1000000, 9999999))}`,
      phone: `0${randInt(g.rng, 2, 9)}${String(randInt(g.rng, 1000000, 9999999))}`,
    })),
  outputs: [
    { header: 'שם', from: 'name' },
    { header: 'טלפון ליצירת קשר', formula: 'coalesce(mobile, phone)', value: (r) => r.mobile ?? r.phone ?? null },
  ],
  rule: {},
});

const keywordCategory = defineType({
  id: 'logic.keyword-category',
  topic: 'logic',
  title: 'Category from a keyword in free text',
  description: 'An expense is categorized by a word in its description (fuel, hotel, flight; otherwise Other).',
  lang: 'en',
  input: [
    { id: 'id', header: 'Expense', type: 'text' },
    { id: 'desc', header: 'Description', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const place = pickOrUnseen(g, ['Shell fuel station', 'Hilton hotel', 'El Al flight', 'Office supplies', 'Paz fuel', 'Dan hotel', 'Lunch meeting', 'Taxi ride'], ['Delek fuel', 'Isrotel hotel', 'Arkia flight', 'Parking fee']);
      return { id: seqId('X', 100 + i, 4), desc: `${place} ${randInt(g.rng, 1, 99)}`, amount: randMoney(g.rng, 10, 1500) };
    }),
  outputs: [
    { header: 'Expense', from: 'id' },
    {
      header: 'Category',
      formula: 'switch(contains(desc, "fuel"), "Fuel", contains(desc, "hotel"), "Lodging", contains(desc, "flight"), "Travel", "Other")',
      value: (r) => {
        const d = String(r.desc);
        return d.includes('fuel') ? 'Fuel' : d.includes('hotel') ? 'Lodging' : d.includes('flight') ? 'Travel' : 'Other';
      },
    },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: {},
});

export const LOGIC: CatalogueType[] = [ifElse, numericBands, multiWay, flagWhen, andOr, coalesceFallback, keywordCategory];
