// Four cases about WHAT A SAVED FORMAT KEEPS (docs/proposals/saved-format-contents.md; owner, 2026-10-06; SPEC 21 v15). Built by `build.ts`
// with the others (same strategy as buildAdversarial.ts: a seeded generator, the example and next-month outputs produced by the real engine
// from a hand-written reference rules file; see README.md). Every one is `difficulty: 'stress'`, feature tag `savedContents`.
//
//   catalog-200            (English) a product code -> category catalog of 200 entries over 400 rows: a LIST (more than a small
//                          vocabulary's 12 entries; nobody can deduce a category from a code). Retried once for logic, kept, asked at Save:
//                          the case answers "Keep it" (`answers.copiedList: "rule"`), so it scores verified.
//   small-vocabulary       (Hebrew output) a status translation of 4 entries, each on many rows: vocabulary, saved silently.
//   ledger-account-labels  (English) expense types -> 8-digit ledger accounts written as labels: a vocabulary of 8 entries, and no 8-digit
//                          code is an identifier (no digit-run rule) - silent.
//   label-is-an-id         (English) a logic rule whose LABEL is personal data: amount > 1000 -> a fixed Israeli ID number. Logic, not a
//                          list - but the identifier finding fires at Save; the case answers "Keep it" (`answers.identifier: "keep"`).
//
// DECISIONS:
//   - Every case has a next-month pair from the same reference rules: the catalog's next month uses only products of the example (a new
//     product is flagged at run time, never guessed - that is a lookup's contract, not this case's subject); the ID label's cut-off is pinned
//     in the example by 990 / 1010 and the next month has no value between them.
//   - No value here is a real person's: the ID number is a valid check digit on made-up digits, the names are the eval's usual pools.
import type { Expr, LearnResult } from '@formatai/shared';
import { mkRules, runConvert, type CaseSpec, type FileArtifact } from './lib/caseKit';
import { padNum, writeFixture, type Cell, type RowSpec } from './lib/fixtures';
import { makeRng, pick, randInt, shuffle, type Rng } from './lib/prng';

const hdr = (cells: string[]): RowSpec => ({ cells });
const rows = (data: Cell[][]): RowSpec[] => data.map((cells) => ({ cells }));

async function toArtifact(spec: Parameters<typeof writeFixture>[0]): Promise<FileArtifact> {
  return { ext: spec.file?.type ?? 'xlsx', bytes: await writeFixture(spec) };
}

async function convertedArtifact(rules: ReturnType<typeof mkRules>, input: FileArtifact): Promise<FileArtifact> {
  return { ext: rules.output.file?.type ?? 'xlsx', bytes: await runConvert(rules, input.bytes, `input.${input.ext}`) };
}

const col = (id: string): Expr => ({ col: id });
const text = (value: string): Expr => ({ const: value });
const lookupBy = (table: string, key: string, ret: string): Expr => ({ op: 'lookup', table, key: col(key), return: ret, onMissing: 'flag' });

function check(label: string, ok: boolean, what: string): void {
  if (!ok) throw new Error(`${label}: ${what}`);
}

// ===========================================================================
// catalog-200: product code -> category, 200 entries over 400 rows
// ===========================================================================

const CATEGORIES = ['Electronics', 'Garden', 'Kitchen', 'Toys', 'Books', 'Sports', 'Office', 'Clothing'];

/** The catalog: 200 product codes, each with a category drawn at random (no rule from the code: neighbouring codes differ). */
function genCatalog(rng: Rng): { code: string; category: string }[] {
  return Array.from({ length: 200 }, (_, i) => ({ code: `PRD-${padNum(1001 + i, 4)}`, category: pick(rng, CATEGORIES) }));
}

async function buildCatalog200(): Promise<CaseSpec> {
  const rng = makeRng('catalog-200');
  const catalog = genCatalog(rng);
  // A category no code range explains: every run of 5 consecutive codes holds at least 2 categories.
  for (let i = 0; i + 5 <= catalog.length; i += 5) check('catalog-200', new Set(catalog.slice(i, i + 5).map((p) => p.category)).size >= 2, `codes ${i}..${i + 4} share one category`);
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'text', required: true },
        { id: 'product', header: 'Product code', type: 'text', required: true },
        { id: 'qty', header: 'Qty', type: 'integer' },
      ],
    },
    transform: {
      computed: [{ id: 'category', type: 'text', expr: lookupBy('catalog', 'product', 'category') }],
      valueMaps: [],
      sort: [],
      tables: [{ name: 'catalog', columns: ['product', 'category'], rows: catalog.map((p) => [p.code, p.category]) }],
    },
    output: {
      sheetName: 'Orders',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Order', from: 'order' },
        { header: 'Product code', from: 'product' },
        { header: 'Category', from: 'category' },
        { header: 'Qty', from: 'qty' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Orders -> product category', rulesBody);
  const header = hdr(['Order', 'Product code', 'Qty']);
  // Every product twice, in a shuffled order: 400 rows.
  const orders = (r: Rng, codes: readonly string[], first: number): Cell[][] => codes.map((code, i) => [`ORD-${first + i}`, code, randInt(r, 1, 20)]);
  const exampleCodes = shuffle(rng, [...catalog, ...catalog].map((p) => p.code));
  const input = await toArtifact({ name: 'Orders', rows: [header, ...rows(orders(rng, exampleCodes, 50001))] });
  const output = await convertedArtifact(referenceRules, input);
  // Next month: 300 orders of products of the catalog (the example holds every one of them).
  const nextRng = makeRng('catalog-200-next');
  const nextCodes = Array.from({ length: 300 }, () => pick(nextRng, catalog).code);
  const nextInput = await toArtifact({ name: 'Orders', rows: [header, ...rows(orders(nextRng, nextCodes, 60001))] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'catalog-200',
    meta: {
      difficulty: 'stress',
      domain: 'productCatalog',
      features: ['savedContents', 'listOfFixedValues', 'lookupTable', 'repeatingKeys', 'askedAtSave'],
      expect: 'verified',
      expectNote:
        'Category is looked up by product code in a catalog of 200 products (each on 2 of the 400 rows); no code range or other column explains it. A list of fixed values (more than 12 entries): the learn sends ONE automatic round asking for the rule behind it ("Column \\"Category\\" is a list of 200 fixed values, one per Product code ..."), the honest answer keeps the lookup, and the list is asked about at Save ("Category is a list of 200 fixed values taken from your example (one for each Product code)"); this case answers "Keep it" (answers.copiedList), so it scores verified. May break: a rule invented from the code (a band on its digits, a prefix), or the list given up as unsupported.',
      answers: { copiedList: 'rule' },
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// small-vocabulary: a status translation of 4 entries (Hebrew output)
// ===========================================================================

const STATUSES = [
  { en: 'Open', he: 'פתוח' },
  { en: 'In progress', he: 'בטיפול' },
  { en: 'On hold', he: 'מושהה' },
  { en: 'Closed', he: 'סגור' },
];

async function buildSmallVocabulary(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'ticket', header: 'Ticket', type: 'text', required: true },
        { id: 'subject', header: 'Subject', type: 'text' },
        { id: 'status', header: 'Status', type: 'text', required: true },
      ],
    },
    transform: {
      computed: [],
      valueMaps: [{ column: 'status', map: Object.fromEntries(STATUSES.map((s) => [s.en, s.he])), onMissing: 'flag' }],
      sort: [],
    },
    output: {
      sheetName: 'קריאות',
      direction: 'rtl',
      language: 'he',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'מספר קריאה', from: 'ticket' },
        { header: 'נושא', from: 'subject' },
        { header: 'סטטוס', from: 'status' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Tickets -> Hebrew status', rulesBody);
  const SUBJECTS = ['Login fails', 'Printer offline', 'New laptop', 'Password reset', 'VPN slow', 'Email bounce', 'Screen flicker', 'Access request'];
  const gen = (r: Rng, n: number, first: number): Cell[][] => {
    // Every status at least 3 times: a status per row in turn, then shuffled.
    const statuses = shuffle(r, Array.from({ length: n }, (_, i) => STATUSES[i % STATUSES.length]!.en));
    return statuses.map((s, i) => [`TCK-${first + i}`, pick(r, SUBJECTS), s]);
  };
  const header = hdr(['Ticket', 'Subject', 'Status']);
  const rng = makeRng('small-vocabulary');
  const input = await toArtifact({ name: 'Tickets', rows: [header, ...rows(gen(rng, 40, 7001))] });
  const output = await convertedArtifact(referenceRules, input);
  const nextRng = makeRng('small-vocabulary-next');
  const nextInput = await toArtifact({ name: 'Tickets', rows: [header, ...rows(gen(nextRng, 30, 8001))] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'small-vocabulary',
    meta: {
      difficulty: 'stress',
      domain: 'helpdeskTickets',
      features: ['savedContents', 'smallVocabulary', 'valueMap', 'hebrewOutput', 'silentSave'],
      expect: 'verified',
      expectNote:
        'Status is translated to Hebrew: 4 values, each on 10 of the 40 rows - a small vocabulary (at most 12 entries, each on 2 rows or more, keyed on a column that is no identifier). Saved silently: no automatic round for it, nothing asked at Save. May break: a list round or a Save question for a plain translation, or a value map that misses a status.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// ledger-account-labels: expense types -> 8-digit ledger accounts as labels
// ===========================================================================

const LEDGER = [
  { type: 'Travel', account: '61000100' },
  { type: 'Meals', account: '61000200' },
  { type: 'Office supplies', account: '61500100' },
  { type: 'Software', account: '62000300' },
  { type: 'Rent', account: '63000100' },
  { type: 'Utilities', account: '63000200' },
  { type: 'Training', account: '64000100' },
  { type: 'Fuel', account: '65000400' },
];

async function buildLedgerAccountLabels(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'expense', header: 'Expense', type: 'text', required: true },
        { id: 'type', header: 'Expense type', type: 'text', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: {
      computed: [{ id: 'account', type: 'text', expr: lookupBy('ledger', 'type', 'account') }],
      valueMaps: [],
      sort: [],
      tables: [{ name: 'ledger', columns: ['type', 'account'], rows: LEDGER.map((l) => [l.type, l.account]) }],
    },
    output: {
      sheetName: 'Journal',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Expense', from: 'expense' },
        { header: 'Expense type', from: 'type' },
        { header: 'Ledger account', from: 'account' },
        { header: 'Amount', from: 'amount' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Expenses -> ledger accounts', rulesBody);
  // (no 8-digit code is an identifier shape: not 9 digits, no leading zero for a phone, too short for a card)
  for (const l of LEDGER) check('ledger-account-labels', /^[1-9]\d{7}$/.test(l.account), `${l.account} is not an 8-digit code`);
  const gen = (r: Rng, n: number, first: number): Cell[][] => {
    const types = shuffle(r, Array.from({ length: n }, (_, i) => LEDGER[i % LEDGER.length]!.type));
    return types.map((t, i) => [`EXP-${first + i}`, t, randInt(r, 1_000, 250_000) / 100]);
  };
  const header = hdr(['Expense', 'Expense type', 'Amount']);
  const rng = makeRng('ledger-account-labels');
  const input = await toArtifact({ name: 'Expenses', rows: [header, ...rows(gen(rng, 48, 3001))] });
  const output = await convertedArtifact(referenceRules, input);
  const nextRng = makeRng('ledger-account-labels-next');
  const nextInput = await toArtifact({ name: 'Expenses', rows: [header, ...rows(gen(nextRng, 40, 4001))] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'ledger-account-labels',
    meta: {
      difficulty: 'stress',
      domain: 'bookkeeping',
      features: ['savedContents', 'smallVocabulary', 'lookupTable', 'ledgerAccounts', 'noDigitRunRule', 'silentSave'],
      expect: 'verified',
      expectNote:
        'Each expense type has its ledger account, written as an 8-digit label (61000100 ...): 8 types, each on 6 of the 48 rows - a small vocabulary, and no 8-digit code has an identifier\'s shape (the owner\'s decision: no digit-run rule; only an ID with its check digit, a phone, an email, a card or an IBAN count). Saved silently: no automatic round, nothing asked at Save. May break: a Save question about the accounts, or a rule that reads the amount.',
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

// ===========================================================================
// label-is-an-id: amount > 1000 -> a fixed Israeli ID number as the label
// ===========================================================================

/** A valid Israeli ID (its check digit holds), made up: 0-3-9-3-3-7-4-2-3. */
const TARGET_ID = '039337423';

async function buildLabelIsAnId(): Promise<CaseSpec> {
  const rulesBody: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'text', required: true },
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
      ],
    },
    transform: {
      computed: [{ id: 'target', type: 'text', expr: { op: 'if', cond: { op: 'gt', args: [col('amount'), { const: 1000 }] }, then: text(TARGET_ID), else: text('') } }],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Orders',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      headerStyle: { bold: true },
      columns: [
        { header: 'Order', from: 'order' },
        { header: 'Customer', from: 'customer' },
        { header: 'Amount', from: 'amount' },
        { header: 'Target customer', from: 'target' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const referenceRules = mkRules('Orders -> target customer', rulesBody);
  const CUSTOMERS = ['Acme Corp', 'Globex', 'Initech', 'Umbrella Ltd', 'Hooli', 'Stark Supply', 'Wayne Tools', 'Wonka Foods'];
  /** Amounts away from the cut-off (never within 15 of 1000), with `pinned` ones added (990 / 1010 in the example). */
  const gen = (r: Rng, n: number, first: number, pinned: number[]): Cell[][] => {
    const amounts: number[] = [...pinned];
    while (amounts.length < n) {
      const cents = randInt(r, 5_000, 300_000);
      if (Math.abs(cents - 100_000) > 1_500) amounts.push(cents / 100);
    }
    return shuffle(r, amounts).map((a, i) => [`SO-${first + i}`, pick(r, CUSTOMERS), a]);
  };
  const header = hdr(['Order', 'Customer', 'Amount']);
  const rng = makeRng('label-is-an-id');
  const example = gen(rng, 40, 20001, [990, 1010]);
  const values = example.map((r) => r[2] as number);
  check('label-is-an-id', Math.max(...values.filter((v) => v <= 1000)) === 990 && Math.min(...values.filter((v) => v > 1000)) === 1010, 'the gap around 1000 is not 990 | 1010');
  check('label-is-an-id', values.filter((v) => v > 1000).length >= 10 && values.filter((v) => v <= 1000).length >= 6, 'too few rows on a side of the cut-off');
  const input = await toArtifact({ name: 'Orders', rows: [header, ...rows(example)] });
  const output = await convertedArtifact(referenceRules, input);
  const nextRng = makeRng('label-is-an-id-next');
  const next = gen(nextRng, 30, 30001, [980, 1020]);
  check('label-is-an-id', !next.some((r) => (r[2] as number) > 990 && (r[2] as number) < 1010), 'next month has a value inside the gap');
  const nextInput = await toArtifact({ name: 'Orders', rows: [header, ...rows(next)] });
  const nextOutput = await convertedArtifact(referenceRules, nextInput);

  return {
    name: 'label-is-an-id',
    meta: {
      difficulty: 'stress',
      domain: 'salesOrders',
      features: ['savedContents', 'identifierLabel', 'threshold', 'askedAtSave'],
      expect: 'verified',
      expectNote:
        'Target customer is a fixed ID number on every order above 1000, empty below (the cut-off pinned by 990 | 1010). Logic, not a list - so no automatic round - but its label is an identifier: a saved format would keep an ID number, so the Save popup asks ("Target customer keeps an ID number in its rules"); this case answers "Keep it" (answers.identifier), so it scores verified. With masking on, the ID is sent as a look-alike valid ID and unmasked in the rules. May break: a list of amounts instead of the threshold, or the label not found under masking.',
      answers: { identifier: 'keep' },
    },
    input,
    output,
    next: { input: nextInput, output: nextOutput },
    referenceRules,
  };
}

export const contentsCaseBuilders: (() => Promise<CaseSpec>)[] = [buildCatalog200, buildSmallVocabulary, buildLedgerAccountLabels, buildLabelIsAnId];
