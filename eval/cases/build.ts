#!/usr/bin/env -S pnpm exec tsx
// Generates every eval case under eval/cases/<name>/ (SPEC 10). Deterministic:
// every case seeds its own PRNG from its name (lib/prng.ts), so re-running this
// script reproduces byte-identical fixtures.
//
// Strategy (see README.md for the full picture):
//   - For every case expected to verify, a `reference.rules.json` is written and
//     the "hand-made" output.* is produced by running the real engine pipeline
//     (`convertFile`, via lib/caseKit.ts's `runConvert`) on the input.* this
//     script built - so the example output is exactly what the engine would
//     produce, not a hand-simulated approximation. The same rules are then run
//     again on a freshly generated "next month" input to produce the next.*
//     hold-out pair the future runner checks generalization against (SPEC 10).
//   - The two cases the rules language cannot express at all (a pivot; an
//     output column from a source outside the input) have no reference rules:
//     their output.* is built directly with lib/fixtures.ts, exactly as a human
//     would have made it by hand, and they carry no next.* pair (they never
//     reach "verified").
//
// Run with: pnpm --filter @formatai/eval exec tsx cases/build.ts
import type { LearnResult } from '@formatai/shared';
import type { OutputFileSpec } from '@formatai/engine';
import { makeValidIsraeliId } from '@formatai/engine';
import { casesRoot, mkRules, runConvert, writeCase, type CaseSpec, type FileArtifact } from './lib/caseKit';
import { dateCell, ddmmyyyy, padNum, writeFixture, type Cell, type RowSpec } from './lib/fixtures';
import { chance, makeRng, pick, randAmount, randInt, shuffle, type Rng } from './lib/prng';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function hdr(cells: string[]): RowSpec {
  return { cells };
}
function rows(data: Cell[][]): RowSpec[] {
  return data.map((cells) => ({ cells }));
}

async function toArtifact(spec: Parameters<typeof writeFixture>[0]): Promise<FileArtifact> {
  const bytes = await writeFixture(spec);
  const ext = spec.file?.type ?? 'xlsx';
  return { ext, bytes };
}

async function convertedArtifact(
  rules: ReturnType<typeof mkRules>,
  input: FileArtifact,
  fileOverride?: OutputFileSpec,
): Promise<FileArtifact> {
  const bytes = await runConvert(rules, input.bytes, `input.${input.ext}`, fileOverride);
  const ext = (fileOverride ?? rules.output.file)?.type ?? 'xlsx';
  return { ext, bytes };
}

// ---------------------------------------------------------------------------
// Word pools (kept small and readable; uniqueness of *keys* is handled by
// sequential counters in each case, not by these pools)
// ---------------------------------------------------------------------------

const EN_FIRST = [
  'Dana', 'Yossi', 'Maya', 'Omer', 'Shira', 'Avi', 'Noa', 'Tomer', 'Rotem', 'Eli',
  'Gal', 'Michelle', 'Ron', 'Lior', 'Hila', 'Ori', 'Tal', 'Naomi', 'Yuval', 'Shani',
  'James', 'Laura', 'Kevin', 'Maria', 'Daniel', 'Sara', 'Peter', 'Anna', 'Mark', 'Julia',
];
const EN_LAST = [
  'Cohen', 'Levi', 'Mizrahi', 'Peretz', 'Bitton', 'Azoulay', 'Dahan', 'Abraham', 'Gabbay', 'Haddad',
  'Miller', 'Johnson', 'Smith', 'Brown', 'Davis', 'Wilson', 'Taylor', 'Clark', 'Walker', 'Young',
];
const HE_FIRST = [
  'דנה', 'יוסי', 'מאיה', 'עומר', 'שירה', 'אבי', 'נועה', 'תומר', 'רותם', 'אלי',
  'גל', 'מיכל', 'רון', 'ליאור', 'הילה', 'אורי', 'טל', 'נעמה', 'יובל', 'שני',
];
const HE_LAST = [
  'כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אזולאי', 'דהן', 'אברהם', 'גבאי', 'חדד',
  'אוחיון', 'מלכה', 'שרעבי', 'קדוש', 'נחמיאס',
];
const CITIES = ['Austin', 'Denver', 'Miami', 'Seattle', 'Boston', 'Phoenix', 'Chicago', 'Atlanta'];
const HE_TOOLS = ['פטיש', 'מברגה', 'פלס', 'מסור', 'סרגל', 'פלייר', 'מקדח', 'סולם', 'פינצטה', 'מגרסה', 'מברג', 'אזמל'];

function fullName(rng: Rng, lang: 'en' | 'he'): [string, string] {
  return lang === 'en' ? [pick(rng, EN_FIRST), pick(rng, EN_LAST)] : [pick(rng, HE_FIRST), pick(rng, HE_LAST)];
}

// ===========================================================================
// Case 1: crm-rename-reorder (easy, English LTR, fast path)
// ===========================================================================

function genCrmRows(rng: Rng, n: number, startId: number, extraStatus?: string): Cell[][] {
  const statuses = extraStatus ? ['Active', 'Inactive', 'Lead', 'Churned', extraStatus] : ['Active', 'Inactive', 'Lead', 'Churned'];
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const [first, last] = fullName(rng, 'en');
    const id = `C-${padNum(startId + i, 4)}`;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@example.com`;
    const phone = `555-01${padNum(randInt(rng, 0, 99), 2)}`;
    const city = pick(rng, CITIES);
    // The very last row of the "next" batch carries a status never seen in the
    // base example (SPEC 10: "at least one value the example never showed").
    const status = i === n - 1 && extraStatus ? extraStatus : pick(rng, statuses.slice(0, 4));
    out.push([id, first, last, email, phone, city, status]);
  }
  return out;
}

async function buildCase01(): Promise<CaseSpec> {
  const header = ['Customer ID', 'First Name', 'Last Name', 'Email', 'Phone', 'City', 'Status'];
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'customerId', header: 'Customer ID', type: 'idLike', required: true },
        { id: 'firstName', header: 'First Name', type: 'text', required: true },
        { id: 'lastName', header: 'Last Name', type: 'text', required: true },
        { id: 'email', header: 'Email', type: 'text' },
        { id: 'phone', header: 'Phone', type: 'text' },
        { id: 'city', header: 'City', type: 'text' },
        { id: 'status', header: 'Status', type: 'text' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      file: { type: 'csv', header: true, encoding: 'utf8' },
      sheetName: 'CRM Import',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Contact ID', from: 'customerId' },
        { header: 'Last Name', from: 'lastName' },
        { header: 'First Name', from: 'firstName' },
        { header: 'Email Address', from: 'email' },
        { header: 'Phone', from: 'phone' },
        { header: 'Account Status', from: 'status' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('CRM import CSV', rulesBody);

  const rng = makeRng('crm-rename-reorder');
  const input = await toArtifact({
    name: 'Customers',
    file: { type: 'csv' },
    rows: [hdr(header), ...rows(genCrmRows(rng, 25, 1000))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('crm-rename-reorder-next');
  const nextInput = await toArtifact({
    name: 'Customers',
    file: { type: 'csv' },
    rows: [hdr(header), ...rows(genCrmRows(nextRng, 25, 2000, 'VIP'))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'crm-rename-reorder',
    meta: {
      difficulty: 'easy',
      domain: 'customerList',
      features: ['rename', 'reorder', 'dropColumns', 'fastPath', 'csvOutput', 'utf8'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 2: supplier-pricelist-erp-load (easy, Hebrew RTL, fast path)
// ===========================================================================

function genSupplierRows(rng: Rng, n: number): Cell[][] {
  const out: Cell[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < n; i++) {
    let code: number;
    do {
      code = randInt(rng, 1, 999999);
    } while (used.has(code));
    used.add(code);
    const name = pick(rng, HE_TOOLS);
    const cost = randAmount(rng, 2, 999.99);
    const status = chance(rng, 0.15) ? 'מופסק' : 'פעיל';
    out.push([code, name, cost, status]);
  }
  return out;
}

async function buildCase02(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      // "סטטוס" exists in the physical file (below) but is deliberately not
      // declared here at all: an undeclared column is simply never read
      // (mapHeaders only maps declared `input.columns`) - SPEC 10's "drop
      // columns" trait, demonstrated by omission rather than a filter.
      columns: [
        { id: 'itemCode', header: 'מקט', type: 'idLike', padLeft: 6, required: true },
        { id: 'description', header: 'תיאור', type: 'text', required: true },
        { id: 'cost', header: 'עלות', type: 'decimal', required: true },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      file: { type: 'txt', delimiter: '\t', header: false, encoding: 'windows1255' },
      sheetName: 'ERP_LOAD',
      direction: 'rtl',
      language: 'he',
      titleRows: [],
      columns: [
        { header: 'מקט', from: 'itemCode' },
        { header: 'תיאור פריט', from: 'description' },
        { header: 'עלות ליחידה', from: 'cost', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('מחירון ספק → טעינת קטלוג ERP', rulesBody);

  const rng = makeRng('supplier-pricelist-erp-load');
  const input = await toArtifact({
    name: 'מחירון',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מקט', 'תיאור', 'עלות', 'סטטוס']), ...rows(genSupplierRows(rng, 20))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('supplier-pricelist-erp-load-next');
  const nextInput = await toArtifact({
    name: 'מחירון',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מקט', 'תיאור', 'עלות', 'סטטוס']), ...rows(genSupplierRows(nextRng, 20))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'supplier-pricelist-erp-load',
    meta: {
      difficulty: 'easy',
      domain: 'supplierPriceList',
      features: ['rename', 'padLeft', 'leadingZerosLost', 'dropColumns', 'fastPath', 'txtOutput', 'noHeader', 'windows1255'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 3: bank-export-reconciliation (medium, English LTR)
// ===========================================================================

function genBankRows(rng: Rng, n: number, startId: number): Cell[][] {
  const out: Cell[][] = [];
  const descriptions = ['Wire transfer', 'Card payment', 'ATM withdrawal', 'Monthly fee', 'Interest credit', 'Check deposit'];
  for (let i = 0; i < n; i++) {
    const id = `TXN-${padNum(startId + i, 5)}`;
    // Force at least a few day>12 dates so DD/MM is the only reading that
    // parses at all (SPEC 17's DD/MM-vs-MM/DD trap).
    const day = i % 4 === 0 ? randInt(rng, 13, 28) : randInt(rng, 1, 28);
    const month = randInt(rng, 1, 12);
    const date = ddmmyyyy(2024, month, day);
    const desc = pick(rng, descriptions);
    const amount = randAmount(rng, 10, 5000);
    const negative = chance(rng, 0.4);
    const amountText = negative ? `(${amount.toFixed(2)})` : amount.toFixed(2);
    out.push([id, date, desc, amountText]);
  }
  return out;
}

async function buildCase03(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'txnId', header: 'Txn ID', type: 'idLike', required: true },
        { id: 'txnDate', header: 'Date', type: 'date', inputFormats: ['DD/MM/YYYY'], required: true },
        { id: 'description', header: 'Description', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      sheetName: 'Reconciliation',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Txn ID', from: 'txnId' },
        { header: 'Value Date', from: 'txnDate', format: 'YYYY-MM-DD' },
        { header: 'Description', from: 'description' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Bank export → reconciliation', rulesBody);

  const rng = makeRng('bank-export-reconciliation');
  const input = await toArtifact({
    name: 'Export',
    file: { type: 'csv' },
    rows: [hdr(['Txn ID', 'Date', 'Description', 'Amount']), ...rows(genBankRows(rng, 22, 1))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('bank-export-reconciliation-next');
  const nextInput = await toArtifact({
    name: 'Export',
    file: { type: 'csv' },
    rows: [hdr(['Txn ID', 'Date', 'Description', 'Amount']), ...rows(genBankRows(nextRng, 22, 500))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'bank-export-reconciliation',
    meta: {
      difficulty: 'medium',
      domain: 'bankExport',
      features: ['dateFormat', 'numberFormat', 'ddmmVsMmdd', 'parenthesesNegative'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 4: freight-invoices-cost-report (medium, English LTR)
// ===========================================================================

const CARRIER_CODES = ['AF', 'BOL', 'SC'] as const;
const CARRIER_MAP: Record<string, string> = { AF: 'Atlas Freight', BOL: 'Blue Ocean Logistics', SC: 'Swift Cargo' };

function genFreightRows(rng: Rng, n: number, startId: number, extraStatus?: string): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const invoiceNo = `INV-${padNum(startId + i, 4)}`;
    const carrier = pick(rng, CARRIER_CODES);
    const y = 2024;
    const m = randInt(rng, 1, 3);
    const d = randInt(rng, 1, 28);
    const amount = randAmount(rng, 50, 5000);
    const amountText = amount >= 1000 ? `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : `$${amount.toFixed(2)}`;
    let status: string;
    if (i === n - 1 && extraStatus) status = extraStatus;
    else status = chance(rng, 0.15) ? 'Cancelled' : pick(rng, ['Paid', 'Pending', 'Disputed']);
    out.push([invoiceNo, carrier, dateCell(y, m, d), amountText, status]);
  }
  return out;
}

async function buildCase04(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'invoiceNo', header: 'Invoice No', type: 'idLike', required: true },
        { id: 'carrierCode', header: 'Carrier Code', type: 'text', required: true },
        { id: 'shipDate', header: 'Ship Date', type: 'date', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
        { id: 'status', header: 'Status', type: 'text', required: true },
      ],
      // SPEC 10: "≠" is the safe choice here - an allow-list of Paid/Pending
      // would silently drop a brand-new status (e.g. "OnHold", used in the
      // next-month hold-out below); excluding only Cancelled generalizes.
      rowFilters: [{ column: 'status', op: 'ne', value: 'Cancelled' }],
    },
    transform: {
      computed: [],
      valueMaps: [{ column: 'carrierCode', map: CARRIER_MAP, onMissing: 'flag' }],
      sort: [],
    },
    output: {
      sheetName: 'Cost Report',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Invoice No', from: 'invoiceNo' },
        { header: 'Carrier', from: 'carrierCode' },
        { header: 'Ship Date', from: 'shipDate', format: 'DD/MM/YYYY' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Freight invoices → cost report', rulesBody);

  const rng = makeRng('freight-invoices-cost-report');
  const input = await toArtifact({
    name: 'Invoices',
    file: { type: 'csv' },
    rows: [hdr(['Invoice No', 'Carrier Code', 'Ship Date', 'Amount', 'Status']), ...rows(genFreightRows(rng, 22, 1))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('freight-invoices-cost-report-next');
  const nextInput = await toArtifact({
    name: 'Invoices',
    file: { type: 'csv' },
    rows: [
      hdr(['Invoice No', 'Carrier Code', 'Ship Date', 'Amount', 'Status']),
      ...rows(genFreightRows(nextRng, 22, 500, 'OnHold')),
    ],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'freight-invoices-cost-report',
    meta: {
      difficulty: 'medium',
      domain: 'freightInvoices',
      features: ['valueMap', 'filterNotEqual', 'numbersStoredAsText', 'currencySymbol', 'newStatusGeneralization'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 5: payroll-pension-deposits (medium, Hebrew RTL) + masking trap
// ===========================================================================

function genPayrollRows(rng: Rng, n: number, startId: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const id = padNum(startId + i, 6);
    const [first, last] = fullName(rng, 'he');
    const salary = randAmount(rng, 6000, 22000);
    out.push([id, `${first} ${last}`, salary]);
  }
  return out;
}

async function buildCase05(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'employeeId', header: 'מספר עובד', type: 'idLike', padLeft: 6, required: true },
        { id: 'employeeName', header: 'שם עובד', type: 'text', required: true },
        { id: 'baseSalary', header: 'שכר בסיס', type: 'decimal', required: true },
      ],
    },
    transform: {
      functions: [
        {
          name: 'pensionOf',
          params: [{ name: 'salary', type: 'decimal' }, { name: 'rate', type: 'decimal' }],
          returns: 'decimal',
          body: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ param: 'salary' }, { param: 'rate' }] } },
        },
      ],
      computed: [
        { id: 'employeeShare', type: 'decimal', expr: { op: 'call', fn: 'pensionOf', args: [{ col: 'baseSalary' }, { const: 0.06 }] } },
        { id: 'employerShare', type: 'decimal', expr: { op: 'call', fn: 'pensionOf', args: [{ col: 'baseSalary' }, { const: 0.145 }] } },
        // The masking trap (SPEC 7.2/10): the branch code is the first two
        // digits of the (zero-padded) employee id - a relation *inside* a
        // masked word. See README.md for why `expect` is a masking_on/off pair.
        { id: 'branchCode', type: 'text', expr: { op: 'substr', arg: { col: 'employeeId' }, start: 1, length: 2 } },
      ],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'הפרשות פנסיה',
      direction: 'rtl',
      language: 'he',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'מספר עובד', from: 'employeeId' },
        { header: 'שם עובד', from: 'employeeName' },
        { header: 'הפרשת עובד', from: 'employeeShare', format: '#,##0.00' },
        { header: 'הפרשת מעביד', from: 'employerShare', format: '#,##0.00' },
        { header: 'קוד סניף', from: 'branchCode' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('שכר → הפרשות פנסיה', rulesBody);

  const rng = makeRng('payroll-pension-deposits');
  const input = await toArtifact({
    name: 'שכר',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מספר עובד', 'שם עובד', 'שכר בסיס']), ...rows(genPayrollRows(rng, 20, 1))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('payroll-pension-deposits-next');
  const nextInput = await toArtifact({
    name: 'שכר',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מספר עובד', 'שם עובד', 'שכר בסיס']), ...rows(genPayrollRows(nextRng, 20, 500))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'payroll-pension-deposits',
    meta: {
      difficulty: 'medium',
      domain: 'payroll',
      features: ['calculation', 'rounding', 'sharedFunction', 'prefixOfId', 'maskingGap'],
      // Prefix of the id: pair analysis finds it on the real data, so masking does not hide it (README).
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 6: orders-dedupe (medium, English LTR)
// ===========================================================================

function genOrderRows(rng: Rng, n: number, startId: number, dupRate: number): Cell[][] {
  const out: Cell[][] = [];
  const items = ['Widget', 'Gadget', 'Bolt', 'Bracket', 'Sensor', 'Cable'];
  let orderNo = startId;
  while (out.length < n) {
    const id = `ORD-${padNum(orderNo, 5)}`;
    const [first, last] = fullName(rng, 'en');
    const item = pick(rng, items);
    const qty = randInt(rng, 1, 20);
    const amount = randAmount(rng, 10, 900);
    out.push([id, `${first} ${last}`, item, qty, amount]);
    // A duplicated line: the same Order No resubmitted with identical data.
    if (chance(rng, dupRate) && out.length < n) {
      out.push([id, `${first} ${last}`, item, qty, amount]);
    }
    orderNo++;
  }
  return out.slice(0, n);
}

async function buildCase06(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'orderNo', header: 'Order No', type: 'idLike', required: true },
        { id: 'customer', header: 'Customer', type: 'text', required: true },
        { id: 'item', header: 'Item', type: 'text', required: true },
        { id: 'qty', header: 'Qty', type: 'integer', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
      ],
    },
    transform: { dedupe: { keys: ['orderNo'], keep: 'first', action: 'remove' }, computed: [], valueMaps: [], sort: [] },
    output: {
      file: { type: 'csv' },
      sheetName: 'Orders (deduped)',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Order #', from: 'orderNo' },
        { header: 'Customer', from: 'customer' },
        { header: 'Item', from: 'item' },
        { header: 'Quantity', from: 'qty' },
        { header: 'Line Total', from: 'amount', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Orders export → deduped orders', rulesBody);

  const rng = makeRng('orders-dedupe');
  const input = await toArtifact({
    name: 'Orders',
    rows: [hdr(['Order No', 'Customer', 'Item', 'Qty', 'Amount']), ...rows(genOrderRows(rng, 24, 1, 0.3))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('orders-dedupe-next');
  const nextInput = await toArtifact({
    name: 'Orders',
    rows: [hdr(['Order No', 'Customer', 'Item', 'Qty', 'Amount']), ...rows(genOrderRows(nextRng, 24, 500, 0.3))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'orders-dedupe',
    meta: {
      difficulty: 'medium',
      domain: 'salesOrders',
      features: ['dedupeByKey', 'csvOutput', 'utf8bom'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 7: insurer-commission-control (hard, Hebrew RTL)
// ===========================================================================

const HE_PRODUCTS = ['חיים', 'בריאות', 'רכב'] as const;
const HE_PRODUCT_MAP: Record<string, string> = { חיים: 'LIFE', בריאות: 'HEALTH', רכב: 'AUTO' };

function genCommissionRows(rng: Rng, agents: number, perAgent: number, month: number): Cell[][] {
  const out: Cell[][] = [];
  let policySeq = 1;
  for (let a = 1; a <= agents; a++) {
    const agentId = padNum(a, 3);
    for (let p = 0; p < perAgent; p++) {
      const policy = padNum(policySeq++, 8);
      const insuredId = makeValidIsraeliId(padNum(randInt(rng, 0, 99999999), 8));
      const [first, last] = fullName(rng, 'he');
      const product = pick(rng, HE_PRODUCTS);
      // One deliberately bad checksum row to exercise the flag (still verified:
      // flags highlight a cell, they never block a row here - severity "flag").
      const insured = a === 1 && p === 0 ? '123456782' : insuredId;
      const status = chance(rng, 0.1) ? 'מבוטל' : 'פעיל';
      const premium = randAmount(rng, 200, 5000);
      const day = randInt(rng, 1, 28);
      out.push([agentId, policy, insured, `${first} ${last}`, product, status, premium, dateCell(2024, month, day)]);
    }
  }
  return out;
}

async function buildCase07(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'agentId', header: 'מספר סוכן', type: 'idLike', required: true },
        { id: 'policyId', header: 'מספר פוליסה', type: 'idLike', padLeft: 8, required: true },
        { id: 'insuredId', header: 'ת.ז. מבוטח', type: 'idLike', padLeft: 9 },
        { id: 'insuredName', header: 'שם מבוטח', type: 'text' },
        { id: 'product', header: 'מוצר', type: 'text' },
        { id: 'status', header: 'סטטוס', type: 'text' },
        { id: 'premium', header: 'פרמיה', type: 'decimal', required: true },
        { id: 'startDate', header: 'תאריך תחילה', type: 'date', required: true },
      ],
      rowFilters: [{ column: 'status', op: 'ne', value: 'מבוטל' }],
    },
    transform: {
      computed: [{ id: 'commission', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'premium' }, { const: 0.15 }] } } }],
      valueMaps: [{ column: 'product', map: HE_PRODUCT_MAP, onMissing: 'flag' }],
      sort: [{ column: 'agentId', dir: 'asc' }, { column: 'startDate', dir: 'asc' }],
      group: {
        by: 'agentId',
        showDetailRows: true,
        blankRowsAfter: 1,
        summaryRows: [
          { label: 'סה"כ לסוכן', labelColumn: 'פוליסה', bold: true, cells: { פוליסה: 'count', פרמיה: 'sum', עמלה: 'average' } },
        ],
      },
    },
    output: {
      sheetName: 'דוח בקרת עמלות',
      direction: 'rtl',
      language: 'he',
      headerStyle: { bold: true },
      titleRows: [
        { parts: [{ text: 'דוח בקרת עמלות - ' }, { agg: 'max', column: 'startDate', format: 'MMMM YYYY' }], bold: true },
        { blank: true },
      ],
      columns: [
        { header: 'סוכן', from: 'agentId' },
        { header: 'פוליסה', from: 'policyId' },
        { header: 'ת.ז. מבוטח', from: 'insuredId' },
        { header: 'מבוטח', from: 'insuredName' },
        { header: 'מוצר', from: 'product' },
        { header: 'תאריך תחילה', from: 'startDate', format: 'DD/MM/YYYY' },
        { header: 'פרמיה', from: 'premium', format: '#,##0.00' },
        { header: 'עמלה', from: 'commission', format: '#,##0.00' },
      ],
      summaryRows: [{ label: 'סה"כ כללי', labelColumn: 'פוליסה', bold: true, cells: { פרמיה: 'sum', עמלה: 'sum' } }],
    },
    validations: [
      { column: 'insuredId', rule: 'israeliIdChecksum', severity: 'flag' },
      { column: 'premium', rule: 'range', min: 0, severity: 'flag' },
    ],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('דוחות עמלות → דוח בקרה', rulesBody);

  const rng = makeRng('insurer-commission-control');
  const input = await toArtifact({
    name: 'עמלות',
    direction: 'rtl',
    language: 'he',
    rows: [
      hdr(['מספר סוכן', 'מספר פוליסה', 'ת.ז. מבוטח', 'שם מבוטח', 'מוצר', 'סטטוס', 'פרמיה', 'תאריך תחילה']),
      ...rows(genCommissionRows(rng, 4, 8, 3)),
    ],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('insurer-commission-control-next');
  const nextInput = await toArtifact({
    name: 'עמלות',
    direction: 'rtl',
    language: 'he',
    rows: [
      hdr(['מספר סוכן', 'מספר פוליסה', 'ת.ז. מבוטח', 'שם מבוטח', 'מוצר', 'סטטוס', 'פרמיה', 'תאריך תחילה']),
      ...rows(genCommissionRows(nextRng, 4, 8, 4)),
    ],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'insurer-commission-control',
    meta: {
      difficulty: 'hard',
      domain: 'insuranceCommissions',
      features: ['groups', 'summaryRows', 'blankRowsAfterGroup', 'titleFromData', 'valueMap', 'filterNotEqual', 'israeliIdChecksum'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 8: purchase-orders-supplier-summary (hard, English LTR, summary output)
// ===========================================================================

const SUPPLIERS = ['Acme Supply', 'Northwind Traders', 'Global Parts Co', 'Pinnacle Materials', 'Summit Logistics'];

function genPoRows(rng: Rng, perSupplier: number[], startId: number): Cell[][] {
  const out: Cell[][] = [];
  const items = ['Bracket', 'Panel', 'Fastener', 'Motor', 'Sensor', 'Valve'];
  let poNo = startId;
  perSupplier.forEach((count, si) => {
    for (let i = 0; i < count; i++) {
      out.push([`PO-${padNum(poNo++, 5)}`, SUPPLIERS[si] as string, pick(rng, items), randInt(rng, 1, 50), randAmount(rng, 50, 2000)]);
    }
  });
  return out;
}

async function buildCase08(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'poNo', header: 'PO No', type: 'idLike', required: true },
        { id: 'supplier', header: 'Supplier', type: 'text', required: true },
        { id: 'item', header: 'Item', type: 'text' },
        { id: 'qty', header: 'Qty', type: 'integer', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
      ],
    },
    transform: {
      computed: [],
      valueMaps: [],
      sort: [{ column: 'supplier', dir: 'asc' }],
      group: { by: 'supplier', showDetailRows: false },
    },
    output: {
      sheetName: 'Supplier Spend Summary',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Supplier', from: 'supplier', agg: 'first' },
        { header: 'Orders', from: 'poNo', agg: 'count' },
        { header: 'Total Qty', from: 'qty', agg: 'sum' },
        { header: 'Total Amount', from: 'amount', agg: 'sum', format: '#,##0.00' },
        { header: 'Avg Order Value', from: 'amount', agg: 'average', format: '#,##0.00' },
      ],
      summaryRows: [{ label: 'Total', labelColumn: 'Supplier', bold: true, cells: { 'Total Qty': 'sum', 'Total Amount': 'sum' } }],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Purchase orders → supplier spend summary', rulesBody);

  const rng = makeRng('purchase-orders-supplier-summary');
  const input = await toArtifact({
    name: 'Purchase Orders',
    rows: [hdr(['PO No', 'Supplier', 'Item', 'Qty', 'Amount']), ...rows(genPoRows(rng, [6, 5, 4, 5, 4], 1))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('purchase-orders-supplier-summary-next');
  const nextInput = await toArtifact({
    name: 'Purchase Orders',
    rows: [hdr(['PO No', 'Supplier', 'Item', 'Qty', 'Amount']), ...rows(genPoRows(nextRng, [5, 4, 6, 4, 5], 500))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'purchase-orders-supplier-summary',
    meta: {
      difficulty: 'hard',
      domain: 'purchaseOrders',
      features: ['summaryOutput', 'groupAgg', 'grandTotal'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 9: stock-count-warehouse-report (hard, Hebrew RTL, title rows + footer)
// ===========================================================================

const WAREHOUSES = ['צפון', 'דרום', 'מרכז'];
const HE_ITEMS = ['ברגים', 'אומים', 'צירים', 'כבלים', 'מסבים', 'אטמים'];

function genStockRows(rng: Rng, perWarehouse: number): Cell[][] {
  const out: Cell[][] = [];
  let sku = 100;
  for (const wh of WAREHOUSES) {
    for (let i = 0; i < perWarehouse; i++) {
      const qty = randInt(rng, 1, 500);
      const unitCost = randAmount(rng, 1, 80);
      out.push([wh, sku++, pick(rng, HE_ITEMS), qty, unitCost]);
    }
  }
  return out;
}

async function buildCase09(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      stopAt: { when: 'firstCellMatches', values: ['סה"כ'] },
      columns: [
        { id: 'warehouse', header: 'מחסן', type: 'text', required: true },
        { id: 'sku', header: 'מקט', type: 'idLike', padLeft: 6, required: true },
        { id: 'item', header: 'פריט', type: 'text' },
        { id: 'qty', header: 'כמות', type: 'integer', required: true },
        { id: 'unitCost', header: 'עלות יחידה', type: 'decimal', required: true },
      ],
    },
    transform: {
      computed: [{ id: 'totalCost', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'qty' }, { col: 'unitCost' }] } } }],
      valueMaps: [],
      sort: [{ column: 'warehouse', dir: 'asc' }],
    },
    output: {
      sheetName: 'דוח מחסנים',
      direction: 'rtl',
      language: 'he',
      headerStyle: { bold: true },
      titleRows: [{ text: 'דוח מלאי מחסנים', bold: true }, { blank: true }],
      columns: [
        { header: 'מחסן', from: 'warehouse' },
        { header: 'מקט', from: 'sku' },
        { header: 'פריט', from: 'item' },
        { header: 'כמות', from: 'qty' },
        { header: 'עלות יחידה', from: 'unitCost', format: '#,##0.00' },
        { header: 'עלות כוללת', from: 'totalCost', format: '#,##0.00' },
      ],
      summaryRows: [{ label: 'סה"כ', labelColumn: 'פריט', bold: true, cells: { כמות: 'sum', 'עלות כוללת': 'sum' } }],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('ספירת מלאי → דוח מחסנים', rulesBody);

  function buildInputRows(rng: Rng): Cell[][] {
    const data = genStockRows(rng, 9); // 3 warehouses x 9 = 27 data rows
    const header = hdr(['מחסן', 'מקט', 'פריט', 'כמות', 'עלות יחידה']);
    const totalQty = data.reduce((s, r) => s + (r[3] as number), 0);
    return [
      [{ v: 'ספירת מלאי - כל המחסנים', bold: true }],
      ['תאריך ספירה: 01/03/2024'],
      header.cells,
      ...data,
      ['סה"כ', null, null, totalQty, null],
    ];
  }

  const rng = makeRng('stock-count-warehouse-report');
  const input = await toArtifact({ name: 'ספירה', direction: 'rtl', language: 'he', rows: rows(buildInputRows(rng)) });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('stock-count-warehouse-report-next');
  const nextInput = await toArtifact({ name: 'ספירה', direction: 'rtl', language: 'he', rows: rows(buildInputRows(nextRng)) });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'stock-count-warehouse-report',
    meta: {
      difficulty: 'hard',
      domain: 'warehouseStock',
      features: ['titleRowsInInput', 'totalsFooter', 'computedColumn', 'summaryRows'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 10: catalog-rtl-mixed (hard, Hebrew RTL output with mixed EN/HE cells)
// ===========================================================================

const BRANDS = ['Bosch', 'Makita', 'DeWalt', 'Bahco', 'Stanley'];
const CATEGORY_CANON = ['כלי עבודה', 'גינון', 'אינסטלציה'];

function genCatalogRows(rng: Rng, n: number, startSeq: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const brand = pick(rng, BRANDS);
    const sku = `${brand.slice(0, 3).toUpperCase()}-${padNum(startSeq + i, 4)}`;
    const name = `${pick(rng, HE_TOOLS)} ${pick(rng, ['חשמלי', 'ידני', 'מקצועי'])}`;
    // A messy category variant that needs normalizing (masking-unrelated trap:
    // just an ordinary value-map cleanup), alongside the already-canonical ones.
    const category = chance(rng, 0.25) ? 'כלים חשמליים' : pick(rng, CATEGORY_CANON);
    const price = randAmount(rng, 15, 1200);
    const inStock = chance(rng, 0.85) ? 'כן' : 'לא';
    out.push([sku, name, category, price, inStock, brand]);
  }
  return out;
}

async function buildCase10(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'sku', header: 'מקט', type: 'idLike', required: true },
        { id: 'name', header: 'שם', type: 'text', required: true },
        { id: 'category', header: 'קטגוריה', type: 'text' },
        { id: 'price', header: 'מחיר', type: 'decimal', required: true },
        { id: 'inStock', header: 'במלאי', type: 'text' },
        { id: 'brand', header: 'יצרן', type: 'text' },
      ],
    },
    transform: {
      computed: [{ id: 'fullLabel', type: 'text', expr: { op: 'concat', args: [{ col: 'sku' }, { const: ' - ' }, { col: 'name' }] } }],
      valueMaps: [{ column: 'category', map: { 'כלים חשמליים': 'כלי חשמל' }, onMissing: 'keep' }],
      sort: [],
    },
    output: {
      sheetName: 'קטלוג מוצרים',
      direction: 'rtl',
      language: 'he',
      headerStyle: { bold: true },
      titleRows: [],
      columns: [
        { header: 'מקט', from: 'sku' },
        { header: 'תיאור מלא', from: 'fullLabel' },
        { header: 'קטגוריה', from: 'category' },
        { header: 'מחיר', from: 'price', format: '#,##0.00' },
        { header: 'במלאי', from: 'inStock' },
        { header: 'יצרן', from: 'brand' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('קטלוג מוצרים RTL', rulesBody);

  const rng = makeRng('catalog-rtl-mixed');
  const input = await toArtifact({
    name: 'קטלוג',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מקט', 'שם', 'קטגוריה', 'מחיר', 'במלאי', 'יצרן']), ...rows(genCatalogRows(rng, 20, 1))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('catalog-rtl-mixed-next');
  const nextInput = await toArtifact({
    name: 'קטלוג',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מקט', 'שם', 'קטגוריה', 'מחיר', 'במלאי', 'יצרן']), ...rows(genCatalogRows(nextRng, 20, 500))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'catalog-rtl-mixed',
    meta: {
      difficulty: 'hard',
      domain: 'productCatalog',
      features: ['rtlMixedLanguage', 'concat', 'valueMapNormalize'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 11: budget-columns-to-rows (rows, English LTR)
// ===========================================================================

const DEPARTMENTS = ['Sales', 'Engineering', 'Marketing', 'Operations', 'Finance'];
const BUDGET_CATEGORIES = ['Travel', 'Software', 'Training', 'Supplies'];

function genBudgetRows(rng: Rng, n: number): Cell[][] {
  const out: Cell[][] = [];
  const combos = shuffle(
    rng,
    DEPARTMENTS.flatMap((d) => BUDGET_CATEGORIES.map((c) => [d, c] as const)),
  ).slice(0, n);
  combos.forEach(([dept, cat], i) => {
    // A couple of rows start mid-quarter (blank Jan) to exercise skipEmpty.
    const jan = i < 2 ? null : randAmount(rng, 500, 20000, 0);
    const feb = randAmount(rng, 500, 20000, 0);
    const mar = randAmount(rng, 500, 20000, 0);
    out.push([dept, cat, jan, feb, mar]);
  });
  return out;
}

async function buildCase11(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'department', header: 'Department', type: 'text', required: true },
        { id: 'category', header: 'Category', type: 'text', required: true },
        { id: 'jan', header: 'Jan', type: 'decimal' },
        { id: 'feb', header: 'Feb', type: 'decimal' },
        { id: 'mar', header: 'Mar', type: 'decimal' },
      ],
    },
    transform: {
      expand: { mode: 'columnsToRows', columns: ['jan', 'feb', 'mar'], labelId: 'month', valueId: 'amount', valueType: 'decimal', skipEmpty: true },
      computed: [],
      valueMaps: [],
      sort: [{ column: 'department', dir: 'asc' }],
    },
    output: {
      sheetName: 'Budget by Month',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Department', from: 'department' },
        { header: 'Category', from: 'category' },
        { header: 'Month', from: 'month' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Monthly budget → rows', rulesBody);

  const rng = makeRng('budget-columns-to-rows');
  const input = await toArtifact({
    name: 'Budget',
    rows: [hdr(['Department', 'Category', 'Jan', 'Feb', 'Mar']), ...rows(genBudgetRows(rng, 16))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('budget-columns-to-rows-next');
  const nextInput = await toArtifact({
    name: 'Budget',
    rows: [hdr(['Department', 'Category', 'Jan', 'Feb', 'Mar']), ...rows(genBudgetRows(nextRng, 16))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'budget-columns-to-rows',
    meta: {
      difficulty: 'medium',
      domain: 'budget',
      features: ['columnsToRows', 'skipEmpty'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 12: expense-split-cell (rows, Hebrew RTL)
// ===========================================================================

const HE_EXPENSE_CATEGORIES = ['נסיעות', 'ארוחות', 'לינה', 'ציוד'];

function genExpenseRows(rng: Rng, n: number, startId: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const claimNo = `EXP-${padNum(startId + i, 4)}`;
    const [first, last] = fullName(rng, 'he');
    const partCount = randInt(rng, 1, 4);
    const cats = shuffle(rng, HE_EXPENSE_CATEGORIES).slice(0, partCount);
    const amount = randAmount(rng, 90, 1500);
    out.push([claimNo, `${first} ${last}`, cats.join('; '), amount]);
  }
  return out;
}

async function buildCase12(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'claimNo', header: 'מספר בקשה', type: 'idLike', required: true },
        { id: 'employee', header: 'עובד', type: 'text', required: true },
        { id: 'categories', header: 'קטגוריות', type: 'text', required: true },
        { id: 'amount', header: 'סכום', type: 'decimal', required: true },
      ],
    },
    transform: {
      expand: { mode: 'splitCell', column: 'categories', separator: '; ', trim: true, partId: 'category', indexId: 'partIndex', countId: 'partCount', skipEmpty: true },
      computed: [{ id: 'share', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'div', args: [{ col: 'amount' }, { col: 'partCount' }] } } }],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'הוצאות לפי קטגוריה',
      direction: 'rtl',
      language: 'he',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'מספר בקשה', from: 'claimNo' },
        { header: 'עובד', from: 'employee' },
        { header: 'קטגוריה', from: 'category' },
        { header: 'סכום לקטגוריה', from: 'share', format: '#,##0.00' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('בקשות הוצאה → פיצול קטגוריות', rulesBody);

  const rng = makeRng('expense-split-cell');
  const input = await toArtifact({
    name: 'הוצאות',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מספר בקשה', 'עובד', 'קטגוריות', 'סכום']), ...rows(genExpenseRows(rng, 18, 1))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('expense-split-cell-next');
  const nextInput = await toArtifact({
    name: 'הוצאות',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מספר בקשה', 'עובד', 'קטגוריות', 'סכום']), ...rows(genExpenseRows(nextRng, 18, 500))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'expense-split-cell',
    meta: {
      difficulty: 'medium',
      domain: 'expenseClaims',
      features: ['splitCell', 'divisionRounding', 'skipEmpty'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Case 13: sales-pivot-blocked (blocked:pivotDetected) - hand-built, no rules
// ===========================================================================

const REGIONS = ['North', 'South', 'East', 'West'];
const PIVOT_PRODUCTS = ['Widget', 'Gadget', 'Bolt', 'Bracket', 'Sensor'];

async function buildCase13(): Promise<CaseSpec> {
  const rng = makeRng('sales-pivot-blocked');
  const txns: { region: string; product: string; amount: number }[] = [];
  for (let i = 0; i < 32; i++) {
    txns.push({ region: pick(rng, REGIONS), product: pick(rng, PIVOT_PRODUCTS), amount: randAmount(rng, 50, 900) });
  }

  const dataRows: Cell[][] = txns.map((t, i) => [
    `TXN-${padNum(i + 1, 4)}`,
    dateCell(2024, randInt(rng, 1, 3), randInt(rng, 1, 28)),
    t.region,
    t.product,
    t.amount,
  ]);
  const input = await toArtifact({
    name: 'Sales',
    rows: [hdr(['Txn ID', 'Date', 'Region', 'Product', 'Amount']), ...rows(dataRows)],
  });

  // The "hand-made" example output: a two-axis pivot (Product x Region), which
  // the rules language cannot express (transform.group has one `by` dimension
  // and column-wise aggregates, never a dynamic column per distinct value of a
  // second column) - built directly, never via convertFile.
  function sumFor(product: string, region?: string): number {
    return txns
      .filter((t) => t.product === product && (region === undefined || t.region === region))
      .reduce((s, t) => s + t.amount, 0);
  }
  const pivotRows: Cell[][] = PIVOT_PRODUCTS.map((product) => [
    product,
    ...REGIONS.map((region) => Math.round(sumFor(product, region) * 100) / 100),
    Math.round(sumFor(product) * 100) / 100,
  ]);
  const output = await toArtifact({
    name: 'Regional Pivot',
    rows: [{ cells: ['Product', ...REGIONS, 'Total'], bold: true }, ...rows(pivotRows)],
  });

  return {
    name: 'sales-pivot-blocked',
    meta: {
      difficulty: 'hard',
      domain: 'salesTransactions',
      features: ['pivot', 'blocked'],
      // SPEC 6.3's block reasons are coded in packages/shared/src/codes.ts
      // (PREFLIGHT_BLOCK_REASONS); "pivotDetected" is that enum's pivot code.
      expect: 'blocked:pivotDetected',
    },
    input,
    output,
  };
}

// ===========================================================================
// Case 14: fulfillment-external-column (unsupported:externalData) - hand-built
// ===========================================================================

const WMS_WAREHOUSES = ['WH-EAST-04', 'WH-WEST-02', 'WH-CENTRAL-01', 'WH-SOUTH-07'];

async function buildCase14(): Promise<CaseSpec> {
  const rng = makeRng('fulfillment-external-column');
  const pos: { poNo: string; supplier: string; item: string; qty: number; y: number; m: number; d: number }[] = [];
  for (let i = 0; i < 20; i++) {
    pos.push({
      poNo: `PO-${padNum(i + 1, 4)}`,
      supplier: pick(rng, SUPPLIERS),
      item: pick(rng, ['Bracket', 'Panel', 'Fastener', 'Motor']),
      qty: randInt(rng, 1, 40),
      y: 2024,
      m: randInt(rng, 1, 3),
      d: randInt(rng, 1, 28),
    });
  }
  const input = await toArtifact({
    name: 'Purchase Orders',
    rows: [
      hdr(['PO No', 'Supplier', 'Item', 'Qty', 'Requested Date']),
      ...rows(pos.map((p) => [p.poNo, p.supplier, p.item, p.qty, dateCell(p.y, p.m, p.d)])),
    ],
  });

  // "Assigned Warehouse" is filled in by a WMS the input never mentions - no
  // input column, value, prefix or pattern predicts it (SPEC 8.10:
  // "externalData" is exactly this: `from: null`, never resolvable from the
  // input). Built directly; there is no rules file that could produce it.
  const output = await toArtifact({
    name: 'Fulfillment',
    rows: [
      { cells: ['PO No', 'Supplier', 'Item', 'Qty', 'Requested Date', 'Assigned Warehouse'], bold: true },
      ...rows(pos.map((p) => [p.poNo, p.supplier, p.item, p.qty, ddmmyyyy(p.y, p.m, p.d), pick(rng, WMS_WAREHOUSES)])),
    ],
  });

  return {
    name: 'fulfillment-external-column',
    meta: {
      difficulty: 'medium',
      domain: 'purchaseOrders',
      features: ['externalData', 'unsupportedColumn'],
      expect: 'unsupported:externalData',
    },
    input,
    output,
  };
}

// ===========================================================================
// Cases 15-17: registry-supplier-a/b/c - one ERP catalog format, 3 sources
// ===========================================================================

interface RegistrySupplierDef {
  name: string;
  attachTo?: string;
  domainNote: string;
  build: () => Promise<{ referenceRules: ReturnType<typeof mkRules>; input: FileArtifact; nextInput: FileArtifact; features: string[] }>;
}

/** The shared format side (SPEC 8.12): identical across all three conversions
 * except `columns[].from`, which each supplier's own ids fill in. */
function registryOutput(ids: { code: string; desc: string; price: string; category: string }): LearnResult['output'] {
  return {
    sheetName: 'ERP Catalog Load',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    headerStyle: { bold: true },
    columns: [
      { header: 'Item Code', from: ids.code, width: 12 },
      { header: 'Description', from: ids.desc },
      { header: 'Unit Price', from: ids.price, format: '#,##0.00' },
      { header: 'Category', from: ids.category },
    ],
  };
}
const REGISTRY_VALIDATIONS: LearnResult['validations'] = [{ on: 'output', column: 'Item Code', rule: 'required', severity: 'flag' }];

const REGISTRY_A_CATEGORIES = ['כלי עבודה', 'חשמל', 'גינון'];

function genRegistryARows(rng: Rng, n: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    out.push([randInt(rng, 1, 999999), pick(rng, HE_TOOLS), randAmount(rng, 5, 500), pick(rng, REGISTRY_A_CATEGORIES)]);
  }
  return out;
}

async function buildRegistryA(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'itemCode', header: 'מקט', type: 'idLike', padLeft: 6, required: true },
        { id: 'itemName', header: 'שם פריט', type: 'text', required: true },
        { id: 'unitPrice', header: 'מחיר', type: 'decimal', required: true },
        { id: 'category', header: 'קטגוריה', type: 'text' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [{ column: 'itemCode', dir: 'asc' }] },
    output: registryOutput({ code: 'itemCode', desc: 'itemName', price: 'unitPrice', category: 'category' }),
    validations: REGISTRY_VALIDATIONS,
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Supplier A price list', rulesBody, { formatId: 'registry-erp-catalog', sourceName: 'Supplier A' });

  const rng = makeRng('registry-supplier-a');
  const input = await toArtifact({
    name: 'מחירון א',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מקט', 'שם פריט', 'מחיר', 'קטגוריה']), ...rows(genRegistryARows(rng, 18))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('registry-supplier-a-next');
  const nextInput = await toArtifact({
    name: 'מחירון א',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['מקט', 'שם פריט', 'מחיר', 'קטגוריה']), ...rows(genRegistryARows(nextRng, 18))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'registry-supplier-a',
    meta: {
      difficulty: 'medium',
      domain: 'supplierPriceList',
      features: ['registryBase', 'padLeft', 'leadingZerosLost'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

function genRegistryBRows(rng: Rng, n: number): Cell[][] {
  const out: Cell[][] = [];
  const groups = ['Tools', 'Electrical', 'Garden'];
  for (let i = 0; i < n; i++) {
    const cost = randAmount(rng, 3, 400);
    out.push([`SKU-${padNum(randInt(rng, 1, 9999), 5)}`, `$${cost.toFixed(2)}`, `${pick(rng, HE_TOOLS)} (import)`, pick(rng, groups)]);
  }
  return out;
}

async function buildRegistryB(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'sku', header: 'SKU', type: 'idLike', required: true },
        { id: 'unitCost', header: 'Unit Cost', type: 'decimal', required: true },
        { id: 'itemDesc', header: 'Item Description', type: 'text', required: true },
        { id: 'group', header: 'Group', type: 'text' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [{ column: 'sku', dir: 'asc' }] },
    output: registryOutput({ code: 'sku', desc: 'itemDesc', price: 'unitCost', category: 'group' }),
    validations: REGISTRY_VALIDATIONS,
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Supplier B price list', rulesBody, { formatId: 'registry-erp-catalog', sourceName: 'Supplier B' });

  const rng = makeRng('registry-supplier-b');
  const input = await toArtifact({
    name: 'Price List',
    file: { type: 'csv' },
    rows: [hdr(['SKU', 'Unit Cost', 'Item Description', 'Group']), ...rows(genRegistryBRows(rng, 16))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('registry-supplier-b-next');
  const nextInput = await toArtifact({
    name: 'Price List',
    file: { type: 'csv' },
    rows: [hdr(['SKU', 'Unit Cost', 'Item Description', 'Group']), ...rows(genRegistryBRows(nextRng, 16))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'registry-supplier-b',
    meta: {
      difficulty: 'medium',
      domain: 'supplierPriceList',
      features: ['registryAttach', 'numbersStoredAsText', 'currencySymbol', 'differentColumnOrder'],
      expect: 'verified',
      attachTo: 'registry-supplier-a',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

const REGISTRY_C_CATEGORIES = ['כלים', 'חשמל ותאורה', 'גינון וחוץ'];

function genRegistryCRows(rng: Rng, n: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const cost = randAmount(rng, 100, 3000);
    // A raw number, not a pre-padded string: this is what actually loses
    // leading zeros in Excel (SPEC 17), for `padLeft` to recover.
    out.push([
      randInt(rng, 1, 999999),
      `${pick(rng, HE_TOOLS)} - דגם מקצועי`,
      cost.toLocaleString('en-US', { minimumFractionDigits: 2 }),
      pick(rng, REGISTRY_C_CATEGORIES),
    ]);
  }
  return out;
}

async function buildRegistryC(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'code', header: 'קוד פריט', type: 'idLike', padLeft: 6, required: true },
        { id: 'explanation', header: 'הסבר', type: 'text', required: true },
        { id: 'unitCost2', header: 'עלות ליחידה', type: 'decimal', required: true },
        { id: 'kind', header: 'סוג', type: 'text' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [{ column: 'code', dir: 'asc' }] },
    output: registryOutput({ code: 'code', desc: 'explanation', price: 'unitCost2', category: 'kind' }),
    validations: REGISTRY_VALIDATIONS,
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Supplier C price list', rulesBody, { formatId: 'registry-erp-catalog', sourceName: 'Supplier C' });

  const rng = makeRng('registry-supplier-c');
  const input = await toArtifact({
    name: 'מחירון ג',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['קוד פריט', 'הסבר', 'עלות ליחידה', 'סוג']), ...rows(genRegistryCRows(rng, 16))],
  });
  const output = await convertedArtifact(referenceRules, input);

  const nextRng = makeRng('registry-supplier-c-next');
  const nextInput = await toArtifact({
    name: 'מחירון ג',
    direction: 'rtl',
    language: 'he',
    rows: [hdr(['קוד פריט', 'הסבר', 'עלות ליחידה', 'סוג']), ...rows(genRegistryCRows(nextRng, 16))],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'registry-supplier-c',
    meta: {
      difficulty: 'medium',
      domain: 'supplierPriceList',
      features: ['registryAttach', 'numbersStoredAsText', 'thousandsSeparator', 'differentHeaders'],
      expect: 'verified',
      attachTo: 'registry-supplier-a',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  const builders = [
    buildCase01, buildCase02, buildCase03, buildCase04, buildCase05, buildCase06,
    buildCase07, buildCase08, buildCase09, buildCase10, buildCase11, buildCase12,
    buildCase13, buildCase14, buildRegistryA, buildRegistryB, buildRegistryC,
  ];
  for (const build of builders) {
    const spec = await build();
    writeCase(spec);
    // eslint-disable-next-line no-console
    console.log(`wrote ${spec.name} (${spec.meta.difficulty}, ${spec.meta.domain}) -> eval/cases/${spec.name}/`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${builders.length} cases written to ${casesRoot()}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
