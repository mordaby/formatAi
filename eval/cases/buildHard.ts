// Three synthetic HARD cases for the learning-loop measurement (docs/proposals/learning-loop.md, section 4): what a first sample of
// 12 rows cannot show. Built by `build.ts` together with the others (same strategy: a seeded generator, the example and next-month
// outputs produced by the real engine from a rules file; see README.md), kept in this file only because build.ts is already long.
//
//   orders-priority       a rule on two columns whose rare branch ("Urgent") sits away from every row the sample picks first
//   branch-lookup-50      a lookup of 50 values, some seen 2-3 times in 400 rows (the 12-row sample shows a handful of them)
//   discount-hand-edited  a clean rule plus 3 rows whose output a person edited by hand
//
// ASCII only (no Hebrew); every case has a next-month pair.
import type { LearnResult } from '@formatai/shared';
import { mkRules, runConvert, type CaseSpec, type FileArtifact } from './lib/caseKit';
import { dateCell, padNum, writeFixture, type Cell, type RowSpec } from './lib/fixtures';
import { makeRng, pick, randAmount, randInt, shuffle, type Rng } from './lib/prng';

const hdr = (cells: string[]): RowSpec => ({ cells });
const rows = (data: Cell[][]): RowSpec[] => data.map((cells) => ({ cells }));

async function toArtifact(spec: Parameters<typeof writeFixture>[0]): Promise<FileArtifact> {
  return { ext: spec.file?.type ?? 'xlsx', bytes: await writeFixture(spec) };
}

async function convertedArtifact(rules: ReturnType<typeof mkRules>, input: FileArtifact): Promise<FileArtifact> {
  return { ext: rules.output.file?.type ?? 'xlsx', bytes: await runConvert(rules, input.bytes, `input.${input.ext}`) };
}

// ===========================================================================
// orders-priority (hard, English LTR): Priority from Status AND Amount
// ===========================================================================

const CUSTOMERS = [
  'Acme Corp', 'Globex', 'Initech', 'Umbrella Ltd', 'Hooli', 'Stark Supply', 'Wayne Tools', 'Wonka Foods', 'Soylent Co', 'Vandelay Imports',
  'Pied Piper', 'Cyberdyne', 'Tyrell Parts', 'Oscorp', 'Aperture Labs', 'Massive Dynamic', 'Gringotts Ltd', 'Dunder Supply', 'Bluth Homes', 'Sterling Trade',
  'Monarch Metals', 'Prestige Paper', 'Rosewood Foods', 'Kestrel Marine', 'Summit Cables', 'Harbor Freight Co', 'Lakeside Glass', 'Ironwood Steel', 'Bright Path Tools', 'Cedar Mills',
];
const REGIONS = ['North', 'South', 'East', 'West'];

interface OrdersPlan {
  /** Data-row positions (0-based) of the special rows; every other row is ordinary. They never overlap, and none is one of the first rows. */
  urgentAt: number[];
  /** The Urgent rows' amounts, in the order of `urgentAt`. */
  urgentAmounts: number[];
  emptyCustomerAt: number[];
  /** Closed rows holding the smallest and the largest Amount of the file (so the largest is NOT Urgent). */
  minAmountAt: number | null;
  maxAmountAt: number | null;
  /** Rows holding the earliest and the latest Order Date of the month. */
  minDateAt: number | null;
  maxDateAt: number | null;
  year: number;
  month: number;
  daysInMonth: number;
  startId: number;
}

const MIN_AMOUNT = 98.5;
const MAX_AMOUNT = 7899.99;
/** An Open order below the threshold is at most this much; the threshold (5000) is never reached by a Normal one. */
const NORMAL_MAX = 4800;
/** A Closed / On hold order can be any size, up to this (still below MAX_AMOUNT). */
const OTHER_MAX = 7000;

function genOrderRows(rng: Rng, n: number, plan: OrdersPlan): Cell[][] {
  const special = [...plan.urgentAt, ...plan.emptyCustomerAt, ...[plan.minAmountAt, plan.maxAmountAt, plan.minDateAt, plan.maxDateAt].filter((x): x is number => x !== null)];
  if (new Set(special).size !== special.length) throw new Error('orders-priority: the special rows overlap');
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const urgentIdx = plan.urgentAt.indexOf(i);
    let status = pick(rng, ['Open', 'Open', 'Open', 'Closed', 'Closed', 'Closed', 'Closed', 'On hold']);
    let amount = status === 'Open' ? randAmount(rng, 150, NORMAL_MAX) : randAmount(rng, 150, OTHER_MAX);
    if (urgentIdx >= 0) {
      status = 'Open';
      amount = plan.urgentAmounts[urgentIdx]!;
    } else if (i === plan.minAmountAt) {
      status = 'Closed';
      amount = MIN_AMOUNT;
    } else if (i === plan.maxAmountAt) {
      status = 'Closed';
      amount = MAX_AMOUNT;
    }
    const day = i === plan.minDateAt ? 1 : i === plan.maxDateAt ? plan.daysInMonth : randInt(rng, 2, plan.daysInMonth - 1);
    const customer = plan.emptyCustomerAt.includes(i) ? '' : pick(rng, CUSTOMERS);
    out.push([`ORD-${padNum(plan.startId + i, 5)}`, customer, pick(rng, REGIONS), amount, status, dateCell(plan.year, plan.month, day)]);
  }
  return out;
}

async function buildOrdersPriority(): Promise<CaseSpec> {
  const eq = (col: string, value: string) => ({ op: 'eq' as const, args: [{ col }, { const: value }] as [{ col: string }, { const: string }] });
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'orderId', header: 'Order ID', type: 'idLike', required: true },
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'region', header: 'Region', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
        { id: 'status', header: 'Status', type: 'text', required: true },
        { id: 'orderDate', header: 'Order Date', type: 'date', required: true },
      ],
    },
    transform: {
      computed: [
        {
          id: 'priority',
          type: 'text',
          expr: {
            op: 'switch',
            cases: [
              { when: eq('status', 'On hold'), then: { const: 'Blocked' } },
              { when: { op: 'and', args: [eq('status', 'Open'), { op: 'gte', args: [{ col: 'amount' }, { const: 5000 }] }] }, then: { const: 'Urgent' } },
              { when: eq('status', 'Open'), then: { const: 'Normal' } },
            ],
            else: { const: 'Done' },
          },
        },
      ],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Orders with priority',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Order', from: 'orderId' },
        { header: 'Customer', from: 'customer' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
        { header: 'Priority', from: 'priority' },
        { header: 'Order Date', from: 'orderDate', format: 'DD/MM/YYYY' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Orders export -> orders with priority', rulesBody);
  const header = hdr(['Order ID', 'Customer', 'Region', 'Amount', 'Status', 'Order Date']);

  // The example: 240 rows, 5 Urgent (the first at exactly 5000, so ">= 5000" is told from "> 5000"), all of them far from the first rows
  // and from the rows a 12-row sample picks first (the first 3, the rows with an empty cell, the min/max Amount and Order Date rows).
  const rng = makeRng('orders-priority');
  const input = await toArtifact({
    name: 'Orders',
    rows: [
      header,
      ...rows(
        genOrderRows(rng, 240, {
          urgentAt: [71, 118, 164, 193, 227],
          urgentAmounts: [5000, 5340.5, 5712.25, 6120, 6455.8],
          emptyCustomerAt: [45, 160],
          minAmountAt: 33,
          maxAmountAt: 100,
          minDateAt: 12,
          maxDateAt: 150,
          year: 2025,
          month: 3,
          daysInMonth: 31,
          startId: 1001,
        }),
      ),
    ],
  });
  const output = await convertedArtifact(referenceRules, input);

  // Next month: 200 fresh rows, the same rule; Urgent between 5000 and 6500, Normal up to 4800.
  const nextRng = makeRng('orders-priority-next');
  const nextInput = await toArtifact({
    name: 'Orders',
    rows: [
      header,
      ...rows(
        genOrderRows(nextRng, 200, {
          urgentAt: [38, 77, 109, 141, 172, 190],
          urgentAmounts: [5120.4, 5388, 5760.25, 6010.9, 6233.5, 6499.99],
          emptyCustomerAt: [88],
          minAmountAt: null,
          maxAmountAt: null,
          minDateAt: null,
          maxDateAt: null,
          year: 2025,
          month: 4,
          daysInMonth: 30,
          startId: 2001,
        }),
      ),
    ],
  });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'orders-priority',
    meta: {
      difficulty: 'hard',
      domain: 'salesOrders',
      features: ['switchOnTwoColumns', 'thresholdAtBoundary', 'rareBranchAwayFromSample', 'emptyTextCell', 'newValuesNextMonth'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// branch-lookup-50 (hard, English LTR): a lookup of 50 values, some rare
// ===========================================================================

/** B01..B50 and a name for each, arbitrary on purpose: nothing in a code tells its name. */
const BRANCH_NAMES = [
  'Tulsa', 'Reno', 'Omaha', 'Boise', 'Fargo', 'Macon', 'Salem', 'Provo', 'Akron', 'Dayton',
  'Toledo', 'Albany', 'Savannah', 'Mobile', 'Laredo', 'Eugene', 'Spokane', 'Tacoma', 'Madison', 'Lansing',
  'Dover', 'Helena', 'Juneau', 'Topeka', 'Austin', 'Denver', 'Miami', 'Seattle', 'Boston', 'Phoenix',
  'Chicago', 'Atlanta', 'Portland', 'Orlando', 'Detroit', 'Memphis', 'Newark', 'Raleigh', 'Richmond', 'Buffalo',
  'Hartford', 'Wichita', 'Tucson', 'Fresno', 'Oakland', 'Anaheim', 'Durham', 'Norfolk', 'Garland', 'Irvine',
];
if (new Set(BRANCH_NAMES).size !== 50) throw new Error('branch-lookup-50: need 50 distinct branch names');
const BRANCH_CODES = BRANCH_NAMES.map((_, i) => `B${padNum(i + 1, 2)}`);
const PRODUCTS = ['Chairs', 'Desks', 'Lamps', 'Shelves', 'Cabinets', 'Tables'];

/** `total` branch codes in random order: the `rare` codes exactly as often as stated, every other code at least `base` times. */
function branchCodes(rng: Rng, total: number, rare: Record<string, number>, base: number): string[] {
  const others = BRANCH_CODES.filter((c) => !(c in rare));
  const counts = new Map<string, number>(others.map((c) => [c, base]));
  const fixed = Object.values(rare).reduce((a, b) => a + b, 0);
  for (let extra = total - fixed - base * others.length; extra > 0; extra--) {
    const c = pick(rng, others);
    counts.set(c, counts.get(c)! + 1);
  }
  const list: string[] = [];
  for (const [code, n] of [...Object.entries(rare), ...counts]) for (let k = 0; k < n; k++) list.push(code);
  if (list.length !== total) throw new Error(`branch-lookup-50: built ${list.length} codes, wanted ${total}`);
  return shuffle(rng, list);
}

function genSaleRows(rng: Rng, codes: readonly string[], startId: number, year: number, month: number): Cell[][] {
  return codes.map((code, i) => [`S-${padNum(startId + i, 5)}`, code, pick(rng, PRODUCTS), randAmount(rng, 25, 1800), dateCell(year, month, randInt(rng, 1, 28))]);
}

async function buildBranchLookup(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'saleId', header: 'Sale ID', type: 'idLike', required: true },
        { id: 'branchCode', header: 'Branch Code', type: 'text', required: true },
        { id: 'product', header: 'Product', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
        { id: 'saleDate', header: 'Sale Date', type: 'date', required: true },
      ],
    },
    transform: {
      computed: [{ id: 'branchName', type: 'text', expr: { op: 'lookup', table: 'branches', key: { col: 'branchCode' }, return: 'name', onMissing: 'flag' } }],
      valueMaps: [],
      sort: [],
      tables: [{ name: 'branches', columns: ['code', 'name'], rows: BRANCH_CODES.map((code, i) => [code, BRANCH_NAMES[i]!]) }],
    },
    output: {
      sheetName: 'Sales by branch',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Sale ID', from: 'saleId' },
        { header: 'Branch Code', from: 'branchCode' },
        { header: 'Branch Name', from: 'branchName' },
        { header: 'Product', from: 'product' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
        { header: 'Sale Date', from: 'saleDate', format: 'DD/MM/YYYY' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Sales export -> sales with branch name', rulesBody);
  const header = hdr(['Sale ID', 'Branch Code', 'Product', 'Amount', 'Sale Date']);

  // 400 rows, every code at least twice; 8 codes only 2-3 times, so a 12-row sample shows a handful of the 50 and almost never a rare one.
  const rng = makeRng('branch-lookup-50');
  const codes = branchCodes(rng, 400, { B07: 2, B13: 3, B21: 2, B29: 2, B34: 3, B38: 2, B44: 3, B49: 2 }, 4);
  const input = await toArtifact({ name: 'Sales', rows: [header, ...rows(genSaleRows(rng, codes, 1, 2025, 3))] });
  const output = await convertedArtifact(referenceRules, input);

  // Next month: the same 50 codes in a different mix (other codes are the rare ones, 300 rows).
  const nextRng = makeRng('branch-lookup-50-next');
  const nextCodes = branchCodes(nextRng, 300, { B03: 2, B11: 2, B18: 3, B26: 2, B31: 3, B40: 2, B45: 2, B50: 3 }, 3);
  const nextInput = await toArtifact({ name: 'Sales', rows: [header, ...rows(genSaleRows(nextRng, nextCodes, 5001, 2025, 4))] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'branch-lookup-50',
    meta: {
      difficulty: 'hard',
      domain: 'salesByBranch',
      features: ['lookupTable', 'fiftyValues', 'rareValues', 'nameNotDerivableFromCode', 'newMixNextMonth'],
      expect: 'verified',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// discount-hand-edited (hard, English LTR): a clean rule, 3 rows edited by hand
// ===========================================================================

const EDITED_AT = [52, 97, 131];

async function buildDiscountHandEdited(): Promise<CaseSpec> {
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const inputColumns = [
    { id: 'orderId', header: 'Order ID', type: 'idLike' as const, required: true },
    { id: 'customer', header: 'Customer', type: 'text' as const },
    { id: 'amount', header: 'Amount', type: 'decimal' as const, required: true },
  ];
  const discountOutput = (): LearnResult['output'] => ({
    sheetName: 'Orders with discount',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    headerStyle: { bold: true },
    columns: [
      { header: 'Order ID', from: 'orderId' },
      { header: 'Customer', from: 'customer' },
      { header: 'Amount', from: 'amount', format: '#,##0.00' },
      { header: 'Discount', from: 'discount', format: '#,##0.00' },
    ],
  });
  const tenPercent = { op: 'round' as const, digits: 2, arg: { op: 'mul' as const, args: [{ col: 'amount' }, { const: 0.1 }] } };
  const body = (columns: LearnResult['input']['columns'], expr: LearnResult['transform']['computed'][number]['expr']): LearnResult => ({
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns },
    transform: { computed: [{ id: 'discount', type: 'decimal', expr }], valueMaps: [], sort: [] },
    output: discountOutput(),
    validations: [],
    unsupported: [],
    assumptions: [],
  });
  // What the learner should find: 10% of Amount, rounded to 2 decimals.
  const referenceRules = mkRules('Orders -> orders with discount', body(inputColumns, tenPercent));
  // How the example output is made: the same rule, except that a column only THIS generator sees ("override", never written to the
  // case's input) holds the hand-edited discount of the 3 edited rows.
  const withOverride = mkRules('generator only', body([...inputColumns, { id: 'override', header: 'Override', type: 'decimal' }], { op: 'coalesce', args: [{ col: 'override' }, tenPercent] }));

  const genRows = (rng: Rng, n: number, startId: number): { cells: Cell[][]; amounts: number[] } => {
    const amounts: number[] = [];
    const cells = Array.from({ length: n }, (_, i): Cell[] => {
      const amount = randAmount(rng, 40, 2600);
      amounts.push(amount);
      return [`ORD-${padNum(startId + i, 5)}`, pick(rng, CUSTOMERS), amount];
    });
    return { cells, amounts };
  };

  const rng = makeRng('discount-hand-edited');
  const { cells, amounts } = genRows(rng, 150, 3001);
  // Three discounts a person typed over the rule: none, a bigger one (15%), a flat 25.
  const edited = [0, r2(amounts[EDITED_AT[1]!]! * 0.15), 25];
  EDITED_AT.forEach((at, k) => {
    if (r2(amounts[at]! * 0.1) === edited[k]) throw new Error('discount-hand-edited: an edited discount equals the rule');
  });
  const header = hdr(['Order ID', 'Customer', 'Amount']);
  const input = await toArtifact({ name: 'Orders', rows: [header, ...rows(cells)] });
  const overrideInput = await toArtifact({
    name: 'Orders',
    rows: [hdr([...header.cells.map(String), 'Override']), ...rows(cells.map((row, i) => [...row, EDITED_AT.includes(i) ? edited[EDITED_AT.indexOf(i)]! : null]))],
  });
  const output = await convertedArtifact(withOverride, overrideInput);

  // Next month: the clean rule on 120 fresh rows, no edited row.
  const nextRng = makeRng('discount-hand-edited-next');
  const nextInput = await toArtifact({ name: 'Orders', rows: [header, ...rows(genRows(nextRng, 120, 4001).cells)] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'discount-hand-edited',
    meta: {
      difficulty: 'hard',
      domain: 'salesOrders',
      features: ['percentRounded', 'handEditedRows', 'exceptionsToTheRule'],
      // DECISION: no classification of `expect` says "the rule for the rest, the 3 rows reported" yet (that needs the learning loop's "show the
      // rows, ask the user"), so `expect` stays `verified` - the end state - and `expectNote` says what is really wanted. Until then this case
      // is expected NOT to verify on the example; the hold-out column (next month, clean) tells whether the rule itself was found.
      expect: 'verified',
      expectNote: 'the rule for the rest (Discount = 10% of Amount, rounded to 2 decimals) and the 3 hand-edited rows reported, not forced into the rule',
      handEditedRows: EDITED_AT.length,
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

export const hardCaseBuilders: (() => Promise<CaseSpec>)[] = [buildOrdersPriority, buildBranchLookup, buildDiscountHandEdited];
