// Six STRESS cases: "where can the whole process break?". Built by `build.ts` together with the others (same strategy as buildHard.ts:
// a seeded generator, the example and next-month outputs produced by the real engine from a reference rules file; see README.md).
//
//   broken-values            missing and broken cells (empty, "N/A", an amount as text, an impossible date, a date in another format,
//                            padded names, a duplicate row); next month brings NEW kinds of broken cells
//   running-balance          a value computed ACROSS rows: a balance per account in date order, rows not in date order in the file
//   cancel-and-dedupe        rows DROPPED by the rules: cancelled orders, and only the latest version of an order that appears twice
//   messy-layout-he          a messy Hebrew sheet: title lines, a merged title, a hidden column, a footer row, ID numbers that lost their zeros
//   dates-mixed-formats      one Date column in four formats (real dates, day/month text, ISO text, Hebrew month name), amounts as text
//   region-report-subtotals  a flat list becomes a report: a title from the data, sorted groups, a summary row and a blank row per group,
//                            a grand total
//
// Every case has a next-month pair, `difficulty: 'stress'`, and a reference rules file that reproduces BOTH outputs byte for byte (so
// `verify-cases` needs no exception field). Where the rules language is only just enough, the DECISION comments say how.
import type { Expr, LearnResult } from '@formatai/shared';
import { makeValidIsraeliId } from '@formatai/engine';
import { mkRules, runConvert, type CaseSpec, type FileArtifact } from './lib/caseKit';
import { dateCell, padNum, writeFixture, type Cell, type RowSpec } from './lib/fixtures';
import { chance, makeRng, pick, randAmount, randInt, shuffle, type Rng } from './lib/prng';

const hdr = (cells: string[]): RowSpec => ({ cells });
const rows = (data: Cell[][]): RowSpec[] => data.map((cells) => ({ cells }));

async function toArtifact(spec: Parameters<typeof writeFixture>[0]): Promise<FileArtifact> {
  return { ext: spec.file?.type ?? 'xlsx', bytes: await writeFixture(spec) };
}

async function convertedArtifact(rules: ReturnType<typeof mkRules>, input: FileArtifact): Promise<FileArtifact> {
  return { ext: rules.output.file?.type ?? 'xlsx', bytes: await runConvert(rules, input.bytes, `input.${input.ext}`) };
}

// Expression helpers (a column, a text constant) so the rules below read like the formulas they stand for.
const col = (id: string): Expr => ({ col: id });
const text = (value: string): Expr => ({ const: value });
const num = (value: number): Expr => ({ const: value });

const COMPANIES = [
  'Acme Corp', 'Globex', 'Initech', 'Umbrella Ltd', 'Hooli', 'Stark Supply', 'Wayne Tools', 'Wonka Foods', 'Soylent Co', 'Vandelay Imports',
  'Pied Piper', 'Cyberdyne', 'Tyrell Parts', 'Oscorp', 'Aperture Labs', 'Massive Dynamic', 'Gringotts Ltd', 'Dunder Supply', 'Bluth Homes', 'Sterling Trade',
  'Monarch Metals', 'Prestige Paper', 'Rosewood Foods', 'Kestrel Marine', 'Summit Cables', 'Harbor Freight Co', 'Lakeside Glass', 'Ironwood Steel', 'Bright Path Tools', 'Cedar Mills',
];

// ===========================================================================
// broken-values (stress, English LTR): missing and broken cells; the duplicate stays
// DECISION: a column of numbers or dates that holds a few unreadable cells is read as TEXT and converted by a computed column
// (`toNumber`, `toDate`). The engine's other way, a `decimal` / `date` input column, KEEPS an unreadable value as it is and flags it, so
// "N/A" would reach the output as the text "N/A"; here a person left such a cell EMPTY, and `toNumber` / `toDate` do exactly that (empty,
// plus a flag). Real dates and numbers pass through both functions, so the only rule about the data is the one the file shows.
// ===========================================================================

interface BrokenPatch {
  /** Row position (0-based, among the generated rows, before the duplicate is inserted). */
  at: number;
  /** Column position: 0 Order ID, 1 Customer, 2 Amount, 3 Order Date, 4 Status. */
  column: number;
  value: Cell | ((old: Cell) => Cell);
}
interface BrokenPlan {
  n: number;
  startId: number;
  month: number;
  daysInMonth: number;
  patches: BrokenPatch[];
  /** Rows where only the Order ID stays filled. */
  onlyIdAt: number[];
  /** An exact copy of row `of`, inserted at position `insertAt` (in the final order). */
  duplicate?: { of: number; insertAt: number };
}

function genBrokenRows(rng: Rng, plan: BrokenPlan): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < plan.n; i++) {
    out.push([
      `ORD-${padNum(plan.startId + i, 5)}`,
      pick(rng, COMPANIES),
      randAmount(rng, 20, 4800),
      dateCell(2026, plan.month, randInt(rng, 1, plan.daysInMonth)),
      pick(rng, ['Paid', 'Paid', 'Open', 'Shipped']),
    ]);
  }
  for (const p of plan.patches) {
    const row = out[p.at]!;
    row[p.column] = typeof p.value === 'function' ? p.value(row[p.column] ?? null) : p.value;
  }
  for (const at of plan.onlyIdAt) {
    const row = out[at]!;
    for (let c = 1; c < row.length; c++) row[c] = null;
  }
  if (plan.duplicate) {
    if (plan.patches.some((p) => p.at === plan.duplicate!.of) || plan.onlyIdAt.includes(plan.duplicate.of)) throw new Error('broken-values: the duplicated row is itself broken');
    out.splice(plan.duplicate.insertAt, 0, [...out[plan.duplicate.of]!]);
  }
  return out;
}

/** A name with spaces around it, as typed into a form. */
const padded = (left: number, right: number) => (old: Cell): Cell => `${' '.repeat(left)}${String(old)}${' '.repeat(right)}`;

async function buildBrokenValues(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'orderId', header: 'Order ID', type: 'idLike', required: true },
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'text' },
        { id: 'orderDate', header: 'Order Date', type: 'text' },
        { id: 'status', header: 'Status', type: 'text' },
      ],
    },
    transform: {
      computed: [
        { id: 'customerClean', type: 'text', expr: { op: 'trim', arg: col('customer') } },
        // "1,250.00 ₪" is read as 1250; "N/A", "-", "1.250,00" are not numbers: empty and flagged (never guessed).
        { id: 'amountNum', type: 'decimal', expr: { op: 'toNumber', arg: col('amount') } },
        // A real date passes through; text is read as ISO when it has a "-", else day first. An impossible one (31/02, month 13): empty and flagged.
        {
          id: 'orderDateRead',
          type: 'date',
          expr: {
            op: 'if',
            cond: { op: 'contains', arg: col('orderDate'), text: '-' },
            then: { op: 'toDate', arg: col('orderDate'), format: 'YYYY-MM-DD' },
            else: { op: 'toDate', arg: col('orderDate'), format: 'D/M/YYYY' },
          },
        },
      ],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Orders (cleaned)',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Order', from: 'orderId' },
        { header: 'Customer', from: 'customerClean' },
        { header: 'Amount', from: 'amountNum', format: '#,##0.00' },
        { header: 'Order Date', from: 'orderDateRead', format: 'DD/MM/YYYY' },
        { header: 'Status', from: 'status' },
      ],
    },
    // What is missing or odd is shown at run time, not repaired: a missing Customer, a negative amount. (An unreadable Amount or date is already
    // flagged by `toNumber` / `toDate`; a second "required" flag on the same cell would only repeat it.)
    validations: [
      { column: 'customerClean', rule: 'required', severity: 'flag' },
      { column: 'amountNum', rule: 'range', min: 0, severity: 'flag' },
    ],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Orders export -> cleaned orders', rulesBody);
  const header = hdr(['Order ID', 'Customer', 'Amount', 'Order Date', 'Status']);

  // The example: 119 orders + 1 exact duplicate = 120 rows. Broken on purpose: 2 empty Customers, an Amount "N/A", an empty Amount, an Amount as
  // text with a currency sign, an impossible date, a date as ISO text (all other dates are real Excel dates), 3 names with spaces around them.
  const rng = makeRng('broken-values');
  const input = await toArtifact({
    name: 'Orders',
    rows: [
      header,
      ...rows(
        genBrokenRows(rng, {
          n: 119,
          startId: 1001,
          month: 3,
          daysInMonth: 31,
          patches: [
            { at: 17, column: 1, value: null },
            { at: 64, column: 1, value: null },
            { at: 29, column: 2, value: 'N/A' },
            { at: 53, column: 2, value: null },
            { at: 78, column: 2, value: '1,250.00 ₪' },
            { at: 41, column: 3, value: '31/02/2026' },
            { at: 90, column: 3, value: '2026-03-05' },
            { at: 8, column: 1, value: padded(2, 0) },
            { at: 36, column: 1, value: padded(0, 3) },
            { at: 95, column: 1, value: padded(1, 1) },
          ],
          onlyIdAt: [],
          duplicate: { of: 22, insertAt: 105 },
        }),
      ),
    ],
  });
  const output = await convertedArtifact(referenceRules, input);

  // Next month: 100 rows with NEW kinds of broken cells ("-" and "1.250,00" as an Amount, a month-first date, a negative Amount, a row with only
  // the Order ID), plus a few kinds the example already showed (names with spaces, an empty Customer, an Amount with a currency sign).
  const nextRng = makeRng('broken-values-next');
  const nextInput = await toArtifact({
    name: 'Orders',
    rows: [
      header,
      ...rows(
        genBrokenRows(nextRng, {
          n: 100,
          startId: 2001,
          month: 4,
          daysInMonth: 30,
          patches: [
            { at: 12, column: 2, value: '—' },
            { at: 33, column: 3, value: '12/13/2026' },
            { at: 58, column: 2, value: -50 },
            { at: 81, column: 2, value: '1.250,00' },
            { at: 20, column: 2, value: '2,400.00 ₪' },
            { at: 5, column: 1, value: padded(1, 2) },
            { at: 66, column: 1, value: padded(0, 1) },
            { at: 90, column: 1, value: null },
          ],
          onlyIdAt: [45],
        }),
      ),
    ],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'broken-values',
    meta: {
      difficulty: 'stress',
      domain: 'salesOrders',
      features: ['emptyCells', 'unreadableAmount', 'amountAsTextWithCurrency', 'impossibleDate', 'dateAsIsoText', 'paddedNames', 'duplicateRowStays', 'newBrokenKindsNextMonth', 'flagNotGuess'],
      expect: 'verified',
      expectNote:
        'the cleanup is learned (names trimmed, "1,250.00 ₪" read as 1250, an ISO text date read as a date, a duplicate row left in, a cell nobody can read left EMPTY); next month\'s new broken cells ("-" or "1.250,00" as an Amount, the date "12/13/2026", a negative Amount, a row with only the Order ID) are flagged for review, not guessed. May break: the unreadable cell is kept as text instead of left empty, or guessed ("1.250,00" as 1250, "12/13/2026" as 13 December), or the whole row is dropped.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// running-balance (stress, English LTR): a value computed across rows
// DECISION: `runningSum` takes a column id, not a calculation, so the net movement (Credit - Debit) is a computed column of its own. An empty
// Debit or Credit counts as 0 in a subtraction, so a row with only one of them needs no special rule. Rows with the same Date keep file order
// (the window's tie rule and the stable sort agree), which is the order the balance is built in.
// ===========================================================================

const ACCOUNTS = ['ACC-101', 'ACC-102', 'ACC-103', 'ACC-104'];
const CREDIT_TEXT = ['Deposit', 'Transfer in', 'Refund', 'Customer payment', 'Interest'];
const DEBIT_TEXT = ['Supplies', 'Service fee', 'Subscription', 'Utilities', 'Supplier payment', 'Transfer out'];

function genLedgerRows(rng: Rng, n: number, month: number, daysInMonth: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const credit = chance(rng, 0.45);
    const amount = credit ? randAmount(rng, 200, 3000) : randAmount(rng, 20, 900);
    // The file is NOT in date order: every row is drawn independently.
    out.push([pick(rng, ACCOUNTS), dateCell(2026, month, randInt(rng, 1, daysInMonth)), pick(rng, credit ? CREDIT_TEXT : DEBIT_TEXT), credit ? null : amount, credit ? amount : null]);
  }
  return out;
}

async function buildRunningBalance(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'account', header: 'Account', type: 'text', required: true },
        { id: 'date', header: 'Date', type: 'date', required: true },
        { id: 'description', header: 'Description', type: 'text' },
        { id: 'debit', header: 'Debit', type: 'decimal' },
        { id: 'credit', header: 'Credit', type: 'decimal' },
      ],
    },
    transform: {
      computed: [
        { id: 'net', type: 'decimal', expr: { op: 'sub', args: [col('credit'), col('debit')] } },
        {
          id: 'balance',
          type: 'decimal',
          expr: { op: 'window', fn: 'runningSum', arg: col('net'), by: ['account'], order: [{ column: 'date', dir: 'asc' }] },
        },
      ],
      valueMaps: [],
      sort: [
        { column: 'account', dir: 'asc' },
        { column: 'date', dir: 'asc' },
      ],
    },
    output: {
      sheetName: 'Ledger with balance',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Account', from: 'account' },
        { header: 'Date', from: 'date', format: 'DD/MM/YYYY' },
        { header: 'Description', from: 'description' },
        { header: 'Debit', from: 'debit', format: '#,##0.00' },
        { header: 'Credit', from: 'credit', format: '#,##0.00' },
        { header: 'Balance', from: 'balance', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Ledger -> ledger with running balance', rulesBody);
  const header = hdr(['Account', 'Date', 'Description', 'Debit', 'Credit']);

  const rng = makeRng('running-balance');
  const input = await toArtifact({ name: 'Ledger', rows: [header, ...rows(genLedgerRows(rng, 150, 1, 31))] });
  const output = await convertedArtifact(referenceRules, input);

  // Next month: a fresh month (the balance of every account starts from 0 again, nothing carries over).
  const nextRng = makeRng('running-balance-next');
  const nextInput = await toArtifact({ name: 'Ledger', rows: [header, ...rows(genLedgerRows(nextRng, 130, 2, 28))] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'running-balance',
    meta: {
      difficulty: 'stress',
      domain: 'ledger',
      features: ['runningSumPerGroup', 'acrossRows', 'dateOrderNotFileOrder', 'tiesKeepFileOrder', 'creditMinusDebit', 'sortedOutput', 'freshStartNextMonth'],
      expect: 'verified',
      expectNote:
        'Balance = the running sum of (Credit - Debit) per account, in DATE order (rows with the same date keep file order), and the rows sorted by Account then Date. Next month every account starts from 0 again. May break: the sum is taken in file order (the file is not in date order), over all accounts together, or the rows are left in file order.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// cancel-and-dedupe (stress, English LTR): rows dropped by rules
// DECISION: the rules language keeps the FIRST or the LAST row of a duplicate in file order (`dedupe.keep`), and the sort runs after the
// dedupe, so "keep the row with the latest Updated At" is only expressible when the file lists the versions of an order oldest first. This
// file is an export in Updated At order (oldest first), the way a change log is, so "the last row of an order" IS "the latest Updated At". A
// file that is NOT in Updated At order has no rule at all (there is no "keep the latest by a column"); this case does not test that.
// The row filter runs BEFORE the dedupe: a Cancelled row never competes for "latest", so no order here is both cancelled and duplicated.
// ===========================================================================

interface OrdersPlan {
  /** Distinct orders. */
  orders: number;
  cancelled: number;
  /** Orders that appear twice / three times (never a cancelled order). */
  pairs: number;
  triples: number;
  startId: number;
  month: number;
  daysInMonth: number;
}

function genDedupeRows(rng: Rng, plan: OrdersPlan): Cell[][] {
  const ids = Array.from({ length: plan.orders }, (_, i) => i);
  const shuffled = shuffle(rng, ids);
  const cancelled = new Set(shuffled.slice(0, plan.cancelled));
  const repeated = shuffled.slice(plan.cancelled, plan.cancelled + plan.pairs + plan.triples);
  const versionsOf = new Map(repeated.map((o, k) => [o, k < plan.triples ? 3 : 2]));
  const entries: { day: number; seq: number; cells: Cell[] }[] = [];
  let seq = 0;
  for (const o of ids) {
    const orderId = `ORD-${padNum(plan.startId + o, 5)}`;
    const customer = pick(rng, COMPANIES);
    const versions = versionsOf.get(o) ?? 1;
    if (versions === 1) {
      const status = cancelled.has(o) ? 'Cancelled' : pick(rng, ['Open', 'Shipped', 'Paid']);
      entries.push({ day: randInt(rng, 1, plan.daysInMonth), seq: seq++, cells: [orderId, customer, randAmount(rng, 30, 2500), status, null] });
      continue;
    }
    // An order that was changed: each version has a later Updated At, a different Status and a revised Amount.
    let day = randInt(rng, 1, plan.daysInMonth - 6 * (versions - 1));
    let amount = randAmount(rng, 30, 2500);
    const statuses = ['Open', 'Shipped', 'Paid'];
    for (let v = 0; v < versions; v++) {
      entries.push({ day, seq: seq++, cells: [orderId, customer, amount, statuses[v]!, null] });
      day += randInt(rng, 2, 6);
      amount = Math.round((amount + randAmount(rng, 5, 300)) * 100) / 100;
    }
  }
  // The file is in Updated At order, oldest first (ties: the order the rows were made in).
  entries.sort((a, b) => a.day - b.day || a.seq - b.seq);
  return entries.map((e) => {
    const cells = [...e.cells];
    cells[4] = dateCell(2026, plan.month, e.day);
    return cells;
  });
}

async function buildCancelAndDedupe(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'orderId', header: 'Order ID', type: 'idLike', required: true },
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
        { id: 'status', header: 'Status', type: 'text', required: true },
        { id: 'updatedAt', header: 'Updated At', type: 'date', required: true },
      ],
      // "ne Cancelled", not an allow-list of today's statuses: a status next month's file shows for the first time must stay.
      rowFilters: [{ column: 'status', op: 'ne', value: 'Cancelled' }],
    },
    transform: {
      dedupe: { keys: ['orderId'], keep: 'last', action: 'remove' },
      computed: [],
      valueMaps: [],
      sort: [{ column: 'orderId', dir: 'asc' }],
    },
    output: {
      sheetName: 'Open orders',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Order ID', from: 'orderId' },
        { header: 'Customer', from: 'customer' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
        { header: 'Status', from: 'status' },
        { header: 'Updated At', from: 'updatedAt', format: 'DD/MM/YYYY' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Order log -> current orders', rulesBody);
  const header = hdr(['Order ID', 'Customer', 'Amount', 'Status', 'Updated At']);

  // The example: 190 orders, 15 of them Cancelled, 10 of the others twice (200 rows); 175 rows come out.
  const rng = makeRng('cancel-and-dedupe');
  const input = await toArtifact({
    name: 'Orders',
    rows: [header, ...rows(genDedupeRows(rng, { orders: 190, cancelled: 15, pairs: 10, triples: 0, startId: 1001, month: 3, daysInMonth: 31 }))],
  });
  const output = await convertedArtifact(referenceRules, input);

  // Next month, a different mix: more cancelled orders (22), fewer repeated ones (7 twice) and one order that appears three times.
  const nextRng = makeRng('cancel-and-dedupe-next');
  const nextInput = await toArtifact({
    name: 'Orders',
    rows: [header, ...rows(genDedupeRows(nextRng, { orders: 170, cancelled: 22, pairs: 7, triples: 1, startId: 5001, month: 4, daysInMonth: 30 }))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'cancel-and-dedupe',
    meta: {
      difficulty: 'stress',
      domain: 'salesOrders',
      features: ['filterNotEqual', 'dedupeKeepLatest', 'fileInDateOrder', 'rowsDropped', 'sortedOutput', 'newMixNextMonth'],
      expect: 'verified',
      expectNote:
        'the Cancelled rows are dropped; of an order that appears more than once only the row with the LATEST Updated At stays (the file lists the versions oldest first, so that is the last row of the order); the rows are sorted by Order ID. Next month: more cancelled rows, fewer repeated orders and one order that appears three times. May break: a repeated order keeps its FIRST row, every row of a repeated order is dropped, or a Cancelled row survives.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// messy-layout-he (stress, Hebrew RTL): a messy sheet a person received
// ===========================================================================

const HE_FIRST = ['דנה', 'יוסי', 'מאיה', 'עומר', 'שירה', 'אבי', 'נועה', 'תומר', 'רותם', 'אלי', 'גל', 'מיכל', 'רון', 'ליאור', 'הילה', 'אורי'];
const HE_LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אזולאי', 'דהן', 'אברהם', 'גבאי', 'חדד', 'אוחיון', 'מלכה'];
const VAT_RATE = 0.18;

interface HebrewRow {
  id: number;
  name: string;
  internalCode: string;
  amount: number;
}

/** `n` customers; the ID is a valid Israeli ID kept as a NUMBER, so one in four lost a leading zero (some two: 7 digits). */
function genHebrewSales(rng: Rng, n: number, startCode: number): HebrewRow[] {
  const out: HebrewRow[] = [];
  const used = new Set<number>();
  for (let i = 0; i < n; i++) {
    let id: number;
    do {
      const r = rng();
      const seed = r < 0.25 ? (r < 0.07 ? randInt(rng, 100000, 999999) : randInt(rng, 1000000, 9999999)) : randInt(rng, 10000000, 99999999);
      id = Number(makeValidIsraeliId(padNum(seed, 8)));
    } while (used.has(id));
    used.add(id);
    out.push({ id, name: `${pick(rng, HE_FIRST)} ${pick(rng, HE_LAST)}`, internalCode: `K-${padNum(startCode + i, 4)}`, amount: randAmount(rng, 150, 9800) });
  }
  return out;
}

function hebrewSheetRows(data: HebrewRow[], producedOn: string): RowSpec[] {
  const total = Math.round(data.reduce((s, r) => s + Math.round(r.amount * 100), 0)) / 100;
  return [
    { cells: [{ v: 'דוח מכירות', bold: true }, null, null, null] },
    { cells: [`תאריך הפקה: ${producedOn}`] },
    { cells: [] },
    { cells: ['ת.ז.', 'שם', 'קוד פנימי', 'סכום'], bold: true },
    ...data.map((r) => ({ cells: [r.id, r.name, r.internalCode, r.amount] as Cell[] })),
    { cells: [{ v: 'סה"כ', bold: true }, null, null, { v: total, bold: true }] },
  ];
}

async function buildMessyLayoutHe(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      // The footer line: everything from the row that starts with "סה"כ" down is not data.
      stopAt: { when: 'firstCellMatches', values: ['סה"כ'] },
      // The hidden column ("קוד פנימי") is in the file but not declared: an undeclared column is never read.
      columns: [
        { id: 'idNumber', header: 'ת.ז.', type: 'idLike', padLeft: 9, required: true },
        { id: 'name', header: 'שם', type: 'text', required: true },
        { id: 'amount', header: 'סכום', type: 'decimal', required: true },
      ],
    },
    transform: {
      computed: [{ id: 'vat', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [col('amount'), num(VAT_RATE)] } } }],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'מכירות',
      direction: 'rtl',
      language: 'he',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'ת.ז.', from: 'idNumber' },
        { header: 'שם', from: 'name' },
        { header: 'סכום', from: 'amount', format: '#,##0.00' },
        { header: 'מע"מ', from: 'vat', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('דוח מכירות -> טבלה נקייה עם מע"מ', rulesBody);
  const sheet = (data: HebrewRow[], producedOn: string): Parameters<typeof writeFixture>[0] => ({
    name: 'מכירות',
    direction: 'rtl',
    language: 'he',
    rows: hebrewSheetRows(data, producedOn),
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }],
    hiddenCols: [2],
  });

  const rng = makeRng('messy-layout-he');
  const input = await toArtifact(sheet(genHebrewSales(rng, 40, 100), '05/04/2026'));
  const output = await convertedArtifact(referenceRules, input);

  // Next month: the same layout with new rows (a different count, other IDs and amounts, another production date).
  const nextRng = makeRng('messy-layout-he-next');
  const nextInput = await toArtifact(sheet(genHebrewSales(nextRng, 34, 500), '03/05/2026'));
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'messy-layout-he',
    meta: {
      difficulty: 'stress',
      domain: 'salesReport',
      features: ['titleRowsAboveHeader', 'mergedTitle', 'blankLineBeforeHeader', 'hiddenColumn', 'footerTotals', 'leadingZerosLost', 'israeliId', 'vatColumn', 'rtl', 'newRowsNextMonth'],
      expect: 'verified',
      expectNote:
        'the table is found under 3 title lines (a merged title, a production-date line, a blank line) with the header on row 4; the hidden column and the footer row ("סה"כ" with totals) are not data; the ID numbers, stored as numbers, get their leading zeros back (9-digit text); a new column מע"מ = סכום x 0.18 rounded to 2 decimals is added. May break: the header row is not found (a blank line inside the title block reads as the end of a table), the footer total is read as a customer, an 8-digit ID stays 8 digits.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// dates-mixed-formats (stress, English LTR with Hebrew month names): reading ambiguity
// DECISION: the Date column is read as TEXT (a real Excel date stays a date in a text column) and one computed column reads it: ISO text has a
// "-", Hebrew month-name text has a space, anything else is day/month text; `toDate` lets a real date pass through. `inputFormats` cannot do
// this (no month names, and it keeps an unreadable value as text). Day/month, never month/day, is Israeli practice and what the example's
// output shows; its text dates are ALL ambiguous (day and month both 12 or less), and next month's "13/04/2026" proves the order.
// ===========================================================================

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const REFERENCE_CUSTOMERS = COMPANIES.slice(0, 12);

const p2 = (n: number): string => String(n).padStart(2, '0');
const withThousands = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type DateStyle = 'excel' | 'dayMonthText' | 'isoText' | 'hebrewText';

interface MixedDatesPlan {
  month: number;
  daysInMonth: number;
  /** How many rows use each way of writing the date. */
  counts: Record<DateStyle, number>;
  /** The days a day/month text date may have: 12 in the example (so every one is ambiguous), the whole month next month. */
  textDayMax: number;
  /** Day/month text dates that must be there (their days), e.g. 13 and 21 next month. */
  forcedTextDays: number[];
  startId: number;
}

function genMixedDateRows(rng: Rng, plan: MixedDatesPlan): Cell[][] {
  const styles = shuffle(rng, (Object.keys(plan.counts) as DateStyle[]).flatMap((s) => Array.from({ length: plan.counts[s] }, () => s)));
  if (plan.counts.dayMonthText < plan.forcedTextDays.length) throw new Error('dates-mixed-formats: too few day/month text rows for the forced days');
  const forced = [...plan.forcedTextDays];
  return styles.map((style, i): Cell[] => {
    let date: Cell;
    if (style === 'excel') date = dateCell(2026, plan.month, randInt(rng, 1, plan.daysInMonth));
    else if (style === 'dayMonthText') date = `${p2(forced.shift() ?? randInt(rng, 1, plan.textDayMax))}/${p2(plan.month)}/2026`;
    else if (style === 'isoText') date = `2026-${p2(plan.month)}-${p2(randInt(rng, 1, plan.daysInMonth))}`;
    else date = `${randInt(rng, 1, plan.daysInMonth)} ב${HE_MONTHS[plan.month - 1]} 2026`;
    return [`REF-${padNum(plan.startId + i, 4)}`, pick(rng, REFERENCE_CUSTOMERS), date, withThousands(randAmount(rng, 40, 6500))];
  });
}

async function buildDatesMixedFormats(): Promise<CaseSpec> {
  const readDate: Expr = {
    op: 'if',
    cond: { op: 'contains', arg: col('date'), text: '-' },
    then: { op: 'toDate', arg: col('date'), format: 'YYYY-MM-DD' },
    else: {
      op: 'if',
      cond: { op: 'contains', arg: col('date'), text: ' ' },
      then: { op: 'toDate', arg: col('date'), format: 'D בMMMM YYYY' },
      else: { op: 'toDate', arg: col('date'), format: 'D/M/YYYY' },
    },
  };
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'reference', header: 'Reference', type: 'idLike', required: true },
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'date', header: 'Date', type: 'text', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
      ],
    },
    transform: {
      computed: [
        { id: 'dateRead', type: 'date', expr: readDate },
        { id: 'dateText', type: 'text', expr: { op: 'dateFormat', arg: col('dateRead'), format: 'YYYY-MM-DD' } },
        { id: 'period', type: 'text', expr: { op: 'dateFormat', arg: col('dateRead'), format: 'MM/YYYY' } },
      ],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Payments',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Reference', from: 'reference' },
        { header: 'Customer', from: 'customer' },
        { header: 'Date', from: 'dateText' },
        { header: 'Period', from: 'period' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Payments export -> payments with period', rulesBody);
  const header = hdr(['Reference', 'Customer', 'Date', 'Amount']);

  // The example (March 2026, 60 rows): 18 real dates, 18 day/month text dates (day AND month 12 or less: each one reads two ways), 12 ISO text,
  // 12 Hebrew month-name text. Amounts are text with thousands separators.
  const rng = makeRng('dates-mixed-formats');
  const input = await toArtifact({
    name: 'Payments',
    rows: [header, ...rows(genMixedDateRows(rng, { month: 3, daysInMonth: 31, counts: { excel: 18, dayMonthText: 18, isoText: 12, hebrewText: 12 }, textDayMax: 12, forcedTextDays: [], startId: 1 }))],
  });
  const output = await convertedArtifact(referenceRules, input);

  // Next month (April 2026, 50 rows): day/month text with days over 12, "13/04/2026" among them.
  const nextRng = makeRng('dates-mixed-formats-next');
  const nextInput = await toArtifact({
    name: 'Payments',
    rows: [header, ...rows(genMixedDateRows(nextRng, { month: 4, daysInMonth: 30, counts: { excel: 15, dayMonthText: 15, isoText: 10, hebrewText: 10 }, textDayMax: 30, forcedTextDays: [13, 21, 28], startId: 501 }))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'dates-mixed-formats',
    meta: {
      difficulty: 'stress',
      domain: 'payments',
      features: ['mixedDateFormats', 'ddmmVsMmdd', 'hebrewMonthName', 'dateAsIsoText', 'excelDates', 'amountAsTextWithThousands', 'newColumnFromDate', 'ambiguityProvedNextMonth'],
      expect: 'verified',
      expectNote:
        'every Date is read whatever its format (a real date, day/month text like "05/03/2026", ISO text, Hebrew month-name text like "12 במרץ 2026") and written as text yyyy-mm-dd; a Period column "03/2026" is added; Amount is a number. In the example every day/month text is ambiguous (both parts 12 or less); the answer is day/month, which next month\'s "13/04/2026" proves. May break: day/month read as month/day, the Hebrew month-name dates left as text, a real date written as its serial number.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// region-report-subtotals (stress, English LTR): a complex output layout
// ===========================================================================

const REGION_REPS: Record<string, string[]> = {
  North: ['Dana Levi', 'Omer Katz', 'Shira Peretz', 'Avi Dahan'],
  South: ['Noa Mizrahi', 'Tomer Bitton', 'Rotem Azoulay'],
  East: ['Eli Gabbay', 'Gal Haddad', 'Michelle Cohen', 'Ron Abraham'],
  West: ['Lior Miller', 'Hila Brown', 'Ori Davis'],
};

function genRegionRows(rng: Rng, n: number, month: number, daysInMonth: number): Cell[][] {
  const regions = Object.keys(REGION_REPS);
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const region = pick(rng, regions);
    out.push([region, pick(rng, REGION_REPS[region]!), randAmount(rng, 120, 9000), dateCell(2026, month, randInt(rng, 1, daysInMonth))]);
  }
  return out;
}

async function buildRegionReport(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'region', header: 'Region', type: 'text', required: true },
        { id: 'rep', header: 'Rep', type: 'text', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
        { id: 'date', header: 'Date', type: 'date', required: true },
      ],
    },
    transform: {
      computed: [],
      valueMaps: [],
      sort: [
        { column: 'region', dir: 'asc' },
        { column: 'amount', dir: 'desc' },
      ],
      group: {
        by: 'region',
        showDetailRows: true,
        blankRowsAfter: 1,
        summaryRows: [{ label: 'Region total', labelColumn: 'Region', bold: true, cells: { 'Sales rep': 'count', Amount: 'sum' } }],
      },
    },
    output: {
      sheetName: 'Sales by region',
      direction: 'ltr',
      language: 'en',
      headerStyle: { bold: true },
      // The month comes from the data (the latest Date), so next month's file gets next month's title.
      titleRows: [{ parts: [{ text: 'Sales by region - ' }, { agg: 'max', column: 'date', format: 'MMMM YYYY' }], bold: true }],
      columns: [
        { header: 'Region', from: 'region' },
        { header: 'Sales rep', from: 'rep' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
      ],
      summaryRows: [{ label: 'Grand total', labelColumn: 'Region', bold: true, cells: { 'Sales rep': 'count', Amount: 'sum' } }],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Sales list -> sales by region report', rulesBody);
  const header = hdr(['Region', 'Rep', 'Amount', 'Date']);

  // 80 flat rows in no particular order (March); next month 90 rows (April).
  const rng = makeRng('region-report-subtotals');
  const input = await toArtifact({ name: 'Sales', rows: [header, ...rows(genRegionRows(rng, 80, 3, 31))] });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('region-report-subtotals-next');
  const nextInput = await toArtifact({ name: 'Sales', rows: [header, ...rows(genRegionRows(nextRng, 90, 4, 30))] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'region-report-subtotals',
    meta: {
      difficulty: 'stress',
      domain: 'salesReport',
      features: ['titleFromData', 'renamedHeaders', 'sortTwoKeys', 'groupSummaryRows', 'countAndSum', 'blankRowAfterGroup', 'grandTotal', 'droppedColumn', 'newMonthNextMonth'],
      expect: 'verified',
      expectNote:
        'a flat list becomes a report: a title row "Sales by region - March 2026" (the month from the data\'s dates), the headers Region / Sales rep / Amount, the rows sorted by Region then Amount descending, after each region a summary row (the sum of Amount and the count of rows) and a blank row, and a grand total row at the end. Next month: April, so the title says April 2026. May break: the title is copied as text ("March 2026" again), a summary row or the blank row is missing, the count is not a count of rows, the Date column is kept.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

export const stressCaseBuilders: (() => Promise<CaseSpec>)[] = [
  buildBrokenValues,
  buildRunningBalance,
  buildCancelAndDedupe,
  buildMessyLayoutHe,
  buildDatesMixedFormats,
  buildRegionReport,
];
