// Row operations: which rows exist, and how many, changes (filters, duplicates, splitting, unpivoting, grouping, sorting, totals).
import { pick, randInt, shuffle } from '../../cases/lib/prng';
import { EN_DEPARTMENTS, HE_DEPARTMENTS, HE_STATUS, cents, randMoney, rowsOf, seqId } from '../data';
import { defineType, type CatalogueType, type Row, type V } from '../types';

const MONEY = '#,##0.00';
const num = (v: unknown): number => v as number;
const sumCents = (rows: readonly Row[], key: string): number => cents(rows.reduce((s, x) => s + Math.round(num(x[key]) * 100), 0));

function groupByKey(rows: readonly Row[], key: string): Row[][] {
  const order: Row[][] = [];
  const index = new Map<string, number>();
  for (const r of rows) {
    const k = String(r[key]);
    let gi = index.get(k);
    if (gi === undefined) {
      gi = order.length;
      index.set(k, gi);
      order.push([]);
    }
    order[gi]!.push(r);
  }
  return order;
}

const filterByValue = defineType({
  id: 'rowOps.filter-by-value',
  topic: 'rowOps',
  title: 'Keep rows with a given value',
  description: 'Only the orders whose status is "פעיל" (active) stay in the output.',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'status', header: 'סטטוס', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('O-', 100 + i, 4), status: pick(g.rng, [HE_STATUS[0]!, HE_STATUS[0]!, ...HE_STATUS.slice(1)]), amount: randMoney(g.rng, 50, 5000) })),
  reshape: (rows) => rows.filter((r) => r.status === 'פעיל'),
  outputs: [
    { header: 'הזמנה', from: 'oid' },
    { header: 'סכום', from: 'amount', format: MONEY },
  ],
  rule: { input: { rowFilters: [{ column: 'status', op: 'eq', value: 'פעיל' }] } },
});

const filterNumeric = defineType({
  id: 'rowOps.filter-by-number',
  topic: 'rowOps',
  title: 'Keep rows above a threshold',
  description: 'Only the lines of at least 100 stay in the output.',
  lang: 'en',
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), amount: randMoney(g.rng, 5, 400) })),
  reshape: (rows) => rows.filter((r) => num(r.amount) >= 100),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: { input: { rowFilters: [{ column: 'amount', op: 'gte', value: 100 }] } },
});

const filterNotEmpty = defineType({
  id: 'rowOps.filter-not-empty',
  topic: 'rowOps',
  title: 'Drop rows with an empty cell',
  description: 'Customers without an email address are dropped.',
  lang: 'he',
  input: [
    { id: 'cid', header: 'לקוח', type: 'text' },
    { id: 'name', header: 'שם', type: 'text' },
    { id: 'email', header: 'אימייל', type: 'text' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({ cid: seqId('C-', 100 + i, 4), name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר'])} ${pick(g.rng, ['כהן', 'לוי', 'מזרחי', 'פרץ'])}`, email: randInt(g.rng, 0, 2) === 0 ? null : `user${i}@example.com` })),
  reshape: (rows) => rows.filter((r) => r.email !== null),
  outputs: [
    { header: 'לקוח', from: 'cid' },
    { header: 'שם', from: 'name' },
    { header: 'אימייל', from: 'email' },
  ],
  rule: { input: { rowFilters: [{ column: 'email', op: 'notEmpty' }] } },
});

const filterExpr = defineType({
  id: 'rowOps.filter-by-condition',
  topic: 'rowOps',
  title: 'Keep rows that meet a combined condition',
  description: 'Orders over 500 that are not from the West region stay.',
  lang: 'en',
  input: [
    { id: 'oid', header: 'Order', type: 'text' },
    { id: 'region', header: 'Region', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('SO', 100 + i, 4), region: pick(g.rng, ['North', 'South', 'East', 'West']), amount: randMoney(g.rng, 50, 1000) })),
  reshape: (rows) => rows.filter((r) => num(r.amount) > 500 && r.region !== 'West'),
  outputs: [
    { header: 'Order', from: 'oid' },
    { header: 'Region', from: 'region' },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: { input: { rowFilters: [{ expr: 'and(amount > 500, region <> "West")' }] } },
});

const dedupeAll = defineType({
  id: 'rowOps.dedupe-all-columns',
  topic: 'rowOps',
  title: 'Remove exact duplicate rows',
  description: 'Rows that are identical in every column are listed once (the first copy stays).',
  lang: 'en',
  input: [
    { id: 'inv', header: 'Invoice', type: 'text' },
    { id: 'customer', header: 'Customer', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => {
    const rows: Row[] = [];
    for (let i = 0; i < g.n; i++) {
      if (i > 3 && randInt(g.rng, 0, 4) === 0) rows.push({ ...rows[randInt(g.rng, 0, rows.length - 1)]! });
      else rows.push({ inv: seqId('INV-', 100 + i, 4), customer: pick(g.rng, ['Acme Supply', 'Northwind Traders', 'Global Parts']), amount: randMoney(g.rng, 50, 5000) });
    }
    return rows;
  },
  reshape: (rows) => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = JSON.stringify([r.inv, r.customer, r.amount]);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  outputs: [
    { header: 'Invoice', from: 'inv' },
    { header: 'Customer', from: 'customer' },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: { transform: { dedupe: { keys: 'all', keep: 'first', action: 'remove' } } },
});

const dedupeKeyLast = defineType({
  id: 'rowOps.dedupe-by-key-keep-last',
  topic: 'rowOps',
  title: 'One row per key, the last one wins',
  description: 'A customer appears several times with updated details; only the last row of each customer ID stays.',
  lang: 'he',
  input: [
    { id: 'cid', header: 'מספר לקוח', type: 'text' },
    { id: 'name', header: 'שם', type: 'text' },
    { id: 'phone', header: 'טלפון', type: 'text' },
  ],
  generate: (g) => {
    const rows: Row[] = [];
    let next = 0;
    for (let i = 0; i < g.n; i++) {
      const reuse = i > 3 && randInt(g.rng, 0, 3) === 0;
      const cid = reuse ? (rows[randInt(g.rng, 0, rows.length - 1)]?.cid ?? null) : seqId('C-', 100 + next++, 4);
      rows.push({ cid, name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר'])} ${pick(g.rng, ['כהן', 'לוי', 'מזרחי'])}`, phone: `05${randInt(g.rng, 0, 8)}${String(randInt(g.rng, 1000000, 9999999))}` });
    }
    return rows;
  },
  reshape: (rows) => rows.filter((r, i) => !rows.slice(i + 1).some((x) => x.cid === r.cid)),
  outputs: [
    { header: 'מספר לקוח', from: 'cid' },
    { header: 'שם', from: 'name' },
    { header: 'טלפון', from: 'phone' },
  ],
  rule: { transform: { dedupe: { keys: ['cid'], keep: 'last', action: 'remove' } } },
});

const splitRows = defineType({
  id: 'rowOps.split-cell-to-rows',
  topic: 'rowOps',
  title: 'One cell with several values becomes several rows',
  description: 'A policy listing "חיים; בריאות" in one cell becomes one row per product (the other columns repeat).',
  lang: 'he',
  input: [
    { id: 'policy', header: 'פוליסה', type: 'text' },
    { id: 'products', header: 'מוצרים', type: 'text' },
    { id: 'premium', header: 'פרמיה', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const all = ['חיים', 'בריאות', 'רכב', 'דירה', 'פנסיה'];
      const k = randInt(g.rng, 1, 3);
      const picked = shuffle(g.rng, all).slice(0, k);
      return { policy: seqId('PL', 1000 + i, 5), products: picked.join('; '), premium: randMoney(g.rng, 100, 4000) };
    }),
  reshape: (rows) => rows.flatMap((r) => String(r.products).split(';').map((p) => ({ ...r, product: p.trim() }))),
  outputs: [
    { header: 'פוליסה', from: 'policy' },
    { header: 'מוצר', from: 'product' },
    { header: 'פרמיה', from: 'premium', format: MONEY },
  ],
  rule: { transform: { expand: { mode: 'splitCell', column: 'products', separator: ';', trim: true, partId: 'product', skipEmpty: true } } },
});

const columnsToRows = defineType({
  id: 'rowOps.columns-to-rows',
  topic: 'rowOps',
  title: 'Month columns become rows',
  description: 'A budget with one column per month (Jan, Feb, Mar) becomes one row per department and month; empty months are skipped.',
  lang: 'en',
  input: [
    { id: 'dept', header: 'Department', type: 'text' },
    { id: 'jan', header: 'Jan', type: 'decimal', format: MONEY },
    { id: 'feb', header: 'Feb', type: 'decimal', format: MONEY },
    { id: 'mar', header: 'Mar', type: 'decimal', format: MONEY },
  ],
  generate: (g) =>
    rowsOf(g, (i) => ({
      dept: `${pick(g.rng, EN_DEPARTMENTS)}-${i + 1}`,
      jan: randInt(g.rng, 0, 6) === 0 ? null : randMoney(g.rng, 500, 20000),
      feb: randMoney(g.rng, 500, 20000),
      mar: randInt(g.rng, 0, 6) === 0 ? null : randMoney(g.rng, 500, 20000),
    })),
  reshape: (rows) =>
    rows.flatMap((r) =>
      (['jan', 'feb', 'mar'] as const)
        .filter((m) => r[m] !== null)
        .map((m) => ({ dept: r.dept as V, month: { jan: 'Jan', feb: 'Feb', mar: 'Mar' }[m], amount: r[m] as V })),
    ),
  outputs: [
    { header: 'Department', from: 'dept' },
    { header: 'Month', from: 'month' },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: { transform: { expand: { mode: 'columnsToRows', columns: ['jan', 'feb', 'mar'], labelId: 'month', valueId: 'amount', valueType: 'decimal', skipEmpty: true } } },
});

const pivot = defineType({
  id: 'rowOps.rows-to-columns-pivot',
  topic: 'rowOps',
  title: 'Rows to columns (pivot)',
  description: 'Sales by region and quarter, one row per sale, become a cross-tab: one row per region, one column per quarter, summed.',
  lang: 'en',
  input: [
    { id: 'region', header: 'Region', type: 'text' },
    { id: 'quarter', header: 'Quarter', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, () => ({ region: pick(g.rng, ['North', 'South', 'East', 'West']), quarter: pick(g.rng, ['Q1', 'Q2', 'Q3', 'Q4']), amount: randMoney(g.rng, 100, 5000) })),
  outputs: [],
  table: (rows) => {
    const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
    const regions = [...new Set(rows.map((r) => String(r.region)))].sort();
    return {
      headers: ['Region', ...quarters],
      rows: regions.map((reg) => [reg, ...quarters.map((q) => {
        const cell = rows.filter((r) => r.region === reg && r.quarter === q);
        return cell.length === 0 ? null : sumCents(cell, 'amount');
      })]),
    };
  },
  rule: null,
  missing: { capability: 'pivotOutput', detail: 'one output column per distinct value of the Quarter column, each holding a sum per region' },
});

const groupSummary = defineType({
  id: 'rowOps.group-summary',
  topic: 'rowOps',
  title: 'One summary row per group',
  description: 'Orders are summarized per department: the total amount and the number of orders (no detail rows).',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'dept', header: 'מחלקה', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('O-', 100 + i, 4), dept: pick(g.rng, HE_DEPARTMENTS.slice(0, 4)), amount: randMoney(g.rng, 50, 4000) })),
  reshape: (rows) => groupByKey(rows, 'dept').map((grp) => ({ oid: grp.length, dept: grp[0]!.dept as V, amount: sumCents(grp, 'amount') })),
  outputs: [
    { header: 'מחלקה', from: 'dept', agg: 'first' },
    { header: 'סה"כ', from: 'amount', agg: 'sum', format: MONEY },
    { header: 'הזמנות', from: 'oid', agg: 'count' },
  ],
  rule: { transform: { group: { by: 'dept', showDetailRows: false } } },
});

const sortRows = defineType({
  id: 'rowOps.sort-by-column',
  topic: 'rowOps',
  title: 'Sort by a column',
  description: 'The rows are sorted by amount, largest first.',
  lang: 'en',
  input: [
    { id: 'line', header: 'Line', type: 'text' },
    { id: 'customer', header: 'Customer', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ line: seqId('L', 10 + i, 3), customer: pick(g.rng, ['Acme Supply', 'Northwind Traders', 'Global Parts', 'Blue Harbor']), amount: randMoney(g.rng, 10, 9000) })),
  reshape: (rows) => [...rows].sort((a, b) => num(b.amount) - num(a.amount)),
  outputs: [
    { header: 'Line', from: 'line' },
    { header: 'Customer', from: 'customer' },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  rule: { transform: { sort: [{ column: 'amount', dir: 'desc' }] } },
});

const totalsRow = defineType({
  id: 'rowOps.totals-row',
  topic: 'rowOps',
  title: 'A totals row at the end',
  description: 'A "סה"כ" row with the sum of the amounts is added after the last row.',
  lang: 'he',
  input: [
    { id: 'oid', header: 'הזמנה', type: 'text' },
    { id: 'customer', header: 'לקוח', type: 'text' },
    { id: 'amount', header: 'סכום', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('O-', 100 + i, 4), customer: pick(g.rng, ['אלון ובניו', 'טכנו-פלוס', 'מרום יבוא', 'שחר שיווק']), amount: randMoney(g.rng, 50, 4000) })),
  outputs: [
    { header: 'הזמנה', from: 'oid' },
    { header: 'לקוח', from: 'customer' },
    { header: 'סכום', from: 'amount', format: MONEY },
  ],
  finalize: (out, rows) => [...out, ['סה"כ', null, sumCents(rows, 'amount')]],
  rule: { output: { summaryRows: [{ label: 'סה"כ', labelColumn: 'הזמנה', cells: { סכום: 'sum' } }] } },
});

const groupSubtotals = defineType({
  id: 'rowOps.group-subtotals',
  topic: 'rowOps',
  title: 'Detail rows with a subtotal after each group',
  description: 'Orders sorted by department, with a "Subtotal" row after each department.',
  lang: 'en',
  input: [
    { id: 'oid', header: 'Order', type: 'text' },
    { id: 'dept', header: 'Department', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ oid: seqId('SO', 100 + i, 4), dept: pick(g.rng, EN_DEPARTMENTS.slice(0, 3)), amount: randMoney(g.rng, 50, 4000) })),
  reshape: (rows) => [...rows].sort((a, b) => String(a.dept).localeCompare(String(b.dept))),
  outputs: [
    { header: 'Order', from: 'oid' },
    { header: 'Department', from: 'dept' },
    { header: 'Amount', from: 'amount', format: MONEY },
  ],
  finalize: (out, rows) => {
    const result: V[][] = [];
    let k = 0;
    for (const grp of groupByKey(rows, 'dept')) {
      for (let j = 0; j < grp.length; j++) result.push(out[k++]!);
      result.push(['Subtotal', null, sumCents(grp, 'amount')]);
    }
    return result;
  },
  rule: {
    transform: {
      sort: [{ column: 'dept', dir: 'asc' }],
      group: { by: 'dept', showDetailRows: true, summaryRows: [{ label: 'Subtotal', labelColumn: 'Order', cells: { Amount: 'sum' } }] },
    },
  },
});

const fixedFanOut = defineType({
  id: 'rowOps.debit-credit-fan-out',
  topic: 'rowOps',
  title: 'Every row becomes a debit row and a credit row',
  description: 'Each payment becomes two ledger rows: the account with a "Debit" side and the amount, then the cash account with "Credit" and the negative amount.',
  lang: 'en',
  input: [
    { id: 'pay', header: 'Payment', type: 'text' },
    { id: 'account', header: 'Account', type: 'text' },
    { id: 'amount', header: 'Amount', type: 'decimal', format: MONEY },
  ],
  generate: (g) => rowsOf(g, (i) => ({ pay: seqId('PM', 100 + i, 4), account: pick(g.rng, ['Supplies', 'Rent', 'Travel', 'Software']), amount: randMoney(g.rng, 20, 3000) })),
  reshape: (rows) => rows.flatMap((r) => [{ ...r, side: 'Debit', signed: r.amount as V }, { ...r, side: 'Credit', signed: -num(r.amount) }]),
  outputs: [
    { header: 'Payment', from: 'pay' },
    { header: 'Account', from: 'account' },
    { header: 'Side', from: 'side' },
    { header: 'Amount', from: 'signed', format: MONEY },
  ],
  rule: {
    transform: {
      expand: {
        mode: 'fixedFanOut',
        rows: [
          { set: { side: '"Debit"', signed: 'amount' } },
          { set: { side: '"Credit"', signed: 'neg(amount)' } },
        ],
      },
    },
  },
});

export const ROW_OPS: CatalogueType[] = [filterByValue, filterNumeric, filterNotEmpty, filterExpr, dedupeAll, dedupeKeyLast, splitRows, columnsToRows, pivot, groupSummary, sortRows, totalsRow, groupSubtotals, fixedFanOut];
