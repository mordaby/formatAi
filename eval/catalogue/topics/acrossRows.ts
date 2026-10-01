// Across rows: a value that depends on OTHER rows. The rules language sees exactly one row at a time (SPEC 8.3: expressions are pure,
// "no row context"), so every type here is a language gap; the catalogue measures what the free engine makes of them anyway.
import { pick, randInt } from '../../cases/lib/prng';
import { HE_DEPARTMENTS, EN_DEPARTMENTS, cents, randMoney, roundTo, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType } from '../types';

const MONEY = '#,##0.00';
const num = (v: unknown): number => v as number;

const runningTotal = defineType({
  id: 'acrossRows.running-total',
  topic: 'acrossRows',
  title: 'Running total',
  description: 'The balance after each transaction: the sum of this amount and every amount above it.',
  lang: 'en',
  input: [
    { id: 'txn', header: 'Transaction', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ txn: seqId('T', 100 + i, 4), amount: randMoney(g.rng, -800, 1500) })),
  outputs: [
    { header: 'Transaction', from: 'txn' },
    { header: 'Amount', from: 'amount', format: MONEY },
    {
      header: 'Balance',
      format: MONEY,
      value: (_r, i, all) => cents(all.slice(0, i + 1).reduce((s, x) => s + Math.round(num(x.amount) * 100), 0)),
    },
  ],
  rule: null,
  missing: { capability: 'runningAggregate', detail: 'the value of a row is the sum of this row and the rows above it' },
});

const rank = defineType({
  id: 'acrossRows.rank',
  topic: 'acrossRows',
  title: 'Rank by a value',
  description: 'Each salesperson gets a rank by sales, 1 = the highest (equal values share a rank).',
  lang: 'he',
  input: [
    { id: 'name', header: 'מוכר', type: 'text' },
    { id: 'sales', header: 'מכירות', type: 'integer', format: '#,##0' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר', 'שירה', 'אבי'])} ${i + 1}`, sales: randInt(g.rng, 20, 400) * 100 })),
  outputs: [
    { header: 'מוכר', from: 'name' },
    { header: 'מכירות', from: 'sales', format: '#,##0' },
    { header: 'דירוג', value: (r, _i, all) => 1 + all.filter((x) => num(x.sales) > num(r.sales)).length },
  ],
  rule: null,
  missing: { capability: 'rank', detail: 'the position of a value among all the rows needs the other rows' },
});

const previousRow = defineType({
  id: 'acrossRows.previous-row',
  topic: 'acrossRows',
  title: 'Value of the previous row',
  description: 'Each meter reading is shown next to the previous reading (empty on the first row).',
  lang: 'en',
  input: [
    { id: 'month', header: 'Month', type: 'text' },
    { id: 'reading', header: 'Reading', type: 'integer' },
  ],
  generate: (g) => {
    let reading = randInt(g.rng, 1000, 5000);
    return rowsOf(g, (i) => {
      reading += randInt(g.rng, 20, 400);
      return { month: seqId('M', i + 1, 2), reading };
    });
  },
  outputs: [
    { header: 'Month', from: 'month' },
    { header: 'Reading', from: 'reading' },
    { header: 'Previous reading', value: (_r, i, all) => (i === 0 ? null : (all[i - 1]?.reading ?? null)) },
  ],
  rule: null,
  missing: { capability: 'rowLookback', detail: 'reading the cell of the row above' },
});

const fillDown = defineType({
  id: 'acrossRows.fill-down',
  topic: 'acrossRows',
  title: 'Fill blank cells from the cell above',
  description: 'A category is written only on the first row of each block (like merged cells); every row gets its category.',
  lang: 'he',
  input: [
    { id: 'cat', header: 'קטגוריה', type: 'text' },
    { id: 'item', header: 'פריט', type: 'text' },
    { id: 'qty', header: 'כמות', type: 'integer' },
  ],
  generate: (g) => {
    const cats = ['ציוד', 'חשמל', 'חומרי בניין', 'ריהוט'];
    let current = 0;
    let left = 0;
    return rowsOf(g, (i) => {
      const first = left === 0;
      if (first) {
        current = (current + 1) % cats.length;
        left = randInt(g.rng, 2, 5);
      }
      left--;
      return { cat: first ? (cats[current] ?? null) : null, item: seqId('פ-', 100 + i, 3), qty: randInt(g.rng, 1, 90) };
    });
  },
  outputs: [
    {
      header: 'קטגוריה',
      value: (_r, i, all) => {
        for (let k = i; k >= 0; k--) {
          const c = all[k]?.cat;
          if (c !== null && c !== undefined) return c;
        }
        return null;
      },
    },
    { header: 'פריט', from: 'item' },
    { header: 'כמות', from: 'qty' },
  ],
  rule: null,
  missing: { capability: 'rowLookback', detail: 'a blank cell takes the last non-empty value above it' },
});

const groupTotalEachRow = defineType({
  id: 'acrossRows.group-total-each-row',
  topic: 'acrossRows',
  title: 'Group total on every row',
  description: 'Each order line shows the total of its department next to its own amount (not a summary row: on every detail row).',
  lang: 'en',
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'dept', header: 'Department', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), dept: pick(g.rng, EN_DEPARTMENTS.slice(0, 4)), amount: randMoney(g.rng, 10, 2000) })),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Department', from: 'dept' },
    { header: 'Amount', from: 'amount', format: MONEY },
    {
      header: 'Department total',
      format: MONEY,
      value: (r, _i, all) => cents(all.filter((x) => x.dept === r.dept).reduce((s, x) => s + Math.round(num(x.amount) * 100), 0)),
    },
  ],
  rule: null,
  missing: { capability: 'windowAggregate', detail: 'sum over the rows with the same department, shown on each of them' },
});

const countPerGroup = defineType({
  id: 'acrossRows.count-per-group',
  topic: 'acrossRows',
  title: 'Count of rows per group on every row',
  description: 'Each order shows how many orders its customer has in the file.',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'customer', header: 'לקוח', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('O-', 100 + i, 4), customer: pick(g.rng, ['אלון ובניו', 'טכנו-פלוס', 'מרום יבוא', 'שחר שיווק', 'נגב תעשיות']) })),
  outputs: [
    { header: 'הזמנה', from: 'oid' },
    { header: 'לקוח', from: 'customer' },
    { header: 'הזמנות ללקוח', value: (r, _i, all) => all.filter((x) => x.customer === r.customer).length },
  ],
  rule: null,
  missing: { capability: 'windowAggregate', detail: 'count of the rows with the same customer, shown on each of them' },
});

const percentOfTotal = defineType({
  id: 'acrossRows.percent-of-total',
  topic: 'acrossRows',
  title: "Share of the column's grand total",
  description: 'Each line shows its amount as a percentage of the total of all lines (one decimal).',
  lang: 'en',
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), amount: randMoney(g.rng, 50, 3000) })),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Amount', from: 'amount', format: MONEY },
    { header: 'Share %', format: '0.0', value: (r, _i, all) => roundTo((Math.round(num(r.amount) * 100) / all.reduce((s, x) => s + Math.round(num(x.amount) * 100), 0)) * 100, 1) },
  ],
  rule: null,
  missing: { capability: 'windowAggregate', detail: 'the divisor is the sum of the whole column' },
});

const rowNumber = defineType({
  id: 'acrossRows.row-number',
  topic: 'acrossRows',
  title: 'Running row number',
  description: 'A sequence number 1, 2, 3 ... is added as the first column.',
  lang: 'he',
  input: [
    { id: 'name', header: 'שם', type: 'text' },
    { id: 'dept', header: 'מחלקה', type: 'text' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר', 'שירה'])} ${pick(g.rng, ['כהן', 'לוי', 'מזרחי'])} ${i}`, dept: pick(g.rng, HE_DEPARTMENTS) })),
  outputs: [
    { header: 'מס"ד', value: (_r, i) => i + 1 },
    { header: 'שם', from: 'name' },
    { header: 'מחלקה', from: 'dept' },
  ],
  rule: null,
  missing: { capability: 'rowIndex', detail: 'the position of the row is not available to an expression (only a split cell has an index)' },
});

const duplicateMarker = defineType({
  id: 'acrossRows.duplicate-marker',
  topic: 'acrossRows',
  title: 'Mark the repeated occurrences of a key',
  description: 'A column says "Duplicate" on every invoice number that already appeared on a row above (all rows are kept).',
  lang: 'en',
  input: [
    { id: 'inv', header: 'Invoice', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('INV-', 100 + (randInt(g.rng, 0, 4) === 0 && i > 3 ? i - randInt(g.rng, 1, 3) : i), 4), amount: randMoney(g.rng, 50, 3000) })),
  outputs: [
    { header: 'Invoice', from: 'inv' },
    { header: 'Amount', from: 'amount', format: MONEY },
    { header: 'Check', value: (r, i, all) => (all.slice(0, i).some((x) => x.inv === r.inv) ? 'Duplicate' : null) },
  ],
  rule: null,
  missing: {
    capability: 'runningAggregate',
    detail: 'whether the same key appeared in an earlier row is a running count by key',
    workaround: 'transform.dedupe with action "flag" marks the extra copies in the run flags (a highlight and a message), but cannot write a value into an output column',
  },
});

export const ACROSS_ROWS: CatalogueType[] = [runningTotal, rank, previousRow, fillDown, groupTotalEachRow, countPerGroup, percentOfTotal, rowNumber, duplicateMarker];
