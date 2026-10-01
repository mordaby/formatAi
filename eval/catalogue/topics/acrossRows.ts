// Across rows: a value that depends on OTHER rows. An expression sees one row at a time (SPEC 8.3), so these use the across-row ("window")
// functions: one `window` node, evaluated in step 6 over the rows that remain, in file order (runningSum, groupSum, groupCount, previous,
// fillDown, rowNumber, rank ...; docs/proposals/window-operations.md). The free engine builds only the order-independent ones (a group's
// total, a count per group); the rest are expressible, and need the AI step.
import { pick, randInt, shuffle } from '../../cases/lib/prng';
import { HE_DEPARTMENTS, EN_DEPARTMENTS, addDays, cents, pickOrUnseen, randMoney, roundTo, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType, type Ymd } from '../types';

const MONEY = '#,##0.00';
const num = (v: unknown): number => v as number;
const DMY = 'DD/MM/YYYY';
/** A day number for comparing dates (independent of the engine's date code). */
const dayOf = (v: unknown): number => Date.UTC((v as Ymd).y, (v as Ymd).m - 1, (v as Ymd).d) / 86400000;

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
      formula: 'runningSum(amount)',
      type: 'decimal',
      format: MONEY,
      value: (_r, i, all) => cents(all.slice(0, i + 1).reduce((s, x) => s + Math.round(num(x.amount) * 100), 0)),
    },
  ],
  rule: {},
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
    { header: 'דירוג', formula: 'rank(order: sales desc)', type: 'integer', value: (r, _i, all) => 1 + all.filter((x) => num(x.sales) > num(r.sales)).length },
  ],
  rule: {},
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
    { header: 'Previous reading', formula: 'previous(reading)', type: 'integer', value: (_r, i, all) => (i === 0 ? null : (all[i - 1]?.reading ?? null)) },
  ],
  rule: {},
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
      formula: 'fillDown(cat)',
      type: 'text',
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
  rule: {},
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
      formula: 'groupSum(amount, by: dept)',
      type: 'decimal',
      format: MONEY,
      value: (r, _i, all) => cents(all.filter((x) => x.dept === r.dept).reduce((s, x) => s + Math.round(num(x.amount) * 100), 0)),
    },
  ],
  rule: {},
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
    { header: 'הזמנות ללקוח', formula: 'groupCount(by: customer)', type: 'integer', value: (r, _i, all) => all.filter((x) => x.customer === r.customer).length },
  ],
  rule: {},
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
    { header: 'Share %', formula: 'round(amount / groupSum(amount) * 100, 1)', type: 'decimal', format: '0.0', value: (r, _i, all) => roundTo((Math.round(num(r.amount) * 100) / all.reduce((s, x) => s + Math.round(num(x.amount) * 100), 0)) * 100, 1) },
  ],
  rule: {},
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
    { header: 'מס"ד', formula: 'rowNumber()', type: 'integer', value: (_r, i) => i + 1 },
    { header: 'שם', from: 'name' },
    { header: 'מחלקה', from: 'dept' },
  ],
  rule: {},
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
    {
      header: 'Check',
      formula: 'if(rowNumber(by: inv) > 1, "Duplicate", null)',
      type: 'text',
      value: (r, i, all) => (all.slice(0, i).some((x) => x.inv === r.inv) ? 'Duplicate' : null),
    },
  ],
  rule: {},
});

const runningTotalPerAccount = defineType({
  id: 'acrossRows.running-total-per-account',
  topic: 'acrossRows',
  title: 'Running balance per account, in date order',
  description: 'Each account has its own balance after every transaction, counted in date order; the rows are not sorted by date in the file.',
  lang: 'en',
  input: [
    { id: 'acct', header: 'Account', type: 'text' },
    { id: 'date', header: 'Date', type: 'date' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => {
    // one distinct day per row, in a shuffled order: the file is not in date order and no two rows tie
    const days = shuffle(g.rng, Array.from({ length: g.n }, (_, i) => i));
    return rowsOf(g, (i) => ({ acct: pick(g.rng, ['ACC-1001', 'ACC-1002', 'ACC-1003']), date: addDays({ y: 2026, m: 1, d: 1 }, days[i] as number), amount: randMoney(g.rng, -500, 900) }));
  },
  outputs: [
    { header: 'Account', from: 'acct' },
    { header: 'Date', from: 'date', format: DMY },
    { header: 'Amount', from: 'amount', format: MONEY },
    {
      header: 'Balance',
      formula: 'runningSum(amount, by: acct, order: date)',
      type: 'decimal',
      format: MONEY,
      value: (r, _i, all) => cents(all.filter((x) => x.acct === r.acct && dayOf(x.date) <= dayOf(r.date)).reduce((sum, x) => sum + Math.round(num(x.amount) * 100), 0)),
    },
  ],
  rule: {},
});

const rankDenseTies = defineType({
  id: 'acrossRows.rank-dense-ties',
  topic: 'acrossRows',
  title: 'Dense rank (equal values share a rank, no gaps)',
  description: 'Sales are ranked 1, 2, 3 ... from the highest; salespeople with equal sales share a rank and the next rank is not skipped (1, 1, 2).',
  lang: 'en',
  input: [
    { id: 'name', header: 'Salesperson', type: 'text' },
    { id: 'sales', header: 'Sales', type: 'integer', format: '#,##0' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ name: `${pick(g.rng, ['Dana', 'Yossi', 'Maya', 'Omer', 'Shira', 'Avi'])} ${i + 1}`, sales: randInt(g.rng, 5, 14) * 100 })),
  outputs: [
    { header: 'Salesperson', from: 'name' },
    { header: 'Sales', from: 'sales', format: '#,##0' },
    {
      header: 'Rank',
      formula: 'rank(order: sales desc, ties: dense)',
      type: 'integer',
      value: (r, _i, all) => 1 + new Set(all.filter((x) => num(x.sales) > num(r.sales)).map((x) => num(x.sales))).size,
    },
  ],
  rule: {},
});

const runningBalanceDateSorted = defineType({
  id: 'acrossRows.running-balance-date-sorted',
  topic: 'acrossRows',
  title: 'Running balance in date order, rows shown sorted by date',
  description: 'The report lists the transactions by date, and the balance grows in that order - not in the order the rows have in the file.',
  lang: 'en',
  input: [
    { id: 'txn', header: 'Transaction', type: 'text' },
    { id: 'date', header: 'Date', type: 'date' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => {
    const days = shuffle(g.rng, Array.from({ length: g.n }, (_, i) => i));
    return rowsOf(g, (i) => ({ txn: seqId('T', 100 + i, 4), date: addDays({ y: 2026, m: 2, d: 1 }, days[i] as number), amount: randMoney(g.rng, -400, 800) }));
  },
  reshape: (rows) => [...rows].sort((a, b) => dayOf(a.date) - dayOf(b.date)),
  outputs: [
    { header: 'Transaction', from: 'txn' },
    { header: 'Date', from: 'date', format: DMY },
    { header: 'Amount', from: 'amount', format: MONEY },
    {
      header: 'Balance',
      formula: 'runningSum(amount, order: date)',
      type: 'decimal',
      format: MONEY,
      value: (_r, i, all) => cents(all.slice(0, i + 1).reduce((sum, x) => sum + Math.round(num(x.amount) * 100), 0)),
    },
  ],
  rule: { transform: { sort: [{ column: 'date', dir: 'asc' }] } },
});

const groupTotalUnseenGroup = defineType({
  id: 'acrossRows.group-total-unseen-group',
  topic: 'acrossRows',
  title: 'Group total on every row, a new group next month',
  description: 'Each line shows the total of its department; next month a department appears that the example never had (a lookup of the example would not know it).',
  lang: 'en',
  tags: ['unseen'],
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'dept', header: 'Department', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), dept: pickOrUnseen(g, EN_DEPARTMENTS.slice(0, 3), EN_DEPARTMENTS.slice(3, 5)), amount: randMoney(g.rng, 10, 2000) })),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Department', from: 'dept' },
    { header: 'Amount', from: 'amount', format: MONEY },
    {
      header: 'Department total',
      formula: 'groupSum(amount, by: dept)',
      type: 'decimal',
      format: MONEY,
      value: (r, _i, all) => cents(all.filter((x) => x.dept === r.dept).reduce((sum, x) => sum + Math.round(num(x.amount) * 100), 0)),
    },
  ],
  rule: {},
});

export const ACROSS_ROWS: CatalogueType[] = [
  runningTotal,
  rank,
  previousRow,
  fillDown,
  groupTotalEachRow,
  countPerGroup,
  percentOfTotal,
  rowNumber,
  duplicateMarker,
  runningTotalPerAccount,
  rankDenseTies,
  runningBalanceDateSorted,
  groupTotalUnseenGroup,
];
